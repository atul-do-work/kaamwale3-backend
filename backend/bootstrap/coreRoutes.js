function registerCoreRoutes(app) {
  const walletRoutes = require("../routes/wallet");
  app.use("/wallet", walletRoutes);

  const razorpayRoutes = require("../routes/razorpay");
  app.use("/api/payment", razorpayRoutes);

  const leaderboardModule = require("../services/leaderboard");
  const { router: leaderboardRoutes, startLeaderboardScheduler } = leaderboardModule;
  console.log("✓ Leaderboard scheduler loaded:", typeof startLeaderboardScheduler);
  
  const walletRecModule = require("../services/walletReconciliation");
  const { startWalletReconciliationScheduler } = walletRecModule;
  console.log("✓ Wallet reconciliation scheduler loaded:", typeof startWalletReconciliationScheduler);
  
  const jobRecModule = require("../services/jobReconciliation");
  const { startJobReconciliationScheduler } = jobRecModule;
  console.log("✓ Job reconciliation scheduler loaded:", typeof startJobReconciliationScheduler);
  
  const premiumRecModule = require("../services/premiumReconciliation");
  const { startPremiumReconciliationScheduler } = premiumRecModule;
  console.log("✓ Premium reconciliation scheduler loaded:", typeof startPremiumReconciliationScheduler);
  
  const weeklySettleModule = require("../services/weeklyWalletSettlement");
  const { startWeeklyWalletSettlementScheduler } = weeklySettleModule;
  console.log("✓ Weekly wallet settlement scheduler loaded:", typeof startWeeklyWalletSettlementScheduler);
  
  const cancelRecModule = require("../services/cancellationReconciliation");
  const { startCancellationReconciliationScheduler } = cancelRecModule;
  console.log("✓ Cancellation reconciliation scheduler loaded:", typeof startCancellationReconciliationScheduler);
  
  app.use("/leaderboard", leaderboardRoutes);

  const payoutRoutes = require("../routes/payout");
  app.use("/api/payouts", payoutRoutes);

  const adminRoutes = require("../routes/admin");
  app.use("/admin", adminRoutes);

  const uploadRoutes = require("../routes/Upload");
  app.use("/upload", uploadRoutes);

  const incentiveRoutes = require("../routes/incentives");
  app.use("/incentives", incentiveRoutes);

  return {
    startLeaderboardScheduler,
    startWalletReconciliationScheduler,
    startJobReconciliationScheduler,
    startPremiumReconciliationScheduler,
    startWeeklyWalletSettlementScheduler,
    startCancellationReconciliationScheduler,
  };
}

module.exports = {
  registerCoreRoutes,
};
