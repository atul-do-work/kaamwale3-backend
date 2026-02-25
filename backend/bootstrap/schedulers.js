function startBackgroundSchedulers({
  Job,
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
  const startJobOfferCleanupScheduler = () => {
    setInterval(async () => {
      try {
        const now = new Date();

        const expiredJobs = await Job.find({
          offerExpiresAt: { $lt: now },
          status: "pending",
        }).select("_id");

        if (expiredJobs.length === 0) return;

        console.log(`Job Offer Cleanup: Found ${expiredJobs.length} expired offers`);

        for (const job of expiredJobs) {
          const jobId = job._id.toString();
          if (pendingJobTimeouts.has(jobId)) {
            clearTimeout(pendingJobTimeouts.get(jobId));
            pendingJobTimeouts.delete(jobId);
            console.log(`  Cleared timeout for job ${jobId}`);
          }
          if (pendingJobExpirations.has(jobId)) {
            clearTimeout(pendingJobExpirations.get(jobId));
            pendingJobExpirations.delete(jobId);
          }
          await cancelDispatchState({ jobId, reason: "cleanup_scheduler" });
        }

        console.log(`Job offer cleanup completed. Memory map size: ${pendingJobTimeouts.size}`);
      } catch (err) {
        console.error("Error in job offer cleanup scheduler:", err);
      }
    }, 5 * 60 * 1000);
  };

  setTimeout(() => {
    startLeaderboardScheduler();
    startJobOfferCleanupScheduler();
    startWalletReconciliationScheduler();
    startJobReconciliationScheduler();
    startPremiumReconciliationScheduler();
    startWeeklyWalletSettlementScheduler({ io });
    startCancellationReconciliationScheduler();
  }, 2000);
}

module.exports = {
  startBackgroundSchedulers,
};
