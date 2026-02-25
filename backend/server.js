require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const { getDistanceFromLatLonInKm } = require("./utils/distance");
const { authenticateToken } = require("./utils/auth"); 
const multer = require("multer"); 
const mongoose = require("mongoose");
const WorkerModel = require("./models/Worker");
const { findNearbyWorkers } = require("./services/matchingService");
const fileUpload = require('express-fileupload'); 
const { sendNotificationToUserPhone } = require('./utils/push');
const { PORT, JWT_SECRET, getPublicBaseUrl } = require("./config/runtime");
const { connectDatabase } = require("./config/database");
const { setupBaseApp } = require("./bootstrap/baseApp");
const { registerCoreRoutes } = require("./bootstrap/coreRoutes");
const { startBackgroundSchedulers } = require("./bootstrap/schedulers");
const { mountAppRoutes } = require("./bootstrap/appRoutes");
const {
  createUpdateContractorStats,
  createEmitJobUpdatedToUsers,
  createEmitJobCancelledToUsers,
} = require("./services/realtimeDispatchService");
const { createJobEventLogger } = require("./services/jobEventService");
const { createJobDispatchHelpers } = require("./services/jobDispatchService");
const { startDispatchStateProcessor } = require("./services/dispatchStateService");


// ---------------- MODELS ----------------
const User = require("./models/User");
const ContractorStats = require("./models/ContractorStats");
const Wallet = require("./models/Wallet"); 
const Job = require("./models/Jobs"); 
const NotificationHistory = require("./models/NotificationHistory");
const JobEventLog = require("./models/JobEventLog");
const { attachSocketAuthMiddleware } = require("./socket/authMiddleware");
const { attachSocketConnectionHandlers } = require("./socket/connectionHandlers");


connectDatabase({ mongoose, jobModel: Job }).catch((err) => {
  console.error("MongoDB connection error:", err);
});

// ---------------- EXPRESS & MIDDLEWARE ----------------
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.set("io", io);
setupBaseApp(app, { rootDir: __dirname });
const {
  startLeaderboardScheduler,
  startWalletReconciliationScheduler,
  startJobReconciliationScheduler,
  startPremiumReconciliationScheduler,
  startWeeklyWalletSettlementScheduler,
} = registerCoreRoutes(app);



// ---------------- RATE LIMITERS ----------------
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    message: "Too many login attempts. Please try again after 15 minutes."
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------- CONNECTED WORKERS TRACKING ----------------
const connectedWorkers = new Map(); // Map to store: socketId -> { name, phone, lat, lon, workerType }
// Track which jobs should receive forwarded worker location updates: jobId -> expiryTimestamp
const trackingJobs = new Map();
// Track pending jobs with auto-decline timeouts: jobId -> timeoutId
const pendingJobTimeouts = new Map();
// Track pending job expiration timers (30 minute overall expiry): jobId -> timeoutId
const pendingJobExpirations = new Map();

const updateContractorStats = createUpdateContractorStats({ Job, ContractorStats });
const emitJobUpdatedToUsers = createEmitJobUpdatedToUsers({ io, connectedWorkers });
const emitJobCancelledToUsers = createEmitJobCancelledToUsers({ io, connectedWorkers });

const logJobEvent = createJobEventLogger({ JobEventLog });
const { checkJobMatchesForWorker, offerJobToNextWorker } = createJobDispatchHelpers({
  Job,
  WorkerModel,
  User,
  getDistanceFromLatLonInKm,
  findNearbyWorkers,
  connectedWorkers,
  pendingJobTimeouts,
  io,
  sendNotificationToUserPhone,
  logJobEvent,
});


// ---------------- SOCKET.IO ----------------

attachSocketAuthMiddleware(io, {
  jwt,
  jwtSecret: JWT_SECRET,
  WorkerModel,
  User,
  connectedWorkers,
});

attachSocketConnectionHandlers(io, {
  Job,
  connectedWorkers,
  WorkerModel,
  User,
  findNearbyWorkers,
  Wallet,
  logJobEvent,
  pendingJobTimeouts,
  pendingJobExpirations,
  offerJobToNextWorker,
  emitJobUpdatedToUsers,
  emitJobCancelledToUsers,
  trackingJobs,
  sendNotificationToUserPhone,
});

// Multer for profile upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ 
  storage,
    limits: { fileSize: 10 * 1024 * 1024 },
});
mountAppRoutes({
  app,
  io,
  upload,
  jwt,
  jwtSecret: JWT_SECRET,
  loginLimiter,
  authenticateToken,
  fileUpload,
  getPublicBaseUrl,
  getDistanceFromLatLonInKm,
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
  port: PORT,
});

startDispatchStateProcessor({
  Job,
  io,
  emitJobCancelledToUsers,
  logJobEvent,
  offerJobToNextWorker,
  pendingJobTimeouts,
  pendingJobExpirations,
});


startBackgroundSchedulers({
  Job,
  io,
  pendingJobTimeouts,
  pendingJobExpirations,
  startLeaderboardScheduler,
  startWalletReconciliationScheduler,
  startJobReconciliationScheduler,
  startPremiumReconciliationScheduler,
  startWeeklyWalletSettlementScheduler,
});

// ---------------- START SERVER ----------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running with Socket.io on port ${PORT}`);
});

