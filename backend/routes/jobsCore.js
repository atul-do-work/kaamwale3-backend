const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const fs = require("fs").promises;
const { scheduleDispatchState, cancelDispatchState } = require("../services/dispatchStateService");
const { isPremiumEntitled } = require("../utils/premiumEntitlement");
const { getPlanEntitlements } = require("../config/premiumEntitlements");
const { buildLogContext, info, error } = require("../utils/logContext");
const { uploadImageBufferToCloudinary } = require("../utils/cloudinaryUpload");
const MAX_IMAGE_SIZE_BYTES = Math.floor(1.5 * 1024 * 1024);

function getIdempotencyKey(req) {
  const fromHeader = (req.headers["x-idempotency-key"] || "").toString().trim();
  const fromBody = (req.body?.idempotencyKey || "").toString().trim();
  return fromHeader || fromBody || null;
}

function buildAutoIdempotencyKey({ phone, title, description, amount, lat, lon, date, numberOfDays, bulkHiring, requiredWorkers }) {
  // 30-second time bucket prevents accidental duplicate retries while allowing legitimate future reposts.
  const bucket = Math.floor(Date.now() / 30000);
  const payload = [
    String(phone || ""),
    String(title || "").trim().toLowerCase(),
    String(description || "").trim().toLowerCase(),
    String(amount || ""),
    String(lat || ""),
    String(lon || ""),
    String(date || ""),
    String(numberOfDays || "1"),
    String(Boolean(bulkHiring)),
    String(requiredWorkers || "1"),
    String(bucket),
  ].join("|");
  const digest = crypto.createHash("sha1").update(payload).digest("hex").slice(0, 20);
  return `auto:${digest}`;
}

function createJobsCoreRouter({
  authenticateToken,
  fileUpload,
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
      const fileSize = Number(file.size || 0);
      if (fileSize > MAX_IMAGE_SIZE_BYTES) {
        return res.status(400).json({
          success: false,
          message: "Image too large. Maximum size is 1.5MB",
        });
      }
      const mimeType = String(file.mimetype || "").toLowerCase();
      if (!mimeType.startsWith("image/")) {
        return res.status(400).json({ success: false, message: "Only image files are allowed" });
      }
      let imageBuffer = null;
      if (file.data && Buffer.isBuffer(file.data)) {
        imageBuffer = file.data;
      } else if (file.tempFilePath) {
        imageBuffer = await fs.readFile(file.tempFilePath);
      }
      if (!imageBuffer || !Buffer.isBuffer(imageBuffer) || imageBuffer.length === 0) {
        return res.status(400).json({ success: false, message: "Invalid image payload" });
      }

      const uploadResult = await uploadImageBufferToCloudinary({
        buffer: imageBuffer,
        mimeType: file.mimetype || "image/jpeg",
        folder: "kaamwale/jobs",
        publicId: `job-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      });
      const imageUrl = uploadResult.secure_url;
      return res.json({ success: true, imageUrl });
    } catch (err) {
      console.error("Job image upload error:", err);
      return res.status(500).json({ success: false, message: "Failed to upload job image" });
    }
  });

  router.post("/jobs/post", authenticateToken, async (req, res) => {
    try {
      const { title, description, workerType, amount, lat, lon, date, imageUrl, startTime, endTime, bulkHiring, requiredWorkers, numberOfDays } = req.body;
      const idempotencyKey =
        getIdempotencyKey(req) ||
        buildAutoIdempotencyKey({
          phone: req.user.phone,
          title,
          description,
          amount,
          lat,
          lon,
          date,
          numberOfDays,
          bulkHiring,
          requiredWorkers,
        });
      const walletIdempotencyKey = idempotencyKey ? `${req.user.phone}:${idempotencyKey}` : null;

      if (!title || !lat || !lon || lat === 0 || lon === 0) {
        return res.status(400).json({ success: false, message: "Missing required fields: title, lat, lon must be provided and non-zero" });
      }

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

      // Use MongoDB session for atomic wallet balance check and deduction
      const session = await mongoose.startSession();
      let chargedWallet = null;
      
      try {
        await session.withTransaction(async () => {
          // First, get the current wallet state
          const currentWallet = await Wallet.findOne(walletQuery).session(session);
          if (!currentWallet) {
            throw new Error('INSUFFICIENT_BALANCE');
          }

          // Double-check balance in transaction
          const currentBalance = isContractor ? currentWallet.pocketBalance : currentWallet.balance;
          if (currentBalance < requiredBalance) {
            throw new Error('INSUFFICIENT_BALANCE');
          }

          // Deduct the balance atomically
          const updateField = isContractor ? 'pocketBalance' : 'balance';
          chargedWallet = await Wallet.findOneAndUpdate(
            { _id: currentWallet._id },
            {
              $inc: { [updateField]: -requiredBalance },
              $push: {
                transactions: {
                  type: "job_post_fee",
                  amount: requiredBalance,
                  workersCount,
                  idempotencyKey: walletIdempotencyKey || undefined,
                  date: new Date(),
                  openingBalance: currentBalance,
                  closingBalance: currentBalance - requiredBalance,
                  source: 'app',
                  provider: 'internal',
                  metadata: { 
                    deductedFrom: updateField,
                    jobPosting: true,
                    requiredBalance,
                    workersCount
                  },
                },
              },
            },
            { new: true, session }
          );
        });
      } catch (error) {
        await session.endSession();
        if (error.message === 'INSUFFICIENT_BALANCE') {
          info("Insufficient wallet balance for job post", buildLogContext(req, {
            requiredBalance,
            workersCount,
            spendableBalance,
          }));
          return res.status(400).json({
            success: false,
            message: `Insufficient wallet balance. You need ₹${requiredBalance} to post this job for ${workersCount} worker(s). Current balance: ₹${spendableBalance}`,
          });
        }
        throw error;
      } finally {
        await session.endSession();
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
      info("Job posted", buildLogContext(req, {
        jobId: newJob._id?.toString(),
        amount: newJob.amount,
        idempotencyKey,
        bulkHiring: !!newJob.bulkHiring,
      }));

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
        error("Error offering job after HTTP post", buildLogContext(req, {
          jobId: newJob?._id?.toString(),
          error: e?.message || String(e),
        }));
      }

      return res.json({
        success: true,
        job: newJob,
        wallet: chargedWallet,
        message: "Job posted. Searching for nearby workers...",
      });
    } catch (err) {
      if (err && err.code === 11000 && err.keyPattern && err.keyPattern.contractorPhone && err.keyPattern.idempotencyKey) {
        const fallbackIdempotencyKey = getIdempotencyKey(req) ||
          buildAutoIdempotencyKey({
            phone: req.user.phone,
            title: req.body?.title,
            description: req.body?.description,
            amount: req.body?.amount,
            lat: req.body?.lat,
            lon: req.body?.lon,
            date: req.body?.date,
            numberOfDays: req.body?.numberOfDays,
            bulkHiring: req.body?.bulkHiring,
            requiredWorkers: req.body?.requiredWorkers,
          });
        const existingJob = await Job.findOne({ contractorPhone: req.user.phone, idempotencyKey: fallbackIdempotencyKey }).sort({ createdAt: -1 });
        const currentWallet = await Wallet.findOne({ phone: req.user.phone });
        return res.json({
          success: true,
          idempotent: true,
          message: "Job post already processed for this idempotency key",
          job: existingJob,
          wallet: currentWallet,
        });
      }
      error("jobs/post failed", buildLogContext(req, {
        idempotencyKey: getIdempotencyKey(req),
        error: err?.message || String(err),
      }));
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createJobsCoreRouter,
};
