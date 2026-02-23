const express = require("express");

function createJobsLifecycleCoreRouter({
  authenticateToken,
  Job,
  WorkerModel,
  User,
  NotificationHistory,
  logJobEvent,
  updateGigDataOnAcceptance,
  updateGigDataOnCancellation,
  emitJobUpdatedToUsers,
  pendingJobTimeouts,
  pendingJobExpirations,
  trackingJobs,
  offerJobToNextWorker,
}) {
  const router = express.Router();

  router.post("/jobs/accept/:id", authenticateToken, async (req, res) => {
    try {
      const jobId = req.params.id;
      const workerName = req.user.name;
      const workerPhone = req.user.phone;

      const hasUnpaidJob = await Job.findOne({
        $or: [
          { acceptedBy: workerPhone, paymentStatus: { $ne: "Paid" } },
          { "acceptedWorkers.phone": workerPhone, paymentStatus: { $ne: "Paid" } },
        ],
      });

      if (hasUnpaidJob) {
        return res.status(400).json({
          success: false,
          message: `You have an unpaid job (${hasUnpaidJob.title}). Complete or decline it first.`,
        });
      }

      let acceptedWorkerSnapshot = null;
      try {
        const workerRecord = await WorkerModel.findOne({ phone: req.user.phone });
        const userRecord = await User.findOne({ phone: req.user.phone });

        acceptedWorkerSnapshot = {
          id: workerRecord?._id?.toString() || null,
          name: req.user.name || req.user.phone,
          phone: req.user.phone,
          skills: workerRecord?.skills || [],
          profilePhoto: userRecord?.profilePhoto || null,
          location: workerRecord?.location || null,
          acceptedAt: new Date(),
        };
      } catch (e) {
        console.error("Error fetching worker record for accept snapshot:", e);
      }

      const job = await Job.findById(jobId);
      if (!job) {
        return res.status(404).json({ success: false, message: "Job not found" });
      }

      const hasUnpaidJobSingle = await Job.findOne({ acceptedBy: workerPhone, paymentStatus: { $ne: "Paid" } });
      const hasUnpaidJobBulk = await Job.findOne({ "acceptedWorkers.phone": workerPhone, paymentStatus: { $ne: "Paid" } });
      if (hasUnpaidJobSingle || hasUnpaidJobBulk) {
        return res.status(400).json({ success: false, message: "You have an unpaid job. Complete or decline it first." });
      }

      if (job.bulkHiring) {
        const updated = await Job.findOneAndUpdate(
          {
            _id: jobId,
            bulkHiring: true,
            "acceptedWorkers.phone": { $ne: workerPhone },
          },
          {
            $addToSet: { acceptedWorkers: acceptedWorkerSnapshot },
          },
          { new: true }
        );

        if (!updated) {
          const checkJob = await Job.findById(jobId);
          if (checkJob && checkJob.acceptedWorkers?.find((w) => w.phone === workerPhone)) {
            return res.status(400).json({ success: false, message: "You have already accepted this job" });
          }
          return res.status(400).json({ success: false, message: "Could not accept job" });
        }

        const bulkJob = updated;
        await logJobEvent({
          jobId: bulkJob._id,
          eventType: "job_accepted",
          actorType: "worker",
          actorPhone: workerPhone,
          source: "app",
          oldState: { status: bulkJob.status },
          newState: { status: bulkJob.status },
          metadata: { bulkHiring: true, acceptedCount: bulkJob.acceptedWorkers?.length || 0, requiredWorkers: bulkJob.requiredWorkers || 1 },
        });

        try {
          await updateGigDataOnAcceptance(workerPhone, {
            jobId: bulkJob._id.toString(),
            title: bulkJob.title,
            amount: bulkJob.amount,
            workerType: bulkJob.workerType,
          });
        } catch (e) {
          console.error("Error updating gigs data on acceptance:", e);
        }

        const acceptedCount = bulkJob.acceptedWorkers?.length || 0;
        const requiredCount = bulkJob.requiredWorkers || 1;
        const jobFinalized = acceptedCount >= requiredCount && bulkJob.status !== "accepted";

        if (jobFinalized) {
          const finalized = await Job.findOneAndUpdate(
            { _id: jobId, status: { $ne: "accepted" } },
            {
              $set: {
                status: "accepted",
                acceptedBy: bulkJob.acceptedWorkers[0]?.phone || workerPhone,
                acceptedWorker: bulkJob.acceptedWorkers[0] || acceptedWorkerSnapshot,
                acceptedAt: bulkJob.acceptedAt || new Date(),
              },
            },
            { new: true }
          );
          if (finalized) {
            await logJobEvent({
              jobId: finalized._id,
              eventType: "job_accepted",
              actorType: "system",
              actorPhone: workerPhone,
              source: "app",
              oldState: { status: bulkJob.status },
              newState: { status: finalized.status, acceptedBy: finalized.acceptedBy },
              metadata: { bulkHiring: true, finalized: true, acceptedCount, requiredCount },
            });
            if (pendingJobTimeouts.has(jobId)) {
              clearTimeout(pendingJobTimeouts.get(jobId));
              pendingJobTimeouts.delete(jobId);
            }
            if (pendingJobExpirations.has(jobId)) {
              clearTimeout(pendingJobExpirations.get(jobId));
              pendingJobExpirations.delete(jobId);
            }
          }
        }

        try {
          await NotificationHistory.create({
            recipientPhone: bulkJob.contractorPhone,
            senderPhone: req.user.phone,
            senderName: workerName || req.user.name,
            type: "job_accepted",
            title: `Worker Accepted: ${bulkJob.title}`,
            body: `${workerName} accepted your job. ${acceptedCount}/${requiredCount} accepted.`,
            jobId: bulkJob._id.toString(),
            metadata: { acceptedCount, requiredWorkers: requiredCount },
            deepLink: `contractor/jobs/${bulkJob._id.toString()}`,
            pushNotificationSent: false,
          });
        } catch (e) {
          console.error("Error creating job acceptance notification for contractor:", e);
        }

        const payload = { ...bulkJob.toObject(), _targetedUpdate: true, targetedFor: [bulkJob.contractorName] };
        await emitJobUpdatedToUsers(payload, [bulkJob.contractorName]);

        return res.json({ success: true, message: "Job accepted successfully", job: bulkJob });
      }

      const updated = await Job.findOneAndUpdate(
        { _id: jobId, status: "pending" },
        { $set: { status: "accepted", acceptedBy: workerPhone, acceptedWorker: acceptedWorkerSnapshot, acceptedAt: new Date() } },
        { new: true }
      );

      if (!updated) {
        return res.status(400).json({ success: false, message: "Job already accepted or not found" });
      }

      await logJobEvent({
        jobId: updated._id,
        eventType: "job_accepted",
        actorType: "worker",
        actorPhone: workerPhone,
        source: "app",
        oldState: { status: "pending" },
        newState: { status: updated.status, acceptedBy: updated.acceptedBy },
        metadata: { bulkHiring: false },
      });

      try {
        await updateGigDataOnAcceptance(workerPhone, {
          jobId: updated._id.toString(),
          title: updated.title,
          amount: updated.amount,
          workerType: updated.workerType,
        });
      } catch (e) {
        console.error("Error updating gigs data on acceptance:", e);
      }

      try {
        await NotificationHistory.create({
          recipientPhone: updated.contractorPhone,
          senderPhone: req.user.phone,
          senderName: workerName || req.user.name,
          type: "job_accepted",
          title: `Job Accepted: ${updated.title}`,
          body: `${workerName} accepted your ₹${updated.amount} job`,
          jobId: updated._id.toString(),
          metadata: { jobTitle: updated.title, amount: updated.amount, actionRequired: true },
          deepLink: `contractor/jobs/${updated._id.toString()}`,
          pushNotificationSent: false,
        });
      } catch (e) {
        console.error("Error creating job acceptance notification for contractor:", e);
      }

      try {
        if (updated.acceptedWorker && updated.acceptedWorker.phone) {
          await NotificationHistory.create({
            recipientPhone: updated.acceptedWorker.phone,
            senderPhone: updated.contractorPhone,
            senderName: updated.contractorName || "Contractor",
            type: "job_accepted",
            title: `Job Confirmed: ${updated.title}`,
            body: `You accepted a ₹${updated.amount} job. You have ₹${updated.amount} in pending payment.`,
            jobId: updated._id.toString(),
            metadata: { jobTitle: updated.title, amount: updated.amount, actionRequired: true },
            deepLink: `worker/jobs/${updated._id.toString()}`,
            pushNotificationSent: false,
          });
        }
      } catch (e) {
        console.error("Error creating job acceptance notification for worker:", e);
      }

      const acceptPayload = {
        ...updated.toObject(),
        _targetedUpdate: true,
        targetedFor: [updated.contractorName, workerName],
      };
      await emitJobUpdatedToUsers(acceptPayload, [updated.contractorName, workerName]);

      if (pendingJobTimeouts.has(jobId)) {
        clearTimeout(pendingJobTimeouts.get(jobId));
        pendingJobTimeouts.delete(jobId);
      }
      if (pendingJobExpirations.has(jobId)) {
        clearTimeout(pendingJobExpirations.get(jobId));
        pendingJobExpirations.delete(jobId);
      }

      try {
        const TRACK_MINUTES = Number(process.env.TRACK_MINUTES) || 10;
        trackingJobs.set(jobId, Date.now() + TRACK_MINUTES * 40 * 1000);
      } catch (e) {
        console.error("Error starting tracking for job", e);
      }
      return res.json({ success: true, message: "Job accepted successfully", job: updated });
    } catch (err) {
      console.error("Accept error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/jobs/decline/:id", authenticateToken, async (req, res) => {
    try {
      const jobId = req.params.id;
      const workerName = req.user.name;
      const workerPhone = req.user.phone;

      const job = await Job.findById(jobId);
      if (!job) {
        return res.status(404).json({ success: false, message: "Job not found" });
      }

      if (!job.declinedBy.includes(workerName)) {
        job.declinedBy.push(workerName);
      }

      if (job.bulkHiring) {
        const before = job.acceptedWorkers ? job.acceptedWorkers.length : 0;
        job.acceptedWorkers = (job.acceptedWorkers || []).filter((w) => w.phone !== workerPhone);
        const after = job.acceptedWorkers.length;

        if (after < before) {
          if (job.status === "accepted" && after < (job.requiredWorkers || 1)) {
            job.status = "pending";
            job.acceptedBy = null;
            job.acceptedWorker = null;
            job.acceptedAt = null;
            if (trackingJobs.has(jobId)) trackingJobs.delete(jobId);
          }

          try {
            await updateGigDataOnCancellation(workerPhone, {
              jobId: job._id.toString(),
              title: job.title,
              amount: job.amount,
              workerType: job.workerType,
            });
          } catch (e) {
            console.error("Error updating gigs data on cancellation:", e);
          }
          try {
            const worker = await WorkerModel.findOne({ phone: workerPhone });
            if (worker && typeof worker.recordWork === "function") {
              worker.recordWork(new Date(), 0, true);
              await worker.save();
            }
          } catch (recErr) {
            console.error("Error recording work cancellation on decline:", recErr);
          }
        }
      } else if (job.acceptedBy === workerPhone && job.status === "accepted") {
        job.status = "pending";
        job.acceptedBy = null;
        job.acceptedWorker = null;
        job.acceptedAt = null;
        if (trackingJobs.has(jobId)) {
          trackingJobs.delete(jobId);
        }

        try {
          await updateGigDataOnCancellation(workerPhone, {
            jobId: job._id.toString(),
            title: job.title,
            amount: job.amount,
            workerType: job.workerType,
          });
        } catch (e) {
          console.error("Error updating gigs data on cancellation:", e);
        }
        try {
          const worker = await WorkerModel.findOne({ phone: workerPhone });
          if (worker && typeof worker.recordWork === "function") {
            worker.recordWork(new Date(), 0, true);
            await worker.save();
          }
        } catch (recErr) {
          console.error("Error recording work cancellation on decline (single):", recErr);
        }
      }

      await job.save();
      await logJobEvent({
        jobId: job._id,
        eventType: "job_rejected",
        actorType: "worker",
        actorPhone: workerPhone,
        source: "app",
        oldState: { status: job.status },
        newState: { status: job.status },
        reasonCode: "worker_declined",
        reasonText: "Worker declined job offer",
        metadata: { declinedBy: workerName, bulkHiring: !!job.bulkHiring },
      });

      await emitJobUpdatedToUsers(job, [job.contractorName, workerName]);

      if (job.status === "pending") {
        try {
          await offerJobToNextWorker(job);
        } catch (e) {
          console.error("Error offering to next worker after decline:", e);
        }
      }

      return res.json({ success: true, message: "Job declined successfully", job });
    } catch (err) {
      console.error("Decline error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createJobsLifecycleCoreRouter,
};

