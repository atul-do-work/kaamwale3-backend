const express = require("express");
const path = require("path");
const { scheduleDispatchState, cancelDispatchState } = require("../services/dispatchStateService");
const { isPremiumEntitled } = require("../utils/premiumEntitlement");

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

      if (!title || !lat || !lon || lat === 0 || lon === 0) {
        return res.status(400).json({ success: false, message: "Missing required fields: title, lat, lon must be provided and non-zero" });
      }

      const userRecord = await User.findOne({ phone: req.user.phone }).select("premiumPlan");
      if (!userRecord) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const wantsBulkHiring = bulkHiring === true || bulkHiring === "true";
      const requestedDays = Number.parseInt(numberOfDays, 10);
      const normalizedDays = Number.isFinite(requestedDays) && requestedDays > 0 ? requestedDays : 1;
      const hasActivePremium = isPremiumEntitled(userRecord);

      if ((wantsBulkHiring || normalizedDays > 1) && !hasActivePremium) {
        return res.status(403).json({
          success: false,
          message: "Active premium subscription required for bulk hiring or multi-day jobs.",
        });
      }

      let wallet = await Wallet.findOne({ phone: req.user.phone });
      if (!wallet) {
        wallet = new Wallet({ phone: req.user.phone });
        await wallet.save();
      }

      const workersCount = wantsBulkHiring ? (parseInt(requiredWorkers) || 1) : 1;
      const requiredBalance = workersCount * 25;

      if (wallet.balance < requiredBalance) {
        return res.status(400).json({
          success: false,
          message: `Insufficient wallet balance. You need ₹${requiredBalance} to post this job for ${workersCount} worker(s). Current balance: ₹${wallet.balance}`,
        });
      }

      wallet.balance -= requiredBalance;
      wallet.transactions.push({
        type: "job_post_fee",
        amount: requiredBalance,
        workersCount,
        date: new Date(),
      });
      await wallet.save();

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
        metadata: { title: newJob.title, amount: newJob.amount, bulkHiring: !!newJob.bulkHiring },
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
        wallet,
        message: "Job posted. Searching for nearby workers...",
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createJobsCoreRouter,
};
