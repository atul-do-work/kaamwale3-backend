  function startBackgroundSchedulers({
  Job,
  Wallet,
  User,
  WorkerModel,
  io,
  pendingJobTimeouts,
  pendingJobExpirations,
  startLeaderboardScheduler,
  startWalletReconciliationScheduler,
  startJobReconciliationScheduler,
  startPremiumReconciliationScheduler,
  startWeeklyWalletSettlementScheduler,
  startCancellationReconciliationScheduler,
}) {
  const { cancelDispatchState } = require("../services/dispatchStateService");
  const { sendOpsAlert } = require("../utils/opsAlert");

  const startAvailabilityDriftGuard = () => {
    setInterval(async () => {
      try {
        if (!User || !WorkerModel) return;
        const users = await User.find({ role: "worker" }).select("phone isAvailable").lean();
        if (!users.length) return;

        let fixed = 0;
        for (const u of users) {
          const phone = String(u.phone || "").trim();
          if (!phone) continue;
          const target = !!u.isAvailable;
          const result = await WorkerModel.updateOne(
            { phone, isAvailable: { $ne: target } },
            { $set: { isAvailable: target, updatedAt: new Date() } }
          );
          if ((result?.modifiedCount || 0) > 0) fixed += 1;
        }
        if (fixed > 0) {
          console.log(`[AvailabilityDriftGuard] Corrected ${fixed} worker availability mirror mismatches`);
        }
      } catch (err) {
        console.error("Availability drift guard scheduler error:", err);
      }
    }, 5 * 60 * 1000);
  };

  const startPaidJobFinalizationGuard = () => {
    const JobEventLog = require("../models/JobEventLog");
    setInterval(async () => {
      try {
        const stuckPaidJobs = await Job.find({
          paymentStatus: "paid",
          status: { $in: ["pending", "posted", "offered", "accepted", "in_progress"] },
        }).select("_id status paymentStatus").limit(200);
        if (!stuckPaidJobs.length) return;

        for (const job of stuckPaidJobs) {
          const oldStatus = job.status;
          job.status = "completed";
          await job.save();
          await JobEventLog.create({
            jobId: job._id,
            eventType: "paid_state_normalized",
            actorType: "system",
            source: "scheduler",
            oldState: { status: oldStatus, paymentStatus: "paid" },
            newState: { status: "completed", paymentStatus: "paid" },
            metadata: { reason: "paid_status_terminal_guard" },
          });
        }
        console.log(`[PaidStateGuard] Finalized ${stuckPaidJobs.length} paid jobs to completed`);
      } catch (err) {
        console.error("Paid state guard scheduler error:", err);
      }
    }, 5 * 60 * 1000);
  };

  const startOpsHealthAlertScheduler = () => {
    const JobEventLog = require("../models/JobEventLog");
    const cooldown = new Map();
    const shouldSend = (key, ttlMs = 10 * 60 * 1000) => {
      const now = Date.now();
      const last = cooldown.get(key) || 0;
      if (now - last < ttlMs) return false;
      cooldown.set(key, now);
      return true;
    };

    setInterval(async () => {
      try {
        const now = new Date();

        // 1) Stuck jobs
        const stuckSince = new Date(Date.now() - 6 * 60 * 60 * 1000);
        const stuckJobs = await Job.find({
          status: { $in: ["accepted", "in_progress"] },
          paymentStatus: { $ne: "paid" },
          updatedAt: { $lt: stuckSince },
        }).select("_id contractorPhone acceptedBy status paymentStatus updatedAt").limit(20).lean();
        if (stuckJobs.length > 0 && shouldSend("stuck_jobs")) {
          await sendOpsAlert("Stuck jobs detected", {
            count: stuckJobs.length,
            sample: stuckJobs.map((j) => ({
              jobId: j._id,
              contractorPhone: j.contractorPhone,
              workerPhone: j.acceptedBy,
              status: j.status,
              paymentStatus: j.paymentStatus,
              updatedAt: j.updatedAt,
            })),
          });
        }

        // 2) Payment mismatch (Paid job but no payment transaction found)
        const paidJobs = await Job.find({ paymentStatus: "paid", updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
          .select("_id contractorPhone acceptedBy paymentStatus status").limit(30).lean();
        const mismatches = [];
        for (const j of paidJobs) {
          const txExists = await Wallet.exists({
            "transactions.jobId": j._id,
            "transactions.type": "payment",
          });
          if (!txExists) mismatches.push(j);
        }
        if (mismatches.length > 0 && shouldSend("payment_mismatch")) {
          await sendOpsAlert("Payment mismatch detected", {
            count: mismatches.length,
            sample: mismatches.map((j) => ({
              jobId: j._id,
              contractorPhone: j.contractorPhone,
              workerPhone: j.acceptedBy,
              status: j.status,
              paymentStatus: j.paymentStatus,
            })),
          });
        }

        // 3) Duplicate offers (same job+target in short window)
        const dupOfferRows = await JobEventLog.aggregate([
          { $match: { eventType: "offer_sent", timestamp: { $gte: new Date(Date.now() - 15 * 60 * 1000) } } },
          {
            $group: {
              _id: { jobId: "$jobId", targetPhone: "$metadata.targetPhone" },
              count: { $sum: 1 },
              latest: { $max: "$timestamp" },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $limit: 20 },
        ]);
        if (dupOfferRows.length > 0 && shouldSend("duplicate_offers")) {
          await sendOpsAlert("Duplicate job offers detected", {
            count: dupOfferRows.length,
            sample: dupOfferRows.map((r) => ({
              jobId: r._id?.jobId,
              workerPhone: r._id?.targetPhone,
              duplicateCount: r.count,
              latest: r.latest,
            })),
          });
        }

        // 4) Webhook retries (duplicate webhook payment event IDs)
        const webhookDupRows = await JobEventLog.aggregate([
          {
            $match: {
              eventType: "payment_captured_webhook",
              providerEventId: { $exists: true, $ne: null },
              timestamp: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
            },
          },
          {
            $group: {
              _id: "$providerEventId",
              count: { $sum: 1 },
              jobs: { $addToSet: "$jobId" },
              latest: { $max: "$timestamp" },
            },
          },
          { $match: { count: { $gt: 1 } } },
          { $limit: 20 },
        ]);
        if (webhookDupRows.length > 0 && shouldSend("webhook_retries")) {
          await sendOpsAlert("Webhook retries detected", {
            count: webhookDupRows.length,
            sample: webhookDupRows.map((r) => ({
              paymentId: r._id,
              duplicateCount: r.count,
              jobs: r.jobs,
              latest: r.latest,
            })),
          });
        }

        void now;
      } catch (err) {
        console.error("Ops health alert scheduler error:", err);
      }
    }, 5 * 60 * 1000);
  };

  setTimeout(() => {
    try {
      console.log("🚀 Starting background schedulers...");
      
      if (typeof startLeaderboardScheduler === "function") {
        startLeaderboardScheduler();
        console.log("✅ Leaderboard scheduler started");
      }
      
      if (typeof startWalletReconciliationScheduler === "function") {
        startWalletReconciliationScheduler();
        console.log("✅ Wallet reconciliation scheduler started");
      }
      
      if (typeof startJobReconciliationScheduler === "function") {
        startJobReconciliationScheduler();
        console.log("✅ Job reconciliation scheduler started");
      }
      
      if (typeof startPremiumReconciliationScheduler === "function") {
        startPremiumReconciliationScheduler();
        console.log("✅ Premium reconciliation scheduler started");
      }
      
      if (typeof startWeeklyWalletSettlementScheduler === "function") {
        startWeeklyWalletSettlementScheduler({ io });
        console.log("✅ Weekly wallet settlement scheduler started");
      }
      
      if (typeof startCancellationReconciliationScheduler === "function") {
        startCancellationReconciliationScheduler();
        console.log("✅ Cancellation reconciliation scheduler started");
      }
      
      startAvailabilityDriftGuard();
      console.log("✅ Availability drift guard started");
      
      startPaidJobFinalizationGuard();
      console.log("✅ Paid job finalization guard started");
      
      startOpsHealthAlertScheduler();
      console.log("✅ Ops health alert scheduler started");
      
      console.log("✅ All background schedulers initialized successfully!");
    } catch (err) {
      console.error("❌ Fatal error starting schedulers:", err);
    }
  }, 2000);
}

module.exports = {
  startBackgroundSchedulers,
};
