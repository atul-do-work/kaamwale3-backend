const DispatchState = require("../models/DispatchState");

async function scheduleDispatchState({ jobId, type, runAt, metadata = null }) {
  if (!jobId || !type || !runAt) return null;
  return DispatchState.findOneAndUpdate(
    { jobId, type, status: "pending" },
    {
      $set: {
        runAt: new Date(runAt),
        metadata,
        reason: "",
        lastError: "",
      },
      $setOnInsert: {
        attempts: 0,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function cancelDispatchState({ jobId, type, reason = "cleared" }) {
  if (!jobId) return;
  const query = { jobId, status: { $in: ["pending", "processing"] } };
  if (type) query.type = type;
  await DispatchState.updateMany(
    query,
    {
      $set: {
        status: "cancelled",
        reason: String(reason || "cleared"),
        processedAt: new Date(),
      },
    }
  );
}

function startDispatchStateProcessor({
  Job,
  io,
  emitJobCancelledToUsers,
  logJobEvent,
  offerJobToNextWorker,
  pendingJobTimeouts,
  pendingJobExpirations,
  intervalMs = 5000,
}) {
  const timer = setInterval(async () => {
    try {
      const now = new Date();
      const due = await DispatchState.find({
        status: "pending",
        runAt: { $lte: now },
      })
        .sort({ runAt: 1 })
        .limit(50)
        .lean();

      for (const row of due) {
        const claimed = await DispatchState.findOneAndUpdate(
          { _id: row._id, status: "pending" },
          { $set: { status: "processing" }, $inc: { attempts: 1 } },
          { new: true }
        );
        if (!claimed) continue;

        try {
          const job = await Job.findById(claimed.jobId);
          if (!job) {
            claimed.status = "done";
            claimed.reason = "job_not_found";
            claimed.processedAt = new Date();
            await claimed.save();
            continue;
          }

          if (claimed.type === "retry_offer") {
            if (job.status === "pending") {
              await offerJobToNextWorker(job);
              claimed.reason = "retry_triggered";
            } else {
              claimed.reason = "job_not_pending";
            }
            claimed.status = "done";
            claimed.processedAt = new Date();
            await claimed.save();
            continue;
          }

          if (claimed.type === "expire_offer") {
            const acceptedCount = job.bulkHiring ? (job.acceptedWorkers?.length || 0) : (job.acceptedBy ? 1 : 0);
            if (job.status === "pending" && acceptedCount === 0) {
              const oldState = { status: job.status, paymentStatus: job.paymentStatus };
              job.status = "expired";
              await job.save();

              try {
                if (typeof logJobEvent === "function") {
                  await logJobEvent({
                    jobId: job._id,
                    eventType: "job_expired",
                    actorType: "system",
                    source: "system",
                    oldState,
                    newState: { status: job.status, paymentStatus: job.paymentStatus },
                  });
                }
              } catch (e) {
                console.error("dispatchState: logJobEvent failed:", e.message);
              }

              const payload = {
                ...job.toObject(),
                _id: job._id.toString(),
                id: job._id.toString(),
                status: "expired",
                expiredAt: new Date(),
              };
              const targetUsers = [
                job.contractorPhone,
                job.contractorName,
                job.acceptedBy,
                ...(Array.isArray(job.acceptedWorkers) ? job.acceptedWorkers.map((w) => w?.phone).filter(Boolean) : []),
              ];
              if (typeof emitJobCancelledToUsers === "function") {
                await emitJobCancelledToUsers(payload, targetUsers);
              } else if (io) {
                io.emit("jobCancelled", payload);
              }
            }

            const jobId = String(job._id);
            if (pendingJobTimeouts?.has(jobId)) {
              clearTimeout(pendingJobTimeouts.get(jobId));
              pendingJobTimeouts.delete(jobId);
            }
            if (pendingJobExpirations?.has(jobId)) {
              clearTimeout(pendingJobExpirations.get(jobId));
              pendingJobExpirations.delete(jobId);
            }
            await cancelDispatchState({ jobId: job._id, type: "retry_offer", reason: "expired" });

            claimed.status = "done";
            claimed.reason = "expire_processed";
            claimed.processedAt = new Date();
            await claimed.save();
            continue;
          }

          claimed.status = "done";
          claimed.reason = "unknown_type";
          claimed.processedAt = new Date();
          await claimed.save();
        } catch (err) {
          claimed.status = "failed";
          claimed.lastError = String(err?.message || err);
          claimed.processedAt = new Date();
          await claimed.save();
        }
      }
    } catch (err) {
      console.error("dispatchState processor error:", err);
    }
  }, intervalMs);

  return timer;
}

module.exports = {
  scheduleDispatchState,
  cancelDispatchState,
  startDispatchStateProcessor,
};

