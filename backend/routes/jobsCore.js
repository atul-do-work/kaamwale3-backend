const express = require("express");
const path = require("path");
const { scheduleDispatchState, cancelDispatchState } = require("../services/dispatchStateService");
const { isPremiumEntitled } = require("../utils/premiumEntitlement");
const { getPlanEntitlements } = require("../config/premiumEntitlements");

function getIdempotencyKey(req) {
  const fromHeader = (req.headers["x-idempotency-key"] || "").toString().trim();
  const fromBody = (req.body?.idempotencyKey || "").toString().trim();
  return fromHeader || fromBody || null;
}

function createJobsCoreRouter({
  authenticateToken,
  fileUpload,
  getPublicBaseUrl,
  Wallet,
  Job,
  User,
  io,
  logJobEvent,
  pendingJobTimeouts,
  pendingJobExpirations,
  updateContractorStats,
  offerJobToNextWorker,
  emitJobCancelledToUsers,
}) {
  const router = express.Router();

  router.post("/jobs/upload-image", authenticateToken, fileUpload(), async (req, res) => {
    try {
      if (!req.files || !req.files.photo) {
        return res.status(400).json({ success: false, message: "No image provided" });
      }

      const file = req.files.photo;
      const filename = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`;
      const uploadPath = path.join(__dirname, "..", "uploads", filename);
      await file.mv(uploadPath);

      const serverURL = getPublicBaseUrl(req);
      const imageUrl = `${serverURL}/uploads/${filename}`;
      return res.json({ success: true, imageUrl });
    } catch (err) {
      console.error("Job image upload error:", err);
      return res.status(500).json({ success: false, message: "Failed to upload job image" });
    }
  });

  router.post("/jobs/post", authenticateToken, async (req, res) => {
    try {
      const { title, description, workerType, amount, lat, lon, date, imageUrl, startTime, endTime, bulkHiring, requiredWorkers, numberOfDays } = req.body;
      const idempotencyKey = getIdempotencyKey(req);
      const walletIdempotencyKey = idempotencyKey ? `${req.user.phone}:${idempotencyKey}` : null;

      if (!title || !lat || !lon || lat === 0 || lon === 0) {
        return res.status(400).json({ success: false, message: "Missing required fields: title, lat, lon must be provided and non-zero" });
      }

      if (idempotencyKey) {
        const existingJob = await Job.findOne({ contractorPhone: req.user.phone, idempotencyKey }).sort({ createdAt: -1 });
        if (existingJob) {
          let currentWallet = await Wallet.findOne({ phone: req.user.phone });
          if (!currentWallet) {
            currentWallet = new Wallet({ phone: req.user.phone, balance: 0, availableBalance: 0, pocketBalance: 0 });
            await currentWallet.save();
          }
          return res.json({
            success: true,
            idempotent: true,
            message: "Job post already processed for this idempotency key",
            job: existingJob,
            wallet: currentWallet,
          });
        }
      }

      const userRecord = await User.findOne({ phone: req.user.phone }).select("premiumPlan");
      if (!userRecord) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const wantsBulkHiring = bulkHiring === true || bulkHiring === "true";
      const requestedDays = Number.parseInt(numberOfDays, 10);
      const normalizedDays = Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : 1;
      const hasActivePremium = isPremiumEntitled(userRecord);
      const entitlements = getPlanEntitlements(userRecord?.premiumPlan?.type || "free");

      const canBulkHire = hasActivePremium && Boolean(entitlements.canBulkHire);
      const canMultiDayPost = hasActivePremium && Boolean(entitlements.canMultiDayPost);
      if ((wantsBulkHiring && !canBulkHire) || (normalizedDays > 1 && !canMultiDayPost)) {
        return res.status(403).json({
          success: false,
          message: "Selected plan does not include bulk hiring or multi-day jobs.",
        });
      }

      let wallet = await Wallet.findOne({ phone: req.user.phone });
      if (!wallet) {
        wallet = new Wallet({ phone: req.user.phone, balance: 0, availableBalance: 0, pocketBalance: 0 });
        await wallet.save();
      }

      const workersCount = wantsBulkHiring ? (parseInt(requiredWorkers) || 1) : 1;
      const requiredBalance = workersCount * 25;
      const isContractor = String(req.user?.role || "").toLowerCase() === "contractor";
      const pocketBalance = Number(wallet.pocketBalance || 0);
      const legacyBalance = Number(wallet.balance || 0);
      const spendableBalance = isContractor ? pocketBalance : legacyBalance;

      const walletQuery = isContractor
        ? { phone: req.user.phone, pocketBalance: { $gte: requiredBalance } }
        : { phone: req.user.phone, balance: { $gte: requiredBalance } };
      if (walletIdempotencyKey) {
        walletQuery["transactions.idempotencyKey"] = { $ne: walletIdempotencyKey };
      }

      const chargedWallet = await Wallet.findOneAndUpdate(
        walletQuery,
        {
          $inc: isContractor ? { pocketBalance: -requiredBalance } : { balance: -requiredBalance },
          $push: {
            transactions: {
              type: "job_post_fee",
              amount: requiredBalance,
              workersCount,
              idempotencyKey: walletIdempotencyKey || undefined,
              date: new Date(),
              metadata: { deductedFrom: isContractor ? "pocketBalance" : "balance" },
            },
          },
        },
        { new: true }
      );

      if (!chargedWallet) {
        return res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. You need ₹${requiredBalance} to post this job for ${workersCount} worker(s). Current balance: ₹${spendableBalance}`,
        });
      }

      const newJob = new Job({
        title,
        description,
        workerType,
        amount,
        contractorName: req.user.name,
        contractorPhone: req.user.phone,
        imageUrl: imageUrl || null,
        lat,
        lon,
        date: date || new Date(),
        startTime: startTime || null,
        endTime: endTime || null,
        numberOfDays: normalizedDays,
        bulkHiring: wantsBulkHiring || false,
        requiredWorkers: parseInt(requiredWorkers) || 1,
        idempotencyKey: idempotencyKey || undefined,
        status: "pending",
        declinedBy: [],
        offerExpiresAt: new Date(Date.now() + 60 * 1000),
      });
      await newJob.save();

      await logJobEvent({
        jobId: newJob._id,
        eventType: "job_posted",
        actorType: "contractor",
        actorPhone: req.user.phone,
        source: "app",
        newState: { status: newJob.status, paymentStatus: newJob.paymentStatus },
        metadata: { title: newJob.title, amount: newJob.amount, bulkHiring: !!newJob.bulkHiring, idempotencyKey: idempotencyKey || null },
      });

      try {
        const EXPIRE_MS = (process.env.JOB_EXPIRE_MINUTES ? Number(process.env.JOB_EXPIRE_MINUTES) : 30) * 60 * 1000;
        if (pendingJobExpirations.has(newJob._id.toString())) {
          clearTimeout(pendingJobExpirations.get(newJob._id.toString()));
          pendingJobExpirations.delete(newJob._id.toString());
        }
        const expireId = setTimeout(async () => {
          try {
            const jobCheck = await Job.findById(newJob._id);
            if (!jobCheck) return;
            const acceptedCount = jobCheck.bulkHiring ? (jobCheck.acceptedWorkers?.length || 0) : (jobCheck.acceptedBy ? 1 : 0);
            if (jobCheck.status === "pending" && acceptedCount === 0) {
              const oldState = { status: jobCheck.status, paymentStatus: jobCheck.paymentStatus };
              jobCheck.status = "expired";
              await jobCheck.save();
              await logJobEvent({
                jobId: jobCheck._id,
                eventType: "job_expired",
                actorType: "system",
                source: "system",
                oldState,
                newState: { status: jobCheck.status, paymentStatus: jobCheck.paymentStatus },
              });
              const payload = {
                ...jobCheck.toObject(),
                _id: jobCheck._id.toString(),
                id: jobCheck._id.toString(),
                status: "expired",
                expiredAt: new Date(),
              };
              const targetUsers = [
                jobCheck.contractorPhone,
                jobCheck.contractorName,
                jobCheck.acceptedBy,
                ...(Array.isArray(jobCheck.acceptedWorkers) ? jobCheck.acceptedWorkers.map((w) => w?.phone).filter(Boolean) : []),
              ];
              if (typeof emitJobCancelledToUsers === "function") {
                await emitJobCancelledToUsers(payload, targetUsers);
              } else {
                io.emit("jobCancelled", payload);
              }
              if (pendingJobTimeouts.has(jobCheck._id.toString())) {
                clearTimeout(pendingJobTimeouts.get(jobCheck._id.toString()));
                pendingJobTimeouts.delete(jobCheck._id.toString());
              }
              pendingJobExpirations.delete(jobCheck._id.toString());
              await cancelDispatchState({ jobId: jobCheck._id, reason: "expired_http_post" });
            }
          } catch (e) {
            console.error("Error expiring HTTP posted job:", e);
          }
        }, EXPIRE_MS);
        pendingJobExpirations.set(newJob._id.toString(), expireId);
        await scheduleDispatchState({
          jobId: newJob._id,
          type: "expire_offer",
          runAt: new Date(Date.now() + EXPIRE_MS),
          metadata: { source: "http_post" },
        });
      } catch (e) {
        console.error("Error scheduling HTTP job expiry:", e);
      }

      try {
        await User.findByIdAndUpdate(req.user.id, {
          latitude: lat,
          longitude: lon,
          locationLastUpdated: new Date(),
        });
      } catch (err) {
        console.warn("Warning: Could not update contractor location:", err.message);
      }

      await updateContractorStats(req.user.phone);

      try {
        await offerJobToNextWorker(newJob);
      } catch (e) {
        console.error("Error offering job after HTTP post:", e);
      }

      return res.json({
        success: true,
        job: newJob,
        wallet: chargedWallet,
        message: "Job posted. Searching for nearby workers...",
      });
    } catch (err) {
      if (err && err.code === 11000 && err.keyPattern && err.keyPattern.contractorPhone && err.keyPattern.idempotencyKey) {
        const existingJob = await Job.findOne({ contractorPhone: req.user.phone, idempotencyKey: getIdempotencyKey(req) }).sort({ createdAt: -1 });
        const currentWallet = await Wallet.findOne({ phone: req.user.phone });
        return res.json({
          success: true,
          idempotent: true,
          message: "Job post already processed for this idempotency key",
          job: existingJob,
          wallet: currentWallet,
        });
      }
      console.error(err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createJobsCoreRouter,
};
