const { createJobsLifecycleRouter } = require("../routes/jobsLifecycle");
const { createNotificationsRouter } = require("../routes/notifications");
const { createAuthSupportRouter } = require("../routes/authSupport");
const { createOpsSupportRouter } = require("../routes/opsSupport");
const { createWorkersRouter } = require("../routes/workers");
const { createPremiumWalletRouter } = require("../routes/premiumWallet");
const { createContractorStatsRouter } = require("../routes/contractorStats");
const { createUsersProfileRouter } = require("../routes/usersProfile");
const { createAuthCoreRouter } = require("../routes/authCore");
const { createJobsReadRouter } = require("../routes/jobsRead");
const { createJobsCoreRouter } = require("../routes/jobsCore");
const { createJobsLifecycleCoreRouter } = require("../routes/jobsLifecycleCore");
const {
  updateGigDataOnCancellation,
  updateGigDataOnAcceptance,
} = require("../utils/gigsDataTracker");

function mountAppRoutes({
  app,
  io,
  upload,
  jwt,
  jwtSecret,
  loginLimiter,
  authenticateToken,
  fileUpload,
  getPublicBaseUrl,
  getDistanceFromLatLonInKm,
  sessionStore,
  connectedWorkers,
  trackingJobs,
  pendingJobTimeouts,
  pendingJobExpirations,
  Job,
  User,
  WorkerModel,
  Wallet,
  NotificationHistory,
  bcrypt,
  logJobEvent,
  updateContractorStats,
  emitJobUpdatedToUsers,
  emitJobCancelledToUsers,
  checkJobMatchesForWorker,
  offerJobToNextWorker,
  sendNotificationToUserPhone,
  port,
}) {
  app.use(
    "/",
    createJobsLifecycleRouter({
      io,
      trackingJobs,
      pendingJobTimeouts,
      pendingJobExpirations,
      emitJobUpdatedToUsers,
      emitJobCancelledToUsers,
      logJobEvent,
      updateContractorStats,
      offerJobToNextWorker,
    })
  );
  app.use("/", createNotificationsRouter({ io }));
  app.use("/", createAuthSupportRouter({ JWT_SECRET: jwtSecret, sendNotificationToUserPhone, sessionStore }));
  app.use(
    "/",
    createWorkersRouter({
      io,
      connectedWorkers,
      checkJobMatchesForWorker,
      sendNotificationToUserPhone,
    })
  );
  app.use("/", createPremiumWalletRouter({ io }));
  app.use("/", createContractorStatsRouter());
  app.use("/", createOpsSupportRouter({ upload, PORT: port }));
  app.use("/", createUsersProfileRouter({ upload, io, connectedWorkers }));
  app.use(
    "/",
    createAuthCoreRouter({
      User,
      Wallet,
      WorkerModel,
      bcrypt,
      jwt,
      jwtSecret,
      loginLimiter,
    })
  );
  app.use("/", createJobsReadRouter({ authenticateToken, Job, getDistanceFromLatLonInKm }));
  app.use(
    "/",
    createJobsCoreRouter({
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
    })
  );
  app.use(
    "/",
    createJobsLifecycleCoreRouter({
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
      emitJobCancelledToUsers,
    })
  );
}

module.exports = {
  mountAppRoutes,
};
