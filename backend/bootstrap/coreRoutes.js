function registerCoreRoutes(app) {
  const walletRoutes = require("../routes/wallet");
  app.use("/wallet", walletRoutes);

  const razorpayRoutes = require("../routes/razorpay");
  app.use("/api/payment", razorpayRoutes);

  const { router: leaderboardRoutes, startLeaderboardScheduler } = require("../services/leaderboard");
  const { startWalletReconciliationScheduler } = require("../services/walletReconciliation");
  const { startJobReconciliationScheduler } = require("../services/jobReconciliation");
  const { startPremiumReconciliationScheduler } = require("../services/premiumReconciliation");
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
  };
}

module.exports = {
  registerCoreRoutes,
};

