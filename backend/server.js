require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
const { getDistanceFromLatLonInKm } = require("./utils/distance");
const { authenticateToken } = require("./utils/auth"); // ✅ Centralized auth middleware
const multer = require("multer"); // ✅ For profile photo uploads
const mongoose = require("mongoose");
const WorkerModel = require("./models/Worker");
const { findNearbyWorkers } = require("./services/matchingService");
const fileUpload = require('express-fileupload'); // ✅ For job image uploads
const { updateGigDataOnCompletion, updateGigDataOnCancellation, updateGigDataOnAcceptance, getWorkerGigsSummary } = require("./utils/gigsDataTracker"); // ✅ Gigs tracking
const { sendNotificationToUserPhone } = require('./utils/push');

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";
const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || "";

function getPublicBaseUrl(req) {
  if (SERVER_PUBLIC_URL) return SERVER_PUBLIC_URL.replace(/\/$/, "");
  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto || req.protocol || "https"))
    .toString()
    .split(",")[0]
    .trim();
  const host = process.env.SERVER_URL_DOMAIN || req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

// ---------------- MONGODB CONNECTION ----------------
mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/IndianWorker")
  .then(async () => {
    console.log("MongoDB Connected");
    
    // ✅ Drop old 'id' index if it exists (migration from UUID to ObjectId)
    try {
      const indexes = await Job.collection.getIndexes();
      if (indexes.id_1) {
        await Job.collection.dropIndex("id_1");
        console.log("✅ Dropped old 'id' index from jobs collection");
      }
    } catch (err) {
      console.warn("Note: Could not drop old id index (may not exist):", err.message);
    }
  })
  .catch((err) => console.error("MongoDB connection error:", err));


// ----------------MODELS ----------------
// Use centralized models in ./models/*.js
const User = require("./models/User");
const ContractorStats = require("./models/ContractorStats");
const Wallet = require("./models/Wallet"); // ✅ Import from models folder to avoid duplication
const Job = require("./models/Jobs"); // ✅ Import Job model from centralized models folder
// ✅ NEW: Critical collections for production readiness
const ActivityLog = require("./models/ActivityLog");
const SupportTicket = require("./models/SupportTicket");
const VerificationDocument = require("./models/VerificationDocument");
const CancellationLog = require("./models/CancellationLog");
const NotificationHistory = require("./models/NotificationHistory");
const JobEventLog = require("./models/JobEventLog");
const { createJobsLifecycleRouter } = require("./routes/jobsLifecycle");
const { createNotificationsRouter } = require("./routes/notifications");
const { createAuthSupportRouter } = require("./routes/authSupport");
const { createOpsSupportRouter } = require("./routes/opsSupport");
const { createWorkersRouter } = require("./routes/workers");
const { createPremiumWalletRouter } = require("./routes/premiumWallet");
const { createContractorStatsRouter } = require("./routes/contractorStats");
const { createUsersProfileRouter } = require("./routes/usersProfile");



// ---------------- EXPRESS & MIDDLEWARE ----------------
const app = express();
// ✅ Trust the first proxy (ngrok)
app.set("trust proxy", 1);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ✅ Attach io to app so routes can access it
app.set('io', io);

app.use(cors());
// Increase body size limits to allow large GeoJSON uploads (557 districts from Full_india.json)
app.use(express.json({ limit: '50mb'}));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
// ⚠️ IMPORTANT: Do NOT use fileUpload() globally - it conflicts with multer!
// We'll use fileUpload only on specific routes where needed
app.use("/uploads", express.static(path.join(__dirname, "uploads"))); 
app.use("/admin", express.static(path.join(__dirname, "public/admin")));

// ✅ Mount wallet routes for deposit/withdraw
const walletRoutes = require("./routes/wallet");
app.use("/wallet", walletRoutes);

// ✅ Mount Razorpay payment routes
const razorpayRoutes = require("./routes/razorpay");
app.use("/api/payment", razorpayRoutes);

// ✅ Mount leaderboard routes (consolidated service with scheduler)
const { router: leaderboardRoutes, startLeaderboardScheduler } = require("./services/leaderboard");
const { startWalletReconciliationScheduler } = require("./services/walletReconciliation");
const { startJobReconciliationScheduler } = require("./services/jobReconciliation");
app.use("/leaderboard", leaderboardRoutes);

// ✅ Mount payout routes for earnings & payouts
const payoutRoutes = require("./routes/payout");
app.use("/api/payouts", payoutRoutes);

// ✅ Mount admin routes for dashboard
const adminRoutes = require("./routes/admin");
app.use("/admin", adminRoutes);

// ✅ Mount upload routes for profile photos and documents
const uploadRoutes = require("./routes/Upload");
app.use("/upload", uploadRoutes);

// ✅ Mount incentive routes for milestone eligibility and rewards
const incentiveRoutes = require("./routes/incentives");
app.use("/incentives", incentiveRoutes);

// Ensure uploads folder exists
const fs = require("fs").promises;
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

// =====================================================================================================
// NOTE: Ola Maps proxy endpoints have been removed. Using MapTiler for maps now.
// =====================================================================================================

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

// ✅ HELPER: Update contractor stats for a given day
async function updateContractorStats(phone) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Fetch today's jobs for this contractor (using phone)
    // ✅ EXCLUDE cancelled jobs from all calculations
    const todayJobs = await Job.find({
      contractorPhone: phone,
      createdAt: { $gte: today },
      isCancelled: { $ne: true } // ✅ Exclude cancelled jobs
    });
    
    const jobsPosted = todayJobs.length;
    const jobsCompleted = todayJobs.filter(j => j.attendanceStatus && j.paymentStatus === 'Paid').length;
    const workersList = [...new Set(todayJobs.map(j => j.acceptedBy).filter(Boolean))];
    const totalSpending = todayJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);
    
    let stats = await ContractorStats.findOne({ phone, date: today });
    if (stats) {
      stats.jobsPosted = jobsPosted;
      stats.jobsCompleted = jobsCompleted;
      stats.workersEngaged = workersList.length;
      stats.totalSpending = totalSpending;
      stats.workersList = workersList;
      stats.updatedAt = new Date();
    } else {
      stats = new ContractorStats({
        phone,
        date: today,
        jobsPosted,
        jobsCompleted,
        workersEngaged: workersList.length,
        totalSpending,
        workersList,
        jobDetails: [],
      });
    }
    await stats.save();
    console.log(`📊 Stats: ${jobsPosted} posted, ${jobsCompleted} completed, ${workersList.length} workers`);
  } catch (err) {
    console.error('Error updating contractor stats:', err);
  }
}

// ✅ HELPER: Emit jobUpdated only to specific users (by name or phone) when possible
async function emitJobUpdatedToUsers(job, userIdentifiers = []) {
  try {
    if (!userIdentifiers || userIdentifiers.length === 0) {
      // No targets provided - fall back to broadcast (rare)
      io.emit("jobUpdated", job);
      return;
    }

    console.log("📨 emitJobUpdatedToUsers called with targets:", userIdentifiers);
    
    // Normalize identifiers
    const ids = userIdentifiers.filter(Boolean).map((i) => i.toString());
    const sentSockets = new Set();

    // ✅ First: Try to find in connectedWorkers (workers register here)
    for (const [socketId, worker] of connectedWorkers.entries()) {
      if (!worker) continue;
      // Match by name or phone
      if (ids.includes(worker.name?.toString()) || ids.includes(worker.phone?.toString())) {
        const targetSocket = io.sockets.sockets.get(socketId);
        if (targetSocket) {
          targetSocket.emit("jobUpdated", job);
          console.log(`📤 Sent targeted jobUpdated to socket ${socketId} for worker ${worker.name || worker.phone}`);
          sentSockets.add(socketId);
        }
      }
    }

    // ✅ Second: Also check ALL connected sockets for contractors (they don't register but are still connected)
    // Match by looking at socket handshake auth tokens
    console.log(`🔍 Checking ${io.sockets.sockets.size} total connected sockets for contractor match...`);
    for (const [socketId, socket] of io.sockets.sockets.entries()) {
      if (sentSockets.has(socketId)) continue; // Already sent to this socket
      
      try {
        // Get user info from socket (set during auth middleware)
        const user = socket.data?.user;
        if (user) {
          console.log(`  Socket ${socketId}: user=${user.name || user.phone}`);
          if (ids.includes(user.name?.toString()) || ids.includes(user.phone?.toString())) {
            socket.emit("jobUpdated", job);
            console.log(`📤 Sent targeted jobUpdated to contractor socket ${socketId} for user ${user.name || user.phone}`);
            sentSockets.add(socketId);
          }
        }
      } catch (e) {
        // Skip if socket doesn't have proper auth data
      }
    }
    
    console.log(`✅ emitJobUpdatedToUsers complete - sent to ${sentSockets.size} sockets`);
  } catch (e) {
    console.error('Error emitting targeted jobUpdated:', e);
    // fallback to broadcast if something goes wrong
    try { io.emit('jobUpdated', job); } catch (err) { console.error('Fallback broadcast failed', err); }
  }
}

async function logJobEvent({
  jobId,
  eventType,
  actorType = "system",
  actorPhone = null,
  source = "system",
  oldState = null,
  newState = null,
  idempotencyKey = null,
  provider = null,
  providerEventId = null,
  reasonCode = null,
  reasonText = null,
  metadata = null,
}) {
  try {
    if (!jobId || !eventType) return;
    await JobEventLog.create({
      jobId,
      eventType,
      actorType,
      actorPhone,
      source,
      oldState,
      newState,
      idempotencyKey,
      provider,
      providerEventId,
      reasonCode,
      reasonText,
      metadata,
      timestamp: new Date(),
    });
  } catch (e) {
    console.error("[job-event] failed:", e && e.message);
  }
}

// Mount extracted lifecycle routes (kept paths unchanged).
app.use(
  "/",
  createJobsLifecycleRouter({
    io,
    trackingJobs,
    pendingJobTimeouts,
    pendingJobExpirations,
    emitJobUpdatedToUsers,
    logJobEvent,
    updateContractorStats,
  })
);
app.use("/", createNotificationsRouter({ io }));
app.use("/", createAuthSupportRouter({ JWT_SECRET, sendNotificationToUserPhone }));
app.use(
  "/",
  createWorkersRouter({
    io,
    connectedWorkers,
    checkJobMatchesForWorker,
    getWorkerGigsSummary,
    sendNotificationToUserPhone,
  })
);
app.use("/", createPremiumWalletRouter({ io }));
app.use("/", createContractorStatsRouter());

// ✅ NEW HELPER: Check if worker (by phone) matches any pending jobs 
// This is used when worker toggles availability, BEFORE they may have socket connected
async function checkJobMatchesForWorker(workerPhone) {
  try {
    console.log(`🔍 [Availability] Checking pending jobs for worker ${workerPhone}...`);
    
    // Fetch worker location and details from database (not socket map)
    const workerRecord = await WorkerModel.findOne({ phone: workerPhone });
    if (!workerRecord) {
      console.log(`⚠️ Worker ${workerPhone} not found in Worker model`);
      return;
    }
    
    // Get skill and wage from User model
    const userRecord = await User.findOne({ phone: workerPhone });
    if (!userRecord || !userRecord.isAvailable) {
      console.log(`⚠️ Worker ${workerPhone} not available in User model`);
      return;
    }
    
    const workerLat = workerRecord.location?.coordinates?.[1];
    const workerLon = workerRecord.location?.coordinates?.[0];
    
    if (!workerLat || !workerLon) {
      console.log(`⚠️ Worker ${workerPhone} has no location data`);
      return;
    }
    
    // Fetch all pending jobs
    const pendingJobs = await Job.find({ status: 'pending' }).limit(20);
    console.log(`📋 [Availability] Checking ${pendingJobs.length} pending jobs for ${workerPhone}...`);
    
    let matchCount = 0;
    for (const job of pendingJobs) {
      // Check if worker has declined this job
      const declinedBy = job.declinedBy || [];
      if (declinedBy.includes(workerRecord.name)) {
        continue;
      }
      
      // Check skill match
      if (job.description && job.description !== userRecord.mainSkill) {
        continue;
      }
      
      // Check wage match (same logic as in findNearbyWorkers)
      const jobAmount = parseInt(job.amount);
      const workerWage = userRecord.expectedWage;
      const ranges = {
        "0-400": { min: 0, max: 400 },
        "400-550": { min: 400, max: 550 },
        "550-700": { min: 550, max: 700 },
        "700-max": { min: 700, max: 999999 }
      };
      const range = ranges[workerWage];
      if (range && !(jobAmount >= range.min && jobAmount <= range.max)) {
        continue;
      }
      
      // Check distance (10km radius)
      const distKm = getDistanceFromLatLonInKm(job.lat, job.lon, workerLat, workerLon);
      if (distKm > 10) {
        continue;
      }
      
      // MATCH FOUND!
      console.log(`✅ [Availability] Worker ${workerPhone} matches job ${job._id} (${job.title}, ₹${job.amount}, ${distKm.toFixed(2)}km away)`);
      matchCount++;
      
      // Offer the job  
      await offerJobToNextWorker(job);
    }
    
    if (matchCount === 0) {
      console.log(`❌ [Availability] No matching jobs found for ${workerPhone}`);
    } else {
      console.log(`✅ [Availability] Offered ${matchCount} jobs to ${workerPhone}`);
    }
  } catch (e) {
    console.error('Error checking job matches for worker:', e);
  }
}

// ✅ HELPER: Offer job to next available worker (dynamic + skip declined)
async function offerJobToNextWorker(job) {
  try {
    const declinedWorkerNames = job.declinedBy || [];
    
    // Clear previous timeout
    if (pendingJobTimeouts.has(job._id.toString())) {
      clearTimeout(pendingJobTimeouts.get(job._id.toString()));
      pendingJobTimeouts.delete(job._id.toString());
    }
    
    // ✅ DYNAMIC: Find nearby workers with SKILL and WAGE MATCHING
    const currentNearbyWorkers = findNearbyWorkers(
      { 
        lat: job.lat, 
        lon: job.lon, 
        mainSkill: job.description, // job.description contains the mainSkill (Labour, Mason, etc)
        amount: job.amount, // Job wage
        workerType: job.workerType
      },
      connectedWorkers
    );
    
    console.log(`🔍 Job Details - Title: ${job.title}, Skill: ${job.description}, Amount: ${job.amount}, Location: (${job.lat}, ${job.lon})`);
    console.log(`🔍 Smart matching: Found ${currentNearbyWorkers.length} nearby workers with matching skill & wage (${declinedWorkerNames.length} declined)`);
    
    // Build list of candidate workers who haven't declined, are online and don't have unpaid jobs
    // ✅ For bulk hiring, also skip workers already in acceptedWorkers
    const acceptedPhones = (job.bulkHiring && job.acceptedWorkers) ? job.acceptedWorkers.map(w => w.phone) : [];
    const candidates = [];
    for (const worker of currentNearbyWorkers) {
      if (declinedWorkerNames.includes(worker.name)) {
        continue; // Skip declined workers
      }
      
      // ✅ For bulk hiring, skip workers who already accepted
      if (job.bulkHiring && acceptedPhones.includes(worker.phone)) {
        console.log(`✅ Worker ${worker.name} (${worker.phone}) already accepted this bulk job, skipping...`);
        continue;
      }
      
      // ✅ CHECK: Is worker online/available in USER model (primary source of truth)?
      const userRecord = await User.findOne({ phone: worker.phone });
      if (!userRecord || !userRecord.isAvailable) {
        console.log(`🔴 Worker ${worker.name} (${worker.phone}) is OFFLINE in User model (isAvailable: ${userRecord?.isAvailable}), skipping...`);
        continue; // Skip offline workers
      }
      
      // ✅ CHECK: Does this worker have an unpaid job? (single or bulk)
      const hasUnpaidJob = await Job.findOne({
        $or: [
          { acceptedBy: worker.phone, paymentStatus: { $ne: "Paid" } },  // Single job
          { "acceptedWorkers.phone": worker.phone, paymentStatus: { $ne: "Paid" } }  // Bulk job
        ]
      });
      
      if (hasUnpaidJob) {
        console.log(`⏭️ Worker ${worker.name} (${worker.phone}) has unpaid job, skipping...`);
        continue; // Skip workers with unpaid jobs
      }
      
      // This worker is available - add to candidates
      candidates.push(worker);
    }
    
    if (!candidates || candidates.length === 0) {
      // No available worker right now - just wait and retry
      console.log(`⏳ No available workers for job ${job._id} - will retry when workers come online`);
      
      // Retry in 30 seconds
      const RETRY_SECONDS = 30;
      const retryTimeoutId = setTimeout(async () => {
        try {
          const jobCheck = await Job.findById(job._id);
          if (jobCheck && jobCheck.status === 'pending') {
            console.log(`🔄 Retrying search for job ${job._id}...`);
            await offerJobToNextWorker(jobCheck);
          }
        } catch (e) {
          console.error('Error in job retry timeout:', e);
        }
      }, RETRY_SECONDS * 1000);
      
      pendingJobTimeouts.set(job._id.toString(), retryTimeoutId);
      return;
    }

    // If this is a bulk hiring job, offer to multiple workers simultaneously up to required slots
    if (job.bulkHiring) {
      const alreadyAccepted = job.acceptedWorkers ? job.acceptedWorkers.length : 0;
      const slots = Math.max(0, (job.requiredWorkers || 1) - alreadyAccepted);
      if (slots <= 0) {
        console.log(`✅ Job ${job._id} already has required workers accepted`);
        return;
      }

      console.log(`📤 Bulk offer: offering to up to ${slots} workers from ${candidates.length} candidates`);
      let offered = 0;
      for (const candidate of candidates) {
        if (offered >= slots) break;
        const workerSocket = io.sockets.sockets.get(candidate.socketId);
        if (!workerSocket) continue;

        try {
          // Double-check distance server-side and stringify _id before emitting
          try {
            const realDist = getDistanceFromLatLonInKm(job.lat, job.lon, candidate.lat, candidate.lon);
            if (realDist <= 10) {
              workerSocket.emit("newJob", {
                ...job.toObject(),
                _id: job._id.toString(),
                id: job._id.toString(),
                distance: Math.round(realDist * 10) / 10,
                totalNearbyWorkers: currentNearbyWorkers.length,
                bulkOffer: true,
              });
              await logJobEvent({
                jobId: job._id,
                eventType: "offer_sent",
                actorType: "system",
                source: "system",
                newState: { status: job.status },
                metadata: {
                  targetPhone: candidate.phone,
                  bulkOffer: true,
                  distanceKm: Math.round(realDist * 100) / 100,
                  amount: job.amount,
                },
              });
            } else {
              console.log(`❌ Skipping emit to ${candidate.name} due to distance ${realDist.toFixed(2)}km (>10km)`);
            }
          } catch (e) {
            console.error('Error while verifying distance before emit (bulk):', e);
          }

          // Send push notification if available
          try {
            const worker = await User.findOne({ phone: candidate.phone });
            if (worker && worker.fcmToken) {
              await sendNotificationToUserPhone(worker.phone, {
                type: 'job_offer',
                title: `New Job: ${job.title}`,
                body: `₹${job.amount} • ${job.workerType || job.description} • ${candidate.distance}km away`,
                jobId: job._id.toString(),
                metadata: { jobTitle: job.title, amount: job.amount, workerType: job.workerType, lat: job.lat, lon: job.lon, actionRequired: true },
              });
            }
          } catch (pushErr) {
            console.error(`❌ Error sending push for bulk candidate ${candidate.phone}:`, pushErr);
          }

          // Set individual timeout to try other workers if not enough acceptances
          const WORKER_TIMEOUT_SECONDS = 60;
          const timeoutId = setTimeout(async () => {
            try {
              const jobCheck = await Job.findById(job._id);
              if (jobCheck && (!jobCheck.bulkHiring || (jobCheck.acceptedWorkers?.length || 0) < (jobCheck.requiredWorkers || 1))) {
                console.log(`⏱️ Bulk candidate ${candidate.name} timeout - retrying offers for job ${job._id}...`);
                await offerJobToNextWorker(jobCheck);
              }
            } catch (e) {
              console.error('Error in bulk job timeout:', e);
            }
          }, WORKER_TIMEOUT_SECONDS * 1000);

          // Store timeout (overwrite previous simple timeout id)
          pendingJobTimeouts.set(job._id.toString(), timeoutId);
          offered++;
          console.log(`⏳ Bulk offer sent to ${candidate.name} (${candidate.phone})`);
        } catch (emitErr) {
          console.error('Error emitting bulk offer to candidate:', emitErr);
        }
      }
      return;
    }

    // Single-offer flow: pick first candidate
    const nextWorker = candidates[0];
    if (!nextWorker) {
      console.log(`⚠️ No single candidate found after filtering for job ${job._id}`);
      return;
    }

    console.log(`📤 Offering job ${job._id} to worker: ${nextWorker.name} (Skill: ${nextWorker.mainSkill}, Wage: ${nextWorker.expectedWage}, Distance: ${nextWorker.distance}km)`);

    const workerSocket = io.sockets.sockets.get(nextWorker.socketId);
    if (workerSocket) {
      // Double-check distance server-side and make sure _id is a string
      try {
        const realDist = getDistanceFromLatLonInKm(job.lat, job.lon, nextWorker.lat, nextWorker.lon);
        if (realDist <= 10) {
          workerSocket.emit("newJob", {
            ...job.toObject(),
            _id: job._id.toString(),
            id: job._id.toString(),
            distance: Math.round(realDist * 10) / 10,
            totalNearbyWorkers: currentNearbyWorkers.length,
          });
          await logJobEvent({
            jobId: job._id,
            eventType: "offer_sent",
            actorType: "system",
            source: "system",
            newState: { status: job.status },
            metadata: {
              targetPhone: nextWorker.phone,
              bulkOffer: false,
              distanceKm: Math.round(realDist * 100) / 100,
              amount: job.amount,
            },
          });
        } else {
          console.log(`❌ Skipping emit to ${nextWorker.name} due to distance ${realDist.toFixed(2)}km (>10km)`);
        }
      } catch (e) {
        console.error('Error while verifying distance before emit (single):', e);
      }
      
      // ✅ ALSO SEND FIREBASE PUSH NOTIFICATION FOR FOREGROUND ALERT
      try {
        const worker = await User.findOne({ phone: nextWorker.phone });
        if (worker && worker.fcmToken) {
          console.log(`📲 Sending Firebase push notification to ${nextWorker.name}...`);
          const pushResult = await sendNotificationToUserPhone(worker.phone, {
            type: 'job_offer',
            title: `New Job: ${job.title}`,
            body: `₹${job.amount} • ${job.workerType || job.description} • ${nextWorker.distance}km away`,
            jobId: job._id.toString(),
            metadata: {
              jobTitle: job.title,
              amount: job.amount,
              workerType: job.workerType,
              lat: job.lat,
              lon: job.lon,
              actionRequired: true,
            },
          });
          
          if (pushResult.success) {
            console.log(`✅ Firebase push sent to ${nextWorker.name}`);
          } else {
            console.warn(`⚠️ Firebase push failed for ${nextWorker.name}:`, pushResult.error);
          }
        } else {
          console.warn(`⚠️ No FCM token for worker ${nextWorker.phone}`);
        }
      } catch (pushErr) {
        console.error(`❌ Error sending Firebase push:`, pushErr);
      }
      
      // Set timeout - if worker doesn't respond, try next one
      const WORKER_TIMEOUT_SECONDS = 60;
      const timeoutId = setTimeout(async () => {
        try {
          const jobCheck = await Job.findById(job._id);
          if (jobCheck && jobCheck.status === 'pending') {
            console.log(`⏱️ Worker ${nextWorker.name} timeout - trying next worker...`);
            await offerJobToNextWorker(jobCheck);
          }
        } catch (e) {
          console.error('Error in job timeout:', e);
        }
      }, WORKER_TIMEOUT_SECONDS * 1000);
      
      pendingJobTimeouts.set(job._id.toString(), timeoutId);
      console.log(`⏳ Timeout set for ${nextWorker.name} (${WORKER_TIMEOUT_SECONDS}s)`);
    } else {
      // Worker not connected - try next one
      console.log(`⚠️ Worker ${nextWorker.name} not connected, trying next...`);
      await offerJobToNextWorker(job);
    }
  } catch (e) {
    console.error('Error offering job to next worker:', e);
  }
}

// ---------------- SOCKET.IO ----------------

// Middleware: optionally verify JWT on socket handshake
io.use(async (socket, next) => {
  try {
    const token = socket.handshake?.auth?.token;
    
    // ✅ Debug logging
    console.log(`🔑 Socket handshake - checking token... token=${token ? 'present (' + token.substring(0,20) + '...)' : 'MISSING'}`);
    
    if (!token) {
      // Allow anonymous sockets; handlers should check socket.user when needed
      console.warn(`⚠️ Socket ${socket.id} connecting WITHOUT token`);
      return next();
    }

    try {
      const user = jwt.verify(token, JWT_SECRET);
      socket.user = user; // { name, phone, role }
      socket.data.user = user; // ✅ Also store in socket.data for easy access
      console.log(`✅ JWT verified for user: ${user.name} (${user.phone})`);

      // Re-associate previous session if any (persisted in Worker model)
      if (user && user.phone) {
        try {
              const existing = await WorkerModel.findOne({ phone: user.phone });
          if (existing) {
            existing.socketId = socket.id;
            // ✅ IMPORTANT: When worker reconnects, mark them as available
            // Only set to true if they had it true before OR first time connecting
            if (!existing.isAvailable) {
              existing.isAvailable = true;
              console.log(`🟢 Worker ${user.phone} marked as AVAILABLE (reconnected)`);
            }
            await existing.save();
            
            // Fetch mainSkill and expectedWage from User model
            let mainSkill = null;
            let expectedWage = null;
            try {
              const userRecord = await User.findOne({ phone: user.phone });
              if (userRecord) {
                mainSkill = userRecord.mainSkill;
                expectedWage = userRecord.expectedWage;
              }
            } catch (e) {
              console.error("Error fetching user mainSkill/expectedWage during reconnection:", e);
            }
            
            // keep a lightweight map for quick access
            connectedWorkers.set(socket.id, {
              name: existing.phone || user.name,
              phone: existing.phone,
              lat: existing.location?.coordinates?.[1] || 0,
              lon: existing.location?.coordinates?.[0] || 0,
              workerType: existing.skills && existing.skills[0],
              mainSkill: mainSkill, // ✅ Fetch from User model
              expectedWage: expectedWage, // ✅ Fetch from User model
              socketId: socket.id,
              isAvailable: existing.isAvailable, // ✅ Now it's true from reconnection
              // Include gigsData summary to help matching service prioritize
              consecutiveDays: existing.gigsData?.consecutiveDays || 0,
              eligibleFor5Days: existing.gigsData?.eligibleFor5Days || false,
              eligibleFor10Days: existing.gigsData?.eligibleFor10Days || false,
            });
            console.log(`🔁 Re-associated existing worker session for ${user.phone}`);
          }
        } catch (e) {
          console.error("Error re-associating worker session:", e);
        }
      }

      return next();
    } catch (err) {
      // Check if token expired vs other error
      if (err.name === "TokenExpiredError") {
        console.warn("🔑 Socket connection with expired token - client should refresh token");
        // Store error info for disconnect handler to notify client
        socket.tokenExpired = true;
        return next();
      } else {
        console.error(`❌ Socket JWT verification FAILED: ${err && err.message}`);
        console.error(`   Error name: ${err?.name}`);
        console.error(`   Token sample: ${token ? token.substring(0, 30) + '...' : 'NO TOKEN PROVIDED'}`);
        // proceed without authentication for other errors
        return next();
      }
    }
  } catch (e) {
    console.error("Socket auth middleware unexpected error:", e);
    return next();
  }
});

io.on("connection", (socket) => {
  console.log("User Connected:", socket.id, "user:", socket.user?.phone || socket.user?.name || "unknown");

  // ✅ Join user to a private room based on their phone number
  // This ensures wallet updates only go to the correct user
  const userPhone = socket.user?.phone;
  if (userPhone) {
    socket.join(userPhone);
    console.log(`✅ Socket ${socket.id} joined room: ${userPhone}`);
  }

  // Check if socket connected with expired token
  if (socket.tokenExpired) {
    socket.emit("tokenExpired", {
      message: "Your authentication token has expired. Please refresh your token and reconnect."
    });
    console.log(`⚠️ Notified client of expired token on socket ${socket.id}`);
  }

  /**
   * Register worker with location data
   * Use authenticated user info rather than trusting client-sent name/phone
   */
  socket.on("registerWorker", async (workerData) => {
    try {
      const { lat, lon, workerType } = workerData || {};
      const user = socket.user || {};
      const name = user.name || workerData?.name || "unknown";
      const phone = user.phone || workerData?.phone || "";

      // ✅ FIX: Validate that phone is authenticated (not empty)
      if (!phone || phone.trim() === "") {
        console.error(`❌ REJECTED registerWorker: No authenticated phone found (socket not properly auth'd)`);
        socket.emit('error', { message: 'Authentication required - please reconnect with valid token' });
        return; // Don't proceed without phone
      }

      // ✅ VALIDATION: Check if coordinates are valid
      if (lat === undefined || lat === null || lon === undefined || lon === null) {
        console.warn(`⚠️ Worker ${name} registered with MISSING coordinates! lat=${lat}, lon=${lon}`);
      }
      
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        console.error(`❌ INVALID coordinates for ${name}! lat=${lat}, lon=${lon} (out of bounds)`);
      }

      console.log("Worker Registered:", name, "at", { lat, lon });

      // Persist session in Worker collection (upsert)
      try {
        const loc = {
          type: "Point",
          coordinates: [lon || 0, lat || 0],
        };

        // Fetch User record to get profilePhoto, mainSkill, expectedWage, and isAvailable
        let profilePhoto = null;
        let mainSkill = null;
        let expectedWage = null;
        let isAvailable = false;
        try {
          const userRecord = await User.findOne({ phone });
          if (userRecord) {
            profilePhoto = userRecord.profilePhoto;
            mainSkill = userRecord.mainSkill;
            expectedWage = userRecord.expectedWage;
            isAvailable = userRecord.isAvailable || false;
          }
        } catch (e) {
          console.error("Error fetching user profile photo for worker:", e);
        }

        const updated = await WorkerModel.findOneAndUpdate(
          { phone },
          { $set: { name, socketId: socket.id, location: loc, profilePhoto } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        connectedWorkers.set(socket.id, {
          name,
          phone,
          lat: lat || 0,
          lon: lon || 0,
          workerType: workerType || (updated.skills && updated.skills[0]),
          mainSkill: mainSkill, // ✅ Fetch from User model
          expectedWage: expectedWage, // ✅ Fetch from User model
          socketId: socket.id,
          isAvailable: isAvailable, // ✅ Now fetches from USER model (source of truth)
          consecutiveDays: updated.gigsData?.consecutiveDays || 0,
          eligibleFor5Days: updated.gigsData?.eligibleFor5Days || false,
          eligibleFor10Days: updated.gigsData?.eligibleFor10Days || false,
        });

        socket.workerName = name;
        socket.workerType = workerType;
        console.log(`✅ Total connected workers: ${connectedWorkers.size}`);

        // ✅ FIX: When worker comes online, immediately check for pending jobs that match their skill/wage
        // This prevents workers from waiting for the 30-second retry timer
        (async () => {
          try {
            const pendingJobs = await Job.find({ status: 'pending' }).limit(10);
            console.log(`🔍 New worker online - checking ${pendingJobs.length} pending jobs for matches...`);
            
            for (const job of pendingJobs) {
              // Check if this worker matches the job requirements
              const matches = findNearbyWorkers(
                { 
                  lat: job.lat, 
                  lon: job.lon, 
                  mainSkill: job.description,
                  amount: job.amount,
                  workerType: job.workerType
                },
                connectedWorkers
              ).some(w => w.phone === phone); // Check if this new worker is in matches

              if (matches) {
                console.log(`✅ Newly connected worker ${phone} matches job ${job._id} - offering immediately...`);
                await offerJobToNextWorker(job);
              }
            }
          } catch (e) {
            console.error('Error checking pending jobs for new worker:', e);
          }
        })();
      } catch (e) {
        console.error("Error saving worker session:", e);
      }
    } catch (e) {
      console.error("registerWorker error:", e);
    }
  });

  /**
   * Update worker location periodically and persist to Worker model
   */
  socket.on("updateWorkerLocation", async (locationData) => {
    try {
      const { lat, lon } = locationData || {};
      if (connectedWorkers.has(socket.id)) {
        const worker = connectedWorkers.get(socket.id);
        worker.lat = lat;
        worker.lon = lon;
        console.log(`📍 Worker location updated: ${worker.name} -> ${lat}, ${lon}`);
      }

      // Update DB record if phone available
      const user = socket.user || {};
      if (user.phone) {
        const updatedWorker = await WorkerModel.findOneAndUpdate(
          { phone: user.phone },
          { $set: { location: { type: "Point", coordinates: [lon || 0, lat || 0] }, socketId: socket.id } },
          { upsert: false, new: true }
        );

        // If this worker is accepted on any active job, forward the updated location to contractor(s) while tracking is active
        try {
          if (updatedWorker) {
            const workerIdStr = updatedWorker._id.toString();
            const job = await Job.findOne({ 'acceptedWorker.id': workerIdStr, status: 'accepted' });
            if (job) {
              const expiry = trackingJobs.get(job._id.toString());
              const now = Date.now();
              if (expiry && now < expiry && !job.attendanceStatus) {
                // update job.acceptedWorker.location and emit jobUpdated
                job.acceptedWorker = job.acceptedWorker || {};
                job.acceptedWorker.location = updatedWorker.location;
                await job.save();
                // Targeted: notify contractor and accepted worker only
                await emitJobUpdatedToUsers(job, [job.contractorName, job.contractorPhone || job.contractorName]);
                console.log(`🔄 Forwarded updated location for worker ${workerIdStr} on job ${job._id}`);
              }

              // ✅ FIXED: Emit only to contractor watching this job (not all clients)
              // Use socket rooms for targeted emission instead of broadcasting
              const contractorRoomId = `contractor_${job.contractorPhone}`;
              io.to(contractorRoomId).emit("workerLocationUpdate", {
                phone: user.phone,
                jobId: job._id.toString(),
                location: updatedWorker.location,
                timestamp: new Date(),
              });
              console.log(`📡 Emitted workerLocationUpdate to contractor ${job.contractorPhone} (room: ${contractorRoomId})`);
            }
          }
        } catch (e) {
          console.error('Error forwarding worker location to job:', e);
        }
      }
    } catch (e) {
      console.error("updateWorkerLocation error:", e);
    }
  });

  /**
   * Socket event for posting job (if used)
   */
  socket.on("postJobSocket", (job) => {
    (async () => {
      try {
        console.log("New job via socket:", job.title);
        // Require authenticated contractor on socket
        const user = socket.user || {};
        if (!user || !user.phone) {
          console.warn('🔒 postJobSocket attempted without auth - ignoring');
          socket.emit('error', { success: false, message: 'Authentication required to post job via socket' });
          return;
        }

        // Minimal validation
        const { title, description, workerType, amount, lat, lon, date } = job || {};
        if (!title || !lat || !lon) {
          socket.emit('error', { success: false, message: 'Missing required job fields' });
          return;
        }

        // Ensure contractor has wallet and sufficient balance if logic desired (mirror /jobs/post)
        try {
          let wallet = await Wallet.findOne({ phone: user.phone });
          if (!wallet) {
            wallet = new Wallet({ phone: user.phone });
            await wallet.save();
          }
          if (wallet.balance < 25) {
            socket.emit('error', { success: false, message: 'Insufficient balance to post job' });
            return;
          }

          // Deduct posting fee
          wallet.balance -= 25;
          wallet.transactions.push({ type: 'job_post_fee', amount: 25, date: new Date() });
          await wallet.save();
        } catch (werr) {
          console.error('Error ensuring wallet for socket job post:', werr);
        }

        const newJob = new Job({
          title,
          description,
          workerType,
          amount,
          contractorName: user.name || user.phone,
          contractorPhone: user.phone, // ✅ Store phone for filtering
          lat,
          lon,
          date: date || new Date(),
          status: 'pending',
          declinedBy: [],
          // ✅ NEW: Set offer expiry to prevent memory leaks
          offerExpiresAt: new Date(Date.now() + 60 * 1000),
        });
        await newJob.save();
        await logJobEvent({
          jobId: newJob._id,
          eventType: "job_posted",
          actorType: "contractor",
          actorPhone: user.phone,
          source: "app",
          newState: { status: newJob.status, paymentStatus: newJob.paymentStatus },
          metadata: { title: newJob.title, amount: newJob.amount, bulkHiring: !!newJob.bulkHiring },
        });

        // ✅ Set overall job expiry: expire offers after 30 minutes if no one accepts (socket job post)
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
              if (jobCheck.status === 'pending' && acceptedCount === 0) {
                const oldState = { status: jobCheck.status, paymentStatus: jobCheck.paymentStatus };
                jobCheck.status = 'expired';
                await jobCheck.save();
                await logJobEvent({
                  jobId: jobCheck._id,
                  eventType: "job_expired",
                  actorType: "system",
                  source: "system",
                  oldState,
                  newState: { status: jobCheck.status, paymentStatus: jobCheck.paymentStatus },
                });
                io.emit('jobCancelled', { ...jobCheck.toObject(), _id: jobCheck._id.toString(), id: jobCheck._id.toString(), status: 'expired', expiredAt: new Date() });
                if (pendingJobTimeouts.has(jobCheck._id.toString())) {
                  clearTimeout(pendingJobTimeouts.get(jobCheck._id.toString()));
                  pendingJobTimeouts.delete(jobCheck._id.toString());
                }
                pendingJobExpirations.delete(jobCheck._id.toString());
              }
            } catch (e) {
              console.error('Error expiring job (socket post):', e);
            }
          }, EXPIRE_MS);
          pendingJobExpirations.set(newJob._id.toString(), expireId);
        } catch (e) {
          console.error('Error scheduling job expiry (socket post):', e);
        }

        // ✅ Set overall job expiry: expire offers after 30 minutes if no one accepts
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
              // Expire only if still pending and no acceptances
              const acceptedCount = jobCheck.bulkHiring ? (jobCheck.acceptedWorkers?.length || 0) : (jobCheck.acceptedBy ? 1 : 0);
              if (jobCheck.status === 'pending' && acceptedCount === 0) {
                const oldState = { status: jobCheck.status, paymentStatus: jobCheck.paymentStatus };
                jobCheck.status = 'expired';
                await jobCheck.save();
                await logJobEvent({
                  jobId: jobCheck._id,
                  eventType: "job_expired",
                  actorType: "system",
                  source: "system",
                  oldState,
                  newState: { status: jobCheck.status, paymentStatus: jobCheck.paymentStatus },
                });
                io.emit('jobCancelled', { ...jobCheck.toObject(), _id: jobCheck._id.toString(), id: jobCheck._id.toString(), status: 'expired', expiredAt: new Date() });
                // Clear any retry timeouts
                if (pendingJobTimeouts.has(jobCheck._id.toString())) {
                  clearTimeout(pendingJobTimeouts.get(jobCheck._id.toString()));
                  pendingJobTimeouts.delete(jobCheck._id.toString());
                }
                pendingJobExpirations.delete(jobCheck._id.toString());
              }
            } catch (e) {
              console.error('Error expiring job:', e);
            }
          }, EXPIRE_MS);
          pendingJobExpirations.set(newJob._id.toString(), expireId);
        } catch (e) {
          console.error('Error scheduling job expiry:', e);
        }

        // ✅ Update contractor's current location when posting job
        // This keeps contractor location fresh and accurate for job prioritization
        try {
          await User.findByIdAndUpdate(
            user.id,
            {
              latitude: lat,
              longitude: lon,
              locationLastUpdated: new Date()
            }
          );
          console.log(`📍 Updated contractor location: (${lat}, ${lon})`);
        } catch (err) {
          console.warn('⚠️ Warning: Could not update contractor location:', err.message);
          // Don't fail job posting - location update is non-critical
        }

        console.log(`📢 Job ${newJob._id} posted. Will search for nearby workers when offering...`);

        // ✅ Start offering to nearby workers (dynamic search)
        try {
          await offerJobToNextWorker(newJob);
        } catch (e) {
          console.error('Error offering job after socket post:', e);
        }

        // Acknowledge to contractor socket
        socket.emit('postedJob', { success: true, job: newJob });
      } catch (e) {
        console.error('Error handling postJobSocket:', e);
        try { socket.emit('error', { success: false, message: 'Internal server error' }); } catch (err) {}
      }
    })();
  });

  socket.on("jobAction", async ({ jobId }) => {
    let job = await Job.findOne({ id: jobId });
    if (!job) job = await Job.findById(jobId);
    if (job) {
      const payload = {
        ...job.toObject(),
        _targetedUpdate: true,
        targetedFor: [job.contractorName, job.acceptedBy || job.contractorName]
      };
      await emitJobUpdatedToUsers(payload, [job.contractorName, job.acceptedBy || job.contractorName]);
    }
  });

  socket.on("disconnect", async () => {
    const worker = connectedWorkers.get(socket.id);
    if (worker) {
      console.log(`❌ Worker disconnected: ${worker.name}`);
      connectedWorkers.delete(socket.id);
      console.log(`✅ Total connected workers now: ${connectedWorkers.size}`);

      // Clear socketId in DB for this worker
      try {
        await WorkerModel.findOneAndUpdate({ socketId: socket.id }, { $set: { socketId: "", isAvailable: false } });
      } catch (e) {
        console.error("Error clearing worker session on disconnect:", e);
      }
    } else {
      console.log("Disconnected:", socket.id);
    }
  });
});

// ✅ MULTER FOR PROFILE UPLOAD (Auth middleware is imported from utils/auth.js)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ 
  storage,
  // Increase file size limits
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB max file size
});
app.use("/", createOpsSupportRouter({ upload, PORT }));
app.use(
  "/",
  createUsersProfileRouter({ upload, io, connectedWorkers, getPublicBaseUrl })
);

// ---------------- NEW ROUTE: UPLOAD PROFILE PHOTO ----------------
// users photo/update routes moved to routes/usersProfile.js

// ---------------- USER ROUTES ----------------
app.post("/users/register", async (req, res) => {
  try {
    const { name, phone, password, role, agreedToTerms, termsVersion, latitude, longitude, fcmToken, deviceId, appVersion, termsHash } = req.body;
    if (!name || !phone || !password || !role)
      return res.status(400).json({ success: false, message: "All fields required" });

    // ✅ Validate password strength on backend
    if (!password || password.length < 8) {
      return res.status(400).json({ success: false, message: "Password must be at least 8 characters long" });
    }
    if (!/\d/.test(password)) {
      return res.status(400).json({ success: false, message: "Password must contain at least one number" });
    }
    if (!/[A-Z]/.test(password)) {
      return res.status(400).json({ success: false, message: "Password must contain at least one uppercase letter" });
    }
    if (!/[a-z]/.test(password)) {
      return res.status(400).json({ success: false, message: "Password must contain at least one lowercase letter" });
    }

    // ✅ Validate terms agreement
    if (!agreedToTerms) {
      return res.status(400).json({ success: false, message: "Must agree to Terms and Conditions" });
    }

    const existingUser = await User.findOne({ phone });
    if (existingUser) return res.status(400).json({ success: false, message: "Phone already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ 
      name, 
      phone, 
      password: hashedPassword, 
      role,
      agreedToTerms: true, // ✅ Save agreement status
      agreedToTermsAt: new Date(), // ✅ Save when user agreed
      fcmToken: fcmToken || null, // ✅ Store FCM token from registration
    });

    // ✅ NOTE: Location is NOT stored during registration
    // Location will be obtained during login to prevent spoofing
    // Removing latitude/longitude from registration request

    await newUser.save();

    let wallet = await Wallet.findOne({ phone });
    if (!wallet) {
      wallet = new Wallet({ phone });
      await wallet.save();
    }

    // ✅ NEW: Create Worker record for worker role users
    if (role === "worker") {
      const existingWorker = await WorkerModel.findOne({ phone });
      if (!existingWorker) {
        const newWorker = new WorkerModel({
          phone,
          skills: [],
          rating: 5,
          isAvailable: false,
          location: { type: "Point", coordinates: [0, 0] },
        });
        await newWorker.save();
        console.log(`✅ Worker record created for ${name} (${phone})`);
      }
    }

    // ✅ SECURITY: Log terms agreement cryptographically
    try {
      const termsAudit = require('./utils/termsAudit');
      const auditResult = await termsAudit.logTermsAgreement(req, {
        phone,
        termsVersion: termsVersion || '1.0',
        role,
        appVersion: appVersion || 'unknown',
        deviceId: deviceId || '',
        termsHash: termsHash || '',
      });
      
      if (!auditResult.success && auditResult.isDuplicate) {
        // User somehow registered twice - log but continue
        console.warn(`⚠️ [Register] Duplicate terms agreement for ${phone}, but proceeding with registration`);
      }
    } catch (termsErr) {
      console.error('❌ [Register] Error logging terms agreement:', termsErr.message);
      // Continue registration even if terms audit fails (non-blocking)
    }

    // issue refresh token and access token
    const accessToken = jwt.sign({ name, phone, role }, JWT_SECRET, { expiresIn: "1h" });
    const refreshToken = require("crypto").randomBytes(40).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days
    newUser.refreshTokens.push({ token: refreshToken, issuedAt: new Date(), expiresAt, deviceInfo: req.headers['user-agent'] || 'unknown' });
    await newUser.save();

    return res.json({ success: true, user: { name, phone, role }, accessToken, refreshToken });
  } catch (err) {
    // ✅ HANDLE: E11000 duplicate key error
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern || {})[0];
      console.error(`❌ E11000 Duplicate Key Error: ${field} already exists`, err.keyValue);
      return res.status(400).json({ 
        success: false, 
        message: `${field} already registered. Please login instead.`
      });
    }
    console.error("Register error", err.message || err);
    return res.status(500).json({ success: false, message: "Registration failed. Please try again." });
  }
});

app.post("/login", loginLimiter, async (req, res) => {
  try {
    console.log("📱 Login request body:", req.body);
    console.log("📝 Headers:", req.headers);
    const { phone, password, latitude, longitude, fcmToken } = req.body; // ✅ Add fcmToken
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: "Phone and password required" });
    }
    const user = await User.findOne({ phone });
    if (!user) return res.status(401).json({ success: false, message: "Invalid phone or password" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: "Invalid phone or password" });

    // ✅ NEW: Store updated FCM token on login
    if (fcmToken) {
      user.fcmToken = fcmToken;
      console.log(`📱 FCM Token updated for ${phone}: ${fcmToken.substring(0, 30)}...`);
    }

    // ✅ NEW: Handle location for all users (workers AND contractors) during login
    let cityLeaderboard = null;
    // ✅ NEW: Efficient location handling using district polygons
    // No Nominatim API needed - direct geospatial lookup
    // ✅ FIX: Use !== null instead of && to handle 0 coordinates correctly
    if (latitude !== undefined && latitude !== null && longitude !== undefined && longitude !== null) {
      try {
        const parsedLat = parseFloat(latitude);
        const parsedLon = parseFloat(longitude);
        
        // ✅ Skip if coordinates are invalid (NaN)
        if (isNaN(parsedLat) || isNaN(parsedLon)) {
          console.warn(`⚠️ Invalid coordinates: lat=${latitude}, lon=${longitude}`);
        } else {
          console.log(`📍 Finding district for ${user.role} at: lat=${parsedLat}, lon=${parsedLon}`);

          // Find district polygon containing the user's GPS point
          const District = require('./models/City'); // File is City.js, exports as "District" model
          const point = {
            type: 'Point',
            coordinates: [parsedLon, parsedLat],
          };

          // ✅ DEBUG: Check district count
          try {
            const districtCount = await District.countDocuments();
            if (districtCount === 0) {
              console.warn(`⚠️ [Login] No districts in database - import via POST /admin/districts/import-geojson`);
              user.city = 'Unknown';
              user.state = 'Unknown';
            } else {
              let district = await District.findOne({
                geometry: {
                  $geoIntersects: {
                    $geometry: point,
                  },
                },
              }).lean();

              // ✅ FALLBACK: If no exact district match, find nearest district by centroid
              if (!district) {
                console.warn(`⚠️ [Login] No exact polygon match for [${parsedLon}, ${parsedLat}], trying nearest centroid...`);
                district = await District.findOne(
                  {
                    centroid: {
                      $nearSphere: {
                        $geometry: point,
                        $maxDistance: 50000, // 50km radius fallback
                      },
                    },
                  },
                  null,
                  { lean: true }
                );

                if (district) {
                  console.log(`✅ [Login] Found nearest district by centroid: ${district.name}, ${district.state} (fallback match)`);
                }
              }

              if (district) {
                user.city = district.name;
                user.state = district.state;
                console.log(`✅ [Login] Found district: ${district.name}, ${district.state}`);
              } else {
                console.warn(`⚠️ [Login] No district found for coordinates [${parsedLon}, ${parsedLat}] - using Unknown`);
                user.city = 'Unknown';
                user.state = 'Unknown';
              }
            }
          } catch (distErr) {
            console.error('❌ [Login] Error querying districts:', distErr.message);
            user.city = 'Unknown';
            user.state = 'Unknown';
          }

          // ✅ Always update coordinates and save after district lookup
          user.latitude = parsedLat;
          user.longitude = parsedLon;
          user.location = {
            type: 'Point',
            coordinates: [parsedLon, parsedLat],
          };
          user.locationLastUpdated = new Date();
          user.locationEnabled = true; // ✅ Mark location as enabled when coordinates provided during login
          
          try {
            await user.save();
            console.log(`✅ [Login] Location saved for ${user.role}: lat=${parsedLat}, lon=${parsedLon}, city=${user.city}`);
          } catch (saveErr) {
            console.error('⚠️ [Login] Error saving location:', saveErr.message);
          }
        }
      } catch (err) {
        console.error('❌ Error finding district:', err.message);
        // Continue with login even if district lookup fails
      }
    }

    // issue access + refresh token
    const accessToken = jwt.sign({ name: user.name, phone: user.phone, role: user.role, id: user._id }, JWT_SECRET, { expiresIn: "1h" });
    const refreshToken = require("crypto").randomBytes(40).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days
    user.refreshTokens.push({ token: refreshToken, issuedAt: new Date(), expiresAt, deviceInfo: req.headers['user-agent'] || 'unknown' });
    await user.save();

    // Ensure wallet exists
    let wallet = await Wallet.findOne({ phone: user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: user.phone });
      await wallet.save();
      console.log(`✅ Auto-created wallet for ${user.phone} on login`);
    }

    const response = {
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        profilePhoto: user.profilePhoto,
        city: user.city,
        state: user.state,
        latitude: user.latitude,
        longitude: user.longitude,
        premiumPlan: user.premiumPlan, // ✅ ADD: Include premium plan data
        isAvailable: user.isAvailable || false, // ✅ ADD: Include worker availability status
      },
      accessToken,
      refreshToken,
    };

    // ✅ NEW: Add leaderboard data for contractors
    if (cityLeaderboard) {
      response.leaderboard = cityLeaderboard;
    }

    return res.json(response);
  } catch (err) {
    console.error("Login error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ✅ POST: Request OTP for password reset
// auth forgot-password routes moved to routes/authSupport.js

// users list/profile routes moved to routes/usersProfile.js

// GET: Find nearby workers for contractor (uses worker's GeoJSON location)
// workers nearby/request routes moved to routes/workers.js

// premium/wallet/leaderboard routes moved to routes/premiumWallet.js

// OTP/auth support routes moved to routes/authSupport.js

// ---------------- JOB ROUTES ----------------
// ✅ UPLOAD JOB IMAGE
app.post("/jobs/upload-image", authenticateToken, fileUpload(), async (req, res) => {
  try {
    if (!req.files || !req.files.photo) {
      return res.status(400).json({ success: false, message: "No image provided" });
    }

    const file = req.files.photo;
    const filename = `job-${Date.now()}-${Math.random().toString(36).substr(2, 9)}.jpg`;
    const uploadPath = path.join(__dirname, 'uploads', filename);

    await file.mv(uploadPath);

    // Return stable public URL (works across devices)
    const serverURL = getPublicBaseUrl(req);
    const imageUrl = `${serverURL}/uploads/${filename}`;
    
    console.log(`✅ Job image uploaded: ${imageUrl}`);
    res.json({ success: true, imageUrl });
  } catch (err) {
    console.error("Job image upload error:", err);
    res.status(500).json({ success: false, message: "Failed to upload job image" });
  }
});

app.post("/jobs/post", authenticateToken, async (req, res) => {
  try {
    const { title, description, workerType, amount, lat, lon, date, imageUrl, startTime, endTime, bulkHiring, requiredWorkers } = req.body;
    const contractorName = req.user.name;

    if (!title || !lat || !lon || lat === 0 || lon === 0)
      return res.status(400).json({ success: false, message: "Missing required fields: title, lat, lon must be provided and non-zero" });

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone });
      await wallet.save();
    }

    // 💰 Calculate required posting fee based on bulk hiring
    const workersCount = (bulkHiring === true || bulkHiring === 'true') ? (parseInt(requiredWorkers) || 1) : 1;
    const requiredBalance = workersCount * 25;

    if (wallet.balance < requiredBalance) {
      return res.status(400).json({
        success: false,
        message: `Insufficient wallet balance. You need ₹${requiredBalance} to post this job for ${workersCount} worker(s). Current balance: ₹${wallet.balance}`
      });
    }

    // ✅ Deduct dynamic fee based on number of workers
    wallet.balance -= requiredBalance;
    wallet.transactions.push({
      type: "job_post_fee",
      amount: requiredBalance,
      workersCount: workersCount,
      date: new Date(),
    });
    await wallet.save();

    const newJob = new Job({
      // ✅ MongoDB auto-generates _id - no need for custom id field
      title,
      description,
      workerType,
      amount,
      contractorName,
      contractorPhone: req.user.phone, // ✅ Also store phone for reference
      imageUrl: imageUrl || null, // ✅ Store job image URL
      lat,
      lon,
      date: date || new Date(),
      startTime: startTime || null, // ✅ Store start time
      endTime: endTime || null, // ✅ Store end time
      bulkHiring: bulkHiring === true || bulkHiring === 'true' || false,
      requiredWorkers: parseInt(requiredWorkers) || 1,
      status: "pending",
      declinedBy: [],
      // ✅ NEW: Set offer expiry to prevent memory leaks
      // Offer expires in 60 seconds (allows cleanup scheduler to find stale timeouts)
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

    // Expire job if still unaccepted after configured window
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
            io.emit("jobCancelled", {
              ...jobCheck.toObject(),
              _id: jobCheck._id.toString(),
              id: jobCheck._id.toString(),
              status: "expired",
              expiredAt: new Date(),
            });
            if (pendingJobTimeouts.has(jobCheck._id.toString())) {
              clearTimeout(pendingJobTimeouts.get(jobCheck._id.toString()));
              pendingJobTimeouts.delete(jobCheck._id.toString());
            }
            pendingJobExpirations.delete(jobCheck._id.toString());
          }
        } catch (e) {
          console.error("Error expiring HTTP posted job:", e);
        }
      }, EXPIRE_MS);
      pendingJobExpirations.set(newJob._id.toString(), expireId);
    } catch (e) {
      console.error("Error scheduling HTTP job expiry:", e);
    }

    // ✅ Update contractor's current location when posting job
    // This keeps contractor location fresh and accurate for job prioritization
    try {
      await User.findByIdAndUpdate(
        req.user.id,
        {
          latitude: lat,
          longitude: lon,
          locationLastUpdated: new Date()
        }
      );
      console.log(`📍 Updated contractor location: (${lat}, ${lon})`);
    } catch (err) {
      console.warn('⚠️ Warning: Could not update contractor location:', err.message);
      // Don't fail job posting - location update is non-critical
    }

    console.log(`📢 New job posted: ${title} (ID: ${newJob._id}) at (${lat}, ${lon}) - type: ${workerType}`);

    // ✅ AUTO-UPDATE CONTRACTOR STATS
    await updateContractorStats(req.user.phone);

    // ✅ Job posted successfully
    console.log(`📢 Job ${newJob._id} posted at (${lat}, ${lon})`);

    // ✅ Start offering to nearby workers (dynamic search)
    try {
      await offerJobToNextWorker(newJob);
    } catch (e) {
      console.error('Error offering job after HTTP post:', e);
    }

    return res.json({ 
      success: true, 
      job: newJob, 
      wallet,
      message: "Job posted. Searching for nearby workers..."
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ---------------- ACCEPT / DECLINE ----------------
app.post("/jobs/accept/:id", authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const workerName = req.user.name;
    const workerPhone = req.user.phone; // ✅ Get phone instead

    console.log(`✅ Accept request for job: ${jobId} by worker: ${workerName} (phone: ${workerPhone})`);

    // ✅ CHECK: Worker cannot accept multiple simultaneous jobs (both single and bulk)
    // Find if worker has any unpaid job
    const hasUnpaidJob = await Job.findOne({
      $or: [
        { acceptedBy: workerPhone, paymentStatus: { $ne: "Paid" } },  // Single job unpaid
        { "acceptedWorkers.phone": workerPhone, paymentStatus: { $ne: "Paid" } }  // Bulk job unpaid
      ]
    });

    if (hasUnpaidJob) {
      console.log(`❌ Worker ${workerName} (${workerPhone}) already has unpaid job: ${hasUnpaidJob._id}`);
      return res.status(400).json({
        success: false,
        message: `You have an unpaid job (${hasUnpaidJob.title}). Complete or decline it first.`
      });
    }

    // Build acceptedWorker snapshot (if worker record exists)
    let acceptedWorkerSnapshot = null;
    try {
      const workerRecord = await WorkerModel.findOne({ phone: req.user.phone });
      const userRecord = await User.findOne({ phone: req.user.phone }); // ✅ Get profile photo from User model
      
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

    // Fetch job
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    // Re-check unpaid jobs for this worker (both single and bulk)
    const hasUnpaidJobSingle = await Job.findOne({ acceptedBy: workerPhone, paymentStatus: { $ne: "Paid" } });
    const hasUnpaidJobBulk = await Job.findOne({ "acceptedWorkers.phone": workerPhone, paymentStatus: { $ne: "Paid" } });
    if (hasUnpaidJobSingle || hasUnpaidJobBulk) {
      return res.status(400).json({ success: false, message: "You have an unpaid job. Complete or decline it first." });
    }

    // Handle bulk hiring acceptance
    if (job.bulkHiring) {
      // ✅ ATOMIC: Use $addToSet to prevent duplicates + race conditions
      // This prevents two workers from adding themselves twice in concurrent requests
      const updated = await Job.findOneAndUpdate(
        {
          _id: jobId,
          bulkHiring: true,
          // Ensure this worker hasn't already accepted (checked via $addToSet behavior)
          "acceptedWorkers.phone": { $ne: workerPhone }
        },
        {
          $addToSet: { acceptedWorkers: acceptedWorkerSnapshot }
        },
        { new: true }
      );

      // If worker already accepted, update will return null
      if (!updated) {
        const checkJob = await Job.findById(jobId);
        if (checkJob && checkJob.acceptedWorkers?.find(w => w.phone === workerPhone)) {
          return res.status(400).json({ success: false, message: "You have already accepted this job" });
        }
        // If job doesn't exist or other error
        return res.status(400).json({ success: false, message: "Could not accept job" });
      }

      const job = updated; // Use the updated job document
      await logJobEvent({
        jobId: job._id,
        eventType: "job_accepted",
        actorType: "worker",
        actorPhone: workerPhone,
        source: "app",
        oldState: { status: job.status },
        newState: { status: job.status },
        metadata: { bulkHiring: true, acceptedCount: job.acceptedWorkers?.length || 0, requiredWorkers: job.requiredWorkers || 1 },
      });

      // Track acceptance
      try {
        await updateGigDataOnAcceptance(workerPhone, {
          jobId: job._id.toString(),
          title: job.title,
          amount: job.amount,
          workerType: job.workerType
        });
      } catch (e) {
        console.error("❌ Error updating gigs data on acceptance:", e);
      }

      // Check if required workers count reached
      const acceptedCount = job.acceptedWorkers?.length || 0;
      const requiredCount = job.requiredWorkers || 1;
      const jobFinalized = acceptedCount >= requiredCount && job.status !== 'accepted';

      // If required reached, finalize job atomically
      if (jobFinalized) {
        const finalized = await Job.findOneAndUpdate(
          { _id: jobId, status: { $ne: 'accepted' } }, // Only update if not already finalized
          {
            $set: {
              status: 'accepted',
              acceptedBy: job.acceptedWorkers[0]?.phone || workerPhone,
              acceptedWorker: job.acceptedWorkers[0] || acceptedWorkerSnapshot,
              acceptedAt: job.acceptedAt || new Date()
            }
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
            oldState: { status: job.status },
            newState: { status: finalized.status, acceptedBy: finalized.acceptedBy },
            metadata: { bulkHiring: true, finalized: true, acceptedCount, requiredCount },
          });
          console.log(`✅ Bulk job ${jobId} FINALIZED with ${acceptedCount} workers`);
          // Clean up timeouts
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

      // Notify contractor about updated accepted count
      try {
        await NotificationHistory.create({
          recipientPhone: job.contractorPhone,
          senderPhone: req.user.phone,
          senderName: workerName || req.user.name,
          type: 'job_accepted',
          title: `Worker Accepted: ${job.title}`,
          body: `${workerName} accepted your job. ${acceptedCount}/${requiredCount} accepted.`,
          jobId: job._id.toString(),
          metadata: { acceptedCount, requiredWorkers: requiredCount },
          deepLink: `contractor/jobs/${job._id.toString()}`,
          pushNotificationSent: false,
        });
      } catch (e) {
        console.error('Error creating job acceptance notification for contractor:', e);
      }

      // Emit targeted update with accepted workers list
      const payload = { ...job.toObject(), _targetedUpdate: true, targetedFor: [job.contractorName] };
      await emitJobUpdatedToUsers(payload, [job.contractorName]);

      return res.json({ success: true, message: "Job accepted successfully", job });
    }

    // Non-bulk: Atomic update: only accept if status is still 'pending'
    const updated = await Job.findOneAndUpdate(
      { _id: jobId, status: "pending" },
      { $set: { status: "accepted", acceptedBy: workerPhone, acceptedWorker: acceptedWorkerSnapshot, acceptedAt: new Date() } }, // ✅ Use phone
      { new: true }
    );

    if (!updated) {
      console.log(`❌ Job ${jobId} was already taken or not found`);
      return res.status(400).json({ success: false, message: "Job already accepted or not found" });
    }

    console.log(`✅ Job accepted successfully by ${workerName} (phone: ${workerPhone})`);
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

    // ✅ TRACK: Update gigs data on job acceptance
    try {
      await updateGigDataOnAcceptance(workerPhone, {
        jobId: updated._id.toString(),
        title: updated.title,
        amount: updated.amount,
        workerType: updated.workerType
      });
      console.log(`✅ Gigs data updated for acceptance by ${workerPhone}`);
    } catch (e) {
      console.error("❌ Error updating gigs data on acceptance:", e);
      // Don't fail the request if tracking fails
    }

    // ✅ Create notification for contractor
    try {
      const jobTitle = updated.title;
      const amount = updated.amount;
      await NotificationHistory.create({
        recipientPhone: updated.contractorPhone,
        senderPhone: req.user.phone,
        senderName: workerName || req.user.name,
        type: 'job_accepted',
        title: `Job Accepted: ${jobTitle}`,
        body: `${workerName} accepted your ₹${amount} job`,
        jobId: updated._id.toString(),
        metadata: {
          jobTitle: jobTitle,
          amount: amount,
          actionRequired: true
        },
        deepLink: `contractor/jobs/${updated._id.toString()}`,
        pushNotificationSent: false,
      });
      console.log(`📬 Notification sent to contractor for job acceptance`);
    } catch (e) {
      console.error('Error creating job acceptance notification for contractor:', e);
    }

    // ✅ Create notification for worker - confirming they accepted the job
    try {
      if (updated.acceptedWorker && updated.acceptedWorker.phone) {
        const jobTitle = updated.title;
        const amount = updated.amount;
        await NotificationHistory.create({
          recipientPhone: updated.acceptedWorker.phone,
          senderPhone: updated.contractorPhone,
          senderName: updated.contractorName || 'Contractor',
          type: 'job_accepted',
          title: `Job Confirmed: ${jobTitle}`,
          body: `You accepted a ₹${amount} job. You have ₹${amount} in pending payment.`,
          jobId: updated._id.toString(),
          metadata: {
            jobTitle: jobTitle,
            amount: amount,
            actionRequired: true
          },
          deepLink: `worker/jobs/${updated._id.toString()}`,
          pushNotificationSent: false,
        });
        console.log(`📬 Notification sent to worker for job acceptance confirmation`);
      }
    } catch (e) {
      console.error('Error creating job acceptance notification for worker:', e);
    }

    // ✅ TARGETED UPDATE: Only notify contractor and worker (NOT all 1 lakh workers!)
    // Contractor needs to know job is accepted (update their posted jobs list)
    // Worker who accepted needs confirmation
    // Other workers shouldn't receive this update at all
    // Targeted update: notify only contractor and accepting worker
    const acceptPayload = {
      ...updated.toObject(),
      _targetedUpdate: true,
      targetedFor: [updated.contractorName, workerName]
    };
    await emitJobUpdatedToUsers(acceptPayload, [updated.contractorName, workerName]);

    // ✅ Cancel worker timeout since job was accepted
    if (pendingJobTimeouts.has(jobId)) {
      clearTimeout(pendingJobTimeouts.get(jobId));
      pendingJobTimeouts.delete(jobId);
      console.log(`✅ Cancelled timeout for accepted job ${jobId}`);
    }
    if (pendingJobExpirations.has(jobId)) {
      clearTimeout(pendingJobExpirations.get(jobId));
      pendingJobExpirations.delete(jobId);
      console.log(`✅ Cancelled expiry timer for accepted job ${jobId}`);
    }

    // Start forwarding location updates for this job for a limited time (10 minutes)
    try {
      const TRACK_MINUTES = Number(process.env.TRACK_MINUTES) || 10;
      trackingJobs.set(jobId, Date.now() + TRACK_MINUTES * 40 * 1000);
      console.log(`🚩 Started location tracking for job ${jobId} for ${TRACK_MINUTES} minutes`);
    } catch (e) {
      console.error("Error starting tracking for job", e);
    }
    return res.json({ success: true, message: "Job accepted successfully", job: updated });
  } catch (err) {
    console.error("❌ Accept error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/jobs/decline/:id", authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const workerName = req.user.name;
    const workerPhone = req.user.phone;

    console.log(`📋 Decline request for job: ${jobId} by worker: ${workerName}`);

    const job = await Job.findById(jobId);
    console.log(`🔍 Job found: ${job ? "YES" : "NO"}`);
    
    if (!job) {
      console.log(`❌ Job not found with ID: ${jobId}`);
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    if (!job.declinedBy.includes(workerName)) {
      job.declinedBy.push(workerName);
    }
    
    // If job was accepted by this worker (single) or part of bulk acceptedWorkers, update accordingly
    if (job.bulkHiring) {
      // Remove from acceptedWorkers if present
      const before = job.acceptedWorkers ? job.acceptedWorkers.length : 0;
      job.acceptedWorkers = (job.acceptedWorkers || []).filter(w => w.phone !== workerPhone);
      const after = job.acceptedWorkers.length;

      if (after < before) {
        console.log(`🔄 Removed worker ${workerPhone} from acceptedWorkers (${before} → ${after})`);
        // If job was finalized and now has fewer than required, revert to pending
        if (job.status === 'accepted' && after < (job.requiredWorkers || 1)) {
          job.status = 'pending';
          job.acceptedBy = null;
          job.acceptedWorker = null;
          job.acceptedAt = null;
          if (trackingJobs.has(jobId)) trackingJobs.delete(jobId);
        }

        // ✅ TRACK: Update gigs data on job cancellation for this worker
        try {
          await updateGigDataOnCancellation(workerPhone, {
            jobId: job._id.toString(),
            title: job.title,
            amount: job.amount,
            workerType: job.workerType
          });
          console.log(`✅ Gigs data updated for cancellation by ${workerPhone}`);
        } catch (e) {
          console.error("❌ Error updating gigs data on cancellation:", e);
        }
        // Also record a cancelled workday entry for milestone tracking
        try {
          const worker = await WorkerModel.findOne({ phone: workerPhone });
          if (worker && typeof worker.recordWork === 'function') {
            worker.recordWork(new Date(), 0, true);
            await worker.save();
            console.log(`📉 Recorded cancellation for ${workerPhone} in workHistory`);
          }
        } catch (recErr) {
          console.error('Error recording work cancellation on decline:', recErr);
        }
      }
    } else {
      // Single accept flow
      if (job.acceptedBy === workerPhone && job.status === "accepted") {
        job.status = "pending";
        job.acceptedBy = null;
        job.acceptedWorker = null;
        job.acceptedAt = null;
        // Stop tracking location for this declined job
        if (trackingJobs.has(jobId)) {
          trackingJobs.delete(jobId);
        }
        
        // ✅ TRACK: Update gigs data on job cancellation
        try {
          await updateGigDataOnCancellation(workerPhone, {
            jobId: job._id.toString(),
            title: job.title,
            amount: job.amount,
            workerType: job.workerType
          });
          console.log(`✅ Gigs data updated for cancellation by ${workerPhone}`);
        } catch (e) {
          console.error("❌ Error updating gigs data on cancellation:", e);
          // Don't fail the request if tracking fails
        }
        // Record cancellation for milestone tracking
        try {
          const worker = await WorkerModel.findOne({ phone: workerPhone });
          if (worker && typeof worker.recordWork === 'function') {
            worker.recordWork(new Date(), 0, true);
            await worker.save();
            console.log(`📉 Recorded cancellation for ${workerPhone} in workHistory`);
          }
        } catch (recErr) {
          console.error('Error recording work cancellation on decline (single):', recErr);
        }
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

    console.log(`✅ Job declined successfully by ${workerName}`);
    // Targeted: notify contractor and declining worker only
    await emitJobUpdatedToUsers(job, [job.contractorName, workerName]);
    
    // ✅ SIMPLIFIED: Move to next worker in sequence
    if (job.status === 'pending') {
      try {
        await offerJobToNextWorker(job);
      } catch (e) {
        console.error('Error offering to next worker after decline:', e);
      }
    }
    
    return res.json({ success: true, message: "Job declined successfully", job });
  } catch (err) {
    console.error("❌ Decline error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ---------------- NEARBY JOBS ----------------
app.post("/jobs/nearby", authenticateToken, async (req, res) => {
  try {
    const { lat, lon, workerType } = req.body;
    const workerPhone = req.user.phone;  // ✅ Use phone, not name
    const workerName = req.user.name;
    const MAX_RADIUS_KM = 10; // Maximum search radius

    let jobs = await Job.find();
    
    // ✅ CHECK: Does worker have an active unpaid job? (both single and bulk)
    const hasActiveUnpaidJob = jobs.some(
      (job) => (job.acceptedBy === workerPhone || job.acceptedWorkers?.some(w => w.phone === workerPhone)) && job.paymentStatus !== "Paid"
    );
    
    // If worker has active unpaid job, return empty array (block all new jobs)
    if (hasActiveUnpaidJob) {
      console.log(`🔴 Worker ${workerName} (${workerPhone}) has unpaid job - blocking new job offers`);
      return res.json([]);
    }
    
    const availableJobs = jobs.filter(
      (j) =>
        j.status !== "accepted" &&
        (!workerType || j.workerType?.toLowerCase() === workerType?.toLowerCase()) &&
        !(j.declinedBy && j.declinedBy.includes(workerName))
    );

    // Calculate distances and filter by radius
    const jobsWithDistance = [];
    for (const j of availableJobs) {
      const distanceToJob = getDistanceFromLatLonInKm(lat, lon, j.lat, j.lon);
      
      // Skip jobs beyond 10km radius
      if (distanceToJob > MAX_RADIUS_KM) {
        continue;
      }
      
      // ✅ FIXED: Use job's location (always fresh, contractor posted from there)
      // Job location = Contractor's actual location when posting
      // This avoids stale contractor location data from User model (last login)
      const distanceToContractor = distanceToJob; // Job location is contractor's actual location
      
      jobsWithDistance.push({
        ...j.toObject ? j.toObject() : j,
        distanceToJob,
        distanceToContractor
      });
    }

    // Sort by contractor proximity first, then job proximity
    // Since distanceToContractor = distanceToJob, this effectively sorts by job proximity
    jobsWithDistance.sort((a, b) => {
      // Primary: sort by distance to contractor (which is job location - always fresh)
      if (a.distanceToContractor !== b.distanceToContractor) {
        return a.distanceToContractor - b.distanceToContractor;
      }
      // Tiebreaker: same as primary (both use job location)
      return a.distanceToJob - b.distanceToJob;
    });

    return res.json(jobsWithDistance);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Internal server error" });
  }
});

app.get("/jobs", authenticateToken, async (req, res) => {
  try {
    // Only allow contractors to view their own jobs
    const userRole = req.user.role; // 'worker' or 'contractor'
    
    let jobs;
    if (userRole === 'contractor') {
      // Contractors see their own posted jobs (filter by name, which is more reliable)
      jobs = await Job.find({ contractorName: req.user.name });
    } else {
      // Workers should use /jobs/nearby instead
      // But for backward compatibility, return empty for workers
      return res.json([]);
    }
    
    res.json(jobs);
  } catch (err) {
    console.error("Failed to load jobs", err);
    res.status(500).json({ message: "Failed to load jobs" });
  }
});

// ✅ NEW ENDPOINT: Workers get their own accepted jobs (for metrics calculation)
app.get("/jobs/my-accepted", authenticateToken, async (req, res) => {
  try {
    const workerName = req.user.name;
    const workerPhone = req.user.phone;
    
    console.log(`\n📥 [/jobs/my-accepted] Request from ${workerName} (${workerPhone})`);
    
    // ✅ Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50; // Default 50, max 100
    const pageSize = Math.min(limit, 100);
    const skip = (page - 1) * pageSize;

    // ✅ Get total count for pagination info
    const myAcceptedFilter = {
      acceptedBy: workerPhone,
      status: { $nin: ['cancelled', 'expired'] } // Exclude cancelled/expired from worker cards and metrics
    };
    const totalCount = await Job.countDocuments(myAcceptedFilter);

    // ✅ Get paginated jobs - sorted by date descending (newest first)
    // ✅ IMPORTANT: Always return hoursWorked from recentGigs in Worker model
    const jobs = await Job.find(myAcceptedFilter)
      .sort({ date: -1 }) // Newest first
      .skip(skip)
      .limit(pageSize)
      .lean();
    
    // ✅ Log jobs with rating info for debugging
    jobs.forEach((job) => {
      if (job.rating) {
        console.log(`   ⭐ Job ${job._id} with rating:`, job.rating);
      }
    });

    console.log(`   ✅ Found ${jobs.length}/${totalCount} jobs (page ${page}/${Math.ceil(totalCount / pageSize)})`);
    
    // ✅ Return array format (backward compatible)
    const response = {
      gigs: jobs,
      page,
      limit: pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      hasMore: skip + pageSize < totalCount
    };
    
    console.log(`   📤 Response structure: gigs=${jobs.length}, totalCount=${totalCount}, totalPages=${response.totalPages}`);
    
    res.json(response);
  } catch (err) {
    console.error("❌ Failed to load worker's accepted jobs:", err);
    res.status(500).json({ success: false, message: "Failed to load jobs", error: err.message });
  }
});

// ✅ Get a single job by id for worker push-tap deep link.
// Returns only active/visible jobs to prevent opening stale offers.
// NOTE: Use /jobs/by-id/:id to avoid clashing with other /jobs/* routes.
app.get("/jobs/by-id/:id", authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const workerPhone = req.user?.phone;

    let job = await Job.findById(jobId).lean();
    if (!job) {
      job = await Job.findOne({ id: jobId }).lean();
    }
    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    const notVisibleStatuses = new Set(["cancelled", "expired"]);
    if (notVisibleStatuses.has(job.status || "")) {
      return res.status(404).json({ success: false, message: "Job not available" });
    }

    // Pending offers are visible; accepted job is visible only to the accepted worker.
    if (job.status === "accepted" && workerPhone && job.acceptedBy && job.acceptedBy !== workerPhone) {
      return res.status(404).json({ success: false, message: "Job not available" });
    }

    return res.json({ success: true, job });
  } catch (err) {
    console.error("Failed to fetch job by id", err);
    return res.status(500).json({ success: false, message: "Failed to fetch job" });
  }
});


const startJobOfferCleanupScheduler = () => {
  setInterval(async () => {
    try {
      const now = new Date();
      
      // Find all expired job offers from DB
      const expiredJobs = await Job.find({
        offerExpiresAt: { $lt: now },
        status: 'pending' // Still pending (not accepted)
      }).select('_id');

      if (expiredJobs.length === 0) return;

      console.log(`🧹 Job Offer Cleanup: Found ${expiredJobs.length} expired offers`);

      // Clear timeouts from memory map for expired jobs
      for (const job of expiredJobs) {
        const jobId = job._id.toString();
        if (pendingJobTimeouts.has(jobId)) {
          clearTimeout(pendingJobTimeouts.get(jobId));
          pendingJobTimeouts.delete(jobId);
          console.log(`  ✅ Cleared timeout for job ${jobId}`);
        }
        if (pendingJobExpirations.has(jobId)) {
          clearTimeout(pendingJobExpirations.get(jobId));
          pendingJobExpirations.delete(jobId);
        }
      }

      console.log(`✅ Job offer cleanup completed. Memory map size: ${pendingJobTimeouts.size}`);
    } catch (err) {
      console.error('❌ Error in job offer cleanup scheduler:', err);
    }
  }, 5 * 60 * 1000); // Run every 5 minutes
};

// ✅ Start leaderboard scheduler when server starts
setTimeout(() => {
  startLeaderboardScheduler();
  startJobOfferCleanupScheduler();
  startWalletReconciliationScheduler();
  startJobReconciliationScheduler();
}, 2000); // Wait 2 seconds for DB to stabilize

// ---------------- START SERVER ----------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running with Socket.io on port ${PORT}`);
});




