const express = require("express");
const mongoose = require("mongoose");
const { normalizePhoneNumber } = require("../utils/dataNormalization");
const { createGigHistoryEvent } = require("../services/gigHistoryService");
const { cancelDispatchState } = require("../services/dispatchStateService");

function createJobsLifecycleCoreRouter({
  authenticateToken,
  Job,
  WorkerModel,
  User,
  NotificationHistory,
  logJobEvent,
  updateContractorStats,
  updateGigDataOnAcceptance,
  updateGigDataOnCancellation,
  emitJobUpdatedToUsers,
  pendingJobTimeouts,
  pendingJobExpirations,
  trackingJobs,
  offerJobToNextWorker,
}) {
  const router = express.Router();
  const declineInFlight = new Set();
  const declineResultCache = new Map();
  const DECLINE_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
  const acceptInFlight = new Set();
  const acceptResultCache = new Map();
  const ACCEPT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

  router.post("/jobs/accept/:id", authenticateToken, async (req, res) => {
    try {
      const jobId = req.params.id;
      const workerName = req.user.name;
      const workerPhone = normalizePhoneNumber(req.user.phone);
      const idempotencyKey =
        String(req.header("X-Idempotency-Key") || req.body?.idempotencyKey || "")
          .trim()
          .slice(0, 120);
      const acceptKey = idempotencyKey || `accept:${jobId}:${workerPhone}`;

      const now = Date.now();
      for (const [k, v] of acceptResultCache.entries()) {
        if (!v || now - v.at > ACCEPT_IDEMPOTENCY_TTL_MS) acceptResultCache.delete(k);
      }
      const finish = (statusCode, body, cache = true) => {
        acceptInFlight.delete(acceptKey);
        if (cache) acceptResultCache.set(acceptKey, { at: Date.now(), statusCode, body });
        return res.status(statusCode).json(body);
      };
      if (acceptResultCache.has(acceptKey)) {
        const cached = acceptResultCache.get(acceptKey);
        return res.status(cached.statusCode).json({ ...cached.body, idempotent: true });
      }
      if (acceptInFlight.has(acceptKey)) {
        return res.status(202).json({
          success: true,
          message: "Accept request already processing",
          idempotent: true,
        });
      }
      acceptInFlight.add(acceptKey);

      const hasUnpaidJob = await Job.findOne({
        $and: [
          {
            $or: [
              { acceptedBy: workerPhone, paymentStatus: { $ne: "paid" } },
              {
                acceptedWorkers: {
                  $elemMatch: {
                    phone: workerPhone,
                    paymentStatus: { $ne: "paid" },
                  },
                },
              },
            ],
          },
          { status: { $nin: ["cancelled", "expired", "completed"] } },
        ],
      });

      if (hasUnpaidJob) {
        return finish(400, {
          success: false,
          message: `You have an unpaid job (${hasUnpaidJob.title}). Complete or decline it first.`,
        }, false);
      }

      let acceptedWorkerSnapshot = null;
      try {
        const workerRecord = await WorkerModel.findOne({ phone: req.user.phone });
        const userRecord = await User.findOne({ phone: req.user.phone });

        acceptedWorkerSnapshot = {
          id: workerRecord?._id?.toString() || null,
          name: req.user.name || req.user.phone,
          phone: workerPhone,
          skills: workerRecord?.skills || [],
          profilePhoto: userRecord?.profilePhoto || null,
          location: workerRecord?.location || null,
          acceptedAt: new Date(),
          attendanceStatus: null,
          attendanceTime: null,
          paymentStatus: "pending",
          paymentMode: null,
          paymentTime: null,
        };
      } catch (e) {
        console.error("Error fetching worker record for accept snapshot:", e);
      }

      const job = await Job.findById(jobId);
      if (!job) {
        return finish(404, { success: false, message: "Job not found" }, false);
      }

      const normalizedWorkerPhone = workerPhone;
      const hasUnpaidJobSingle = await Job.findOne({
        acceptedBy: normalizedWorkerPhone,
        paymentStatus: { $ne: "paid" },
        status: { $nin: ["cancelled", "expired", "completed"] },
      });
      const hasUnpaidJobBulk = await Job.findOne({
        acceptedWorkers: {
          $elemMatch: {
            phone: workerPhone,
            paymentStatus: { $ne: "paid" },
          },
        },
        status: { $nin: ["cancelled", "expired", "completed"] },
      });
      if (hasUnpaidJobSingle || hasUnpaidJobBulk) {
        return finish(400, { success: false, message: "You have an unpaid job. Complete or decline it first." }, false);
      }

      if (job.bulkHiring) {
        const alreadyAccepted = (job.acceptedWorkers || []).find((w) => normalizePhoneNumber(w.phone) === normalizedWorkerPhone);
        if (alreadyAccepted) {
          return finish(200, { success: true, message: "Job already accepted by you", job, idempotent: true });
        }

        // Atomic slot claim for bulk jobs using MongoDB transactions
        const session = await mongoose.startSession();
        let updated = null;
        
        try {
          await session.withTransaction(async () => {
            // First, get the current job state
            const currentJob = await Job.findById(jobId).session(session);
            if (!currentJob || !currentJob.bulkHiring) {
              throw new Error('JOB_NOT_AVAILABLE');
            }
            
            // Check if worker already accepted
            const alreadyAccepted = (currentJob.acceptedWorkers || []).find((w) => w.phone === workerPhone);
            if (alreadyAccepted) {
              updated = currentJob;
              return;
            }
            
            // Check if slots are full
            const currentAcceptedCount = (currentJob.acceptedWorkers || []).length;
            const requiredWorkers = currentJob.requiredWorkers || 1;
            if (currentAcceptedCount >= requiredWorkers) {
              throw new Error('SLOTS_FULL');
            }
            
            // Check job status
            if (!["pending", "posted", "offered", "accepted"].includes(currentJob.status)) {
              throw new Error('JOB_NOT_AVAILABLE');
            }
            
            // Atomically add the worker
            updated = await Job.findOneAndUpdate(
              { _id: jobId },
              {
                $addToSet: { acceptedWorkers: acceptedWorkerSnapshot },
              },
              { new: true, session }
            );
          });
        } catch (error) {
          await session.endSession();
          if (error.message === 'SLOTS_FULL' || error.message === 'JOB_NOT_AVAILABLE') {
            return finish(400, { success: false, message: "Could not accept job (slots full or job not available)" }, false);
          }
          throw error;
        } finally {
          await session.endSession();
        }

        if (!updated) {
          return finish(400, { success: false, message: "Could not accept job (slots full or job not available)" }, false);
        }

        // Check if this was a duplicate acceptance after transaction
        const alreadyAcceptedAfter = (updated.acceptedWorkers || []).find((w) => w.phone === workerPhone);
        if (alreadyAcceptedAfter && alreadyAcceptedAfter.acceptedAt < acceptedWorkerSnapshot.acceptedAt) {
          return finish(200, { success: true, message: "Job already accepted by you", job: updated, idempotent: true });
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
          const gigDataUpdated = await updateGigDataOnAcceptance(workerPhone, {
            jobId: bulkJob._id.toString(),
            title: bulkJob.title,
            amount: bulkJob.amount,
            workerType: bulkJob.workerType,
          });
          if (!gigDataUpdated) {
            console.warn(`[JobAccept] Gig data not updated for ${workerPhone} on job ${bulkJob._id}`);
          }
          
          // Bug #4: job_accepted event passes hoursWorked=0 (intentional - work hasn't happened yet)
          const historyEvent = await createGigHistoryEvent({
            workerPhone,
            workerName: workerName || workerPhone,
            jobId: bulkJob._id,
            jobTitle: bulkJob.title,
            contractorPhone: bulkJob.contractorPhone,
            contractorName: bulkJob.contractorName,
            eventType: "job_accepted",
            status: bulkJob.status,
            paymentStatus: bulkJob.paymentStatus,
            hoursWorked: 0, // Intentional: no work done yet, just accepted
            timeSpentMinutes: 0,
            eventTime: new Date(),
            metadata: { eventReason: 'job_offer_accepted_bulk', bulkJobId: bulkJob._id },
          });
          if (!historyEvent) {
            console.warn(`[JobAccept] GigHistory event not created for ${workerPhone} on job ${bulkJob._id}`);
          }
        } catch (e) {
          console.error("[JobAccept] Error updating gigs data on acceptance:", e.message, {
            workerPhone,
            jobId: bulkJob._id,
          });
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
            await cancelDispatchState({ jobId, reason: "accepted_bulk_finalized" });
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

        const payload = { ...bulkJob.toObject(), _targetedUpdate: true, targetedFor: [bulkJob.contractorPhone] };
        await emitJobUpdatedToUsers(payload, [bulkJob.contractorPhone, workerPhone, bulkJob.acceptedBy]);
        try {
          if (typeof updateContractorStats === "function" && bulkJob.contractorPhone) {
            await updateContractorStats(bulkJob.contractorPhone);
          }
        } catch (statsErr) {
          console.error("Error updating contractor stats after bulk accept:", statsErr);
        }

        return finish(200, { success: true, message: "Job accepted successfully", job: bulkJob, idempotent: false });
      }

      if (job.acceptedBy === normalizedWorkerPhone) {
        return finish(200, { success: true, message: "Job already accepted by you", job, idempotent: true });
      }

      const updated = await Job.findOneAndUpdate(
        {
          _id: jobId,
          status: { $in: ["pending", "posted", "offered"] },
          acceptedBy: { $in: [null, ""] },
        },
        { $set: { status: "accepted", acceptedBy: normalizedWorkerPhone, acceptedWorker: acceptedWorkerSnapshot, acceptedAt: new Date() } },
        { new: true }
      );

      if (!updated) {
        const latest = await Job.findById(jobId);
        if (latest && latest.acceptedBy === workerPhone) {
          return finish(200, { success: true, message: "Job already accepted by you", job: latest, idempotent: true });
        }
        return finish(400, { success: false, message: "Job already accepted or not found" }, false);
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
        const gigDataUpdated = await updateGigDataOnAcceptance(workerPhone, {
          jobId: updated._id.toString(),
          title: updated.title,
          amount: updated.amount,
          workerType: updated.workerType,
        });
        if (!gigDataUpdated) {
          console.warn(`[JobAccept] Gig data not updated for ${workerPhone} on job ${updated._id}`);
        }
        
        // Bug #4: job_accepted event passes hoursWorked=0 (intentional - work hasn't happened yet)
        const historyEvent = await createGigHistoryEvent({
          workerPhone,
          workerName: workerName || workerPhone,
          jobId: updated._id,
          jobTitle: updated.title,
          contractorPhone: updated.contractorPhone,
          contractorName: updated.contractorName,
          eventType: "job_accepted",
          status: updated.status,
          paymentStatus: updated.paymentStatus,
          hoursWorked: 0, // Intentional: no work done yet, just accepted
          timeSpentMinutes: 0,
          eventTime: new Date(),
          metadata: { eventReason: 'job_offer_accepted_single', jobId: updated._id },
        });
        if (!historyEvent) {
          console.warn(`[JobAccept] GigHistory event not created for ${workerPhone} on job ${updated._id}`);
        }
      } catch (e) {
        console.error("[JobAccept] Error updating gigs data on acceptance:", e.message, {
          workerPhone,
          jobId: updated._id,
        });
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
        targetedFor: [updated.contractorPhone, workerPhone],
      };
      await emitJobUpdatedToUsers(acceptPayload, [updated.contractorPhone, workerPhone]);
      try {
        if (typeof updateContractorStats === "function" && updated.contractorPhone) {
          await updateContractorStats(updated.contractorPhone);
        }
      } catch (statsErr) {
        console.error("Error updating contractor stats after accept:", statsErr);
      }

      if (pendingJobTimeouts.has(jobId)) {
        clearTimeout(pendingJobTimeouts.get(jobId));
        pendingJobTimeouts.delete(jobId);
      }
      if (pendingJobExpirations.has(jobId)) {
        clearTimeout(pendingJobExpirations.get(jobId));
        pendingJobExpirations.delete(jobId);
      }
      await cancelDispatchState({ jobId, reason: "accepted_single" });

      try {
        const TRACK_MINUTES = Number(process.env.TRACK_MINUTES) || 10;
        trackingJobs.set(jobId, Date.now() + TRACK_MINUTES * 40 * 1000);
      } catch (e) {
        console.error("Error starting tracking for job", e);
      }
      return finish(200, { success: true, message: "Job accepted successfully", job: updated, idempotent: false });
    } catch (err) {
      try {
        const fallbackPhone = req.user?.phone;
        const fallbackKey =
          String(req.header("X-Idempotency-Key") || req.body?.idempotencyKey || "")
            .trim()
            .slice(0, 120) || `accept:${req.params.id}:${fallbackPhone}`;
        acceptInFlight.delete(fallbackKey);
      } catch (_e) {}
      console.error("Accept error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/jobs/decline/:id", authenticateToken, async (req, res) => {
    try {
      const jobId = req.params.id;
      const workerName = req.user.name;
      const workerPhone = normalizePhoneNumber(req.user.phone);
      const idempotencyKey =
        String(req.header("X-Idempotency-Key") || req.body?.idempotencyKey || "")
          .trim()
          .slice(0, 120);
      const declineKey = idempotencyKey || `decline:${jobId}:${workerPhone}`;

      // Cleanup stale idempotency cache entries.
      const now = Date.now();
      for (const [k, v] of declineResultCache.entries()) {
        if (!v || now - v.at > DECLINE_IDEMPOTENCY_TTL_MS) declineResultCache.delete(k);
      }

      const finish = (statusCode, body, cache = true) => {
        declineInFlight.delete(declineKey);
        if (cache) declineResultCache.set(declineKey, { at: Date.now(), statusCode, body });
        return res.status(statusCode).json(body);
      };

      if (declineResultCache.has(declineKey)) {
        const cached = declineResultCache.get(declineKey);
        return res.status(cached.statusCode).json({ ...cached.body, idempotent: true });
      }
      if (declineInFlight.has(declineKey)) {
        return res.status(202).json({
          success: true,
          message: "Decline request already processing",
          idempotent: true,
        });
      }
      declineInFlight.add(declineKey);

      const job = await Job.findById(jobId);
      if (!job) {
        return finish(404, { success: false, message: "Job not found" }, false);
      }

      // Canonical identity for declines is normalized phone.
      const normalizedWorkerPhone = normalizePhoneNumber(req.user.phone);
      job.declinedBy = Array.isArray(job.declinedBy)
        ? job.declinedBy.map(normalizePhoneNumber).filter(Boolean)
        : [];
      const alreadyDeclined = job.declinedBy.includes(normalizedWorkerPhone);

      // Idempotent return for repeated decline taps / retries.
      if (alreadyDeclined && !(normalizePhoneNumber(job.acceptedBy) === normalizedWorkerPhone || (job.acceptedWorkers || []).some((w) => normalizePhoneNumber(w.phone) === normalizedWorkerPhone))) {
        return finish(200, { success: true, message: "Job already declined", job, idempotent: true });
      }

      if (!job.declinedBy.includes(normalizedWorkerPhone)) {
        job.declinedBy.push(normalizedWorkerPhone);
      }

      if (job.bulkHiring) {
        const before = job.acceptedWorkers ? job.acceptedWorkers.length : 0;
        job.acceptedWorkers = (job.acceptedWorkers || [])
          .map((w) => ({ ...w, phone: normalizePhoneNumber(w.phone) }))
          .filter((w) => w.phone !== normalizedWorkerPhone);
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
            await createGigHistoryEvent({
              workerPhone,
              workerName: workerName || workerPhone,
              jobId: job._id,
              jobTitle: job.title,
              contractorPhone: job.contractorPhone,
              contractorName: job.contractorName,
              eventType: "job_declined_offer",
              status: job.status,
              paymentStatus: job.paymentStatus,
              eventTime: new Date(),
              metadata: { 
                declineReason: job.declineReason || 'not_specified',
                timestamp: new Date().toISOString()
              }
            });
          } catch (e) {
            console.error("Error updating gigs data on cancellation:", e);
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
          await createGigHistoryEvent({
            workerPhone,
            workerName: workerName || workerPhone,
            jobId: job._id,
            jobTitle: job.title,
            contractorPhone: job.contractorPhone,
            contractorName: job.contractorName,
            eventType: "job_declined_offer",
            status: job.status,
            paymentStatus: job.paymentStatus,
            eventTime: new Date(),
            metadata: { 
              declineReason: job.declineReason || 'not_specified',
              timestamp: new Date().toISOString()
            }
          });
        } catch (e) {
          console.error("Error updating gigs data on cancellation:", e);
        }
      }

      await job.save();
      await logJobEvent({
        jobId: job._id,
        eventType: "job_rejected",
        actorType: "worker",
        actorPhone: workerPhone,
        source: "app",
        idempotencyKey: idempotencyKey || null,
        oldState: { status: job.status },
        newState: { status: job.status },
        reasonCode: "worker_declined",
        reasonText: "Worker declined job offer",
        metadata: { declinedBy: workerPhone, bulkHiring: !!job.bulkHiring },
      });

      await emitJobUpdatedToUsers(job, [job.contractorPhone, workerPhone]);

      if (job.status === "pending") {
        try {
          await offerJobToNextWorker(job);
        } catch (e) {
          console.error("Error offering to next worker after decline:", e);
        }
      }

      return finish(200, { success: true, message: "Job declined successfully", job, idempotent: false });
    } catch (err) {
      // Safety clear for lock if an exception happens before finish().
      try {
        const workerPhone = req.user?.phone;
        const keyFallback = String(req.header("X-Idempotency-Key") || req.body?.idempotencyKey || "").trim().slice(0, 120) || `decline:${req.params.id}:${workerPhone}`;
        declineInFlight.delete(keyFallback);
      } catch (_e) {}
      console.error("Decline error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = {
  createJobsLifecycleCoreRouter,
};
