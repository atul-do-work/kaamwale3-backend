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
      
      // ✅ CHECK: Does this worker have an unpaid job?
      const hasUnpaidJob = await Job.findOne({
        acceptedBy: worker.phone, // ✅ Check by phone, not name
        paymentStatus: { $ne: "Paid" }
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
    if (!token) {
      // Allow anonymous sockets; handlers should check socket.user when needed
      return next();
    }

    try {
      const user = jwt.verify(token, JWT_SECRET);
      socket.user = user; // { name, phone, role }
      socket.data.user = user; // ✅ Also store in socket.data for easy access

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
        console.warn("Socket JWT verification failed:", err && err.message);
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

        // Fetch User record to get profilePhoto, mainSkill, and expectedWage
        let profilePhoto = null;
        let mainSkill = null;
        let expectedWage = null;
        try {
          const userRecord = await User.findOne({ phone });
          if (userRecord) {
            profilePhoto = userRecord.profilePhoto;
            mainSkill = userRecord.mainSkill;
            expectedWage = userRecord.expectedWage;
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
          isAvailable: updated.isAvailable || false, // ✅ Use worker's current availability status from toggle endpoint
          consecutiveDays: updated.gigsData?.consecutiveDays || 0,
          eligibleFor5Days: updated.gigsData?.eligibleFor5Days || false,
          eligibleFor10Days: updated.gigsData?.eligibleFor10Days || false,
        });

        socket.workerName = name;
        socket.workerType = workerType;
        console.log(`✅ Total connected workers: ${connectedWorkers.size}`);
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
            }

            // ✅ ALSO: Emit workerLocationUpdate for dashboard modal real-time tracking
            // This allows contractors viewing the job modal to see live location updates
            io.emit("workerLocationUpdate", {
              phone: user.phone,
              location: updatedWorker.location,
              timestamp: new Date(),
            });
            console.log(`📡 Emitted workerLocationUpdate for ${user.phone}`);
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
          lat,
          lon,
          date: date || new Date(),
          status: 'pending',
          declinedBy: [],
        });
        await newJob.save();

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
                jobCheck.status = 'expired';
                await jobCheck.save();
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
                jobCheck.status = 'expired';
                await jobCheck.save();
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

// ---------------- NEW ROUTE: UPLOAD PROFILE PHOTO ----------------
app.post("/users/photo", authenticateToken, upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const user = await User.findOne({ phone: req.user.phone });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    // Use req.headers.host to get the server's actual IP/domain
    const protocol = req.protocol || "http";
    const host = process.env.SERVER_URL_DOMAIN || req.headers.host || "localhost:3000";
    const serverURL = `${protocol}://${host}`;
    
    user.profilePhoto = `${serverURL}/uploads/${req.file.filename}`;
    await user.save();

    console.log(`✅ Profile photo uploaded for ${req.user.phone}: ${user.profilePhoto}`);

    // ✅ Emit socket event to notify about profile photo update
    io.emit('profilePhotoUpdated', {
      phone: req.user.phone,
      profilePhoto: user.profilePhoto,
    });

    return res.json({ success: true, profilePhoto: user.profilePhoto });
  } catch (err) {
    console.error("Profile photo upload error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});
// ✅ UPDATE USER PROFILE - Main Skill & Expected Wage
app.post("/users/update-profile", authenticateToken, async (req, res) => {
  try {
    const { mainSkill, expectedWage } = req.body;
    
    if (!mainSkill || !expectedWage) {
      return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    const user = await User.findOne({ phone: req.user.phone });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    user.mainSkill = mainSkill;
    user.expectedWage = expectedWage;
    await user.save();

    // ✅ Update connectedWorkers map if this worker is currently connected
    for (const [socketId, worker] of connectedWorkers.entries()) {
      if (worker.phone === req.user.phone) {
        worker.mainSkill = mainSkill;
        worker.expectedWage = expectedWage;
        console.log(`✅ Updated connected worker ${req.user.phone}: mainSkill=${mainSkill}, expectedWage=${expectedWage}`);
        break;
      }
    }

    console.log(`✅ Profile updated for ${req.user.phone}: mainSkill=${mainSkill}, expectedWage=${expectedWage}`);
    return res.json({ 
      success: true, 
      message: "Profile updated successfully",
      user: {
        name: user.name,
        phone: user.phone,
        mainSkill: user.mainSkill,
        expectedWage: user.expectedWage,
      }
    });
  } catch (err) {
    console.error("Profile update error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

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

app.get("/users", authenticateToken, async (req, res) => {
  try {
    const users = await User.find();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to load users" });
  }
});

// ✅ GET: User profile (for dashboard authentication)
app.get("/users/profile", authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.user.phone });
    
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.json({
      success: true,
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        profilePhoto: user.profilePhoto,
        city: user.city,
        state: user.state,
        premiumPlan: user.premiumPlan || { type: 'free' },
        latitude: user.latitude || (user.location && user.location.coordinates ? user.location.coordinates[1] : 0),
        longitude: user.longitude || (user.location && user.location.coordinates ? user.location.coordinates[0] : 0),
        mainSkill: user.mainSkill || '',
        expectedWage: user.expectedWage || '',
      }
    });
  } catch (err) {
    console.error("Profile error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET: Find nearby workers for contractor (uses worker's GeoJSON location)
app.get('/workers/nearby', authenticateToken, async (req, res) => {
  try {
    let lat = req.query.lat ? parseFloat(req.query.lat) : null;
    let lon = req.query.lon ? parseFloat(req.query.lon) : null;
    const maxMeters = parseInt((req.query.max || '70000'), 10);
    
    // ✅ Parse filter parameters
    const skill = req.query.skill || null;
    const wageMin = req.query.wageMin ? parseInt(req.query.wageMin, 10) : null;
    const wageMax = req.query.wageMax ? parseInt(req.query.wageMax, 10) : null;

    // Validate parsed coordinates
    if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) {
      lat = null;
      lon = null;
    }

    // If lat/lon not provided, try user's stored location
    if ((!lat || !lon) && req.user && req.user.phone) {
      const u = await User.findOne({ phone: req.user.phone });
      if (u && u.location && u.location.coordinates) {
        lon = u.location.coordinates[0];
        lat = u.location.coordinates[1];
        console.log(`📍 Using stored user location: [${lon?.toFixed?.(4) || lon}, ${lat?.toFixed?.(4) || lat}]`);
      }
    }

    if (!lat || !lon) {
      return res.status(400).json({ success: false, message: 'Latitude and longitude required' });
    }

    // ✅ DEBUG: Log input coordinates and filters
    console.log(`🔍 /workers/nearby query: lat=${lat}, lon=${lon}, maxMeters=${maxMeters}, skill=${skill}, wageMin=${wageMin}, wageMax=${wageMax}`);

    // ✅ Build MongoDB query with $near geospatial operator
    const query = {
      location: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [lon, lat]
          },
          $maxDistance: maxMeters || 70000  // 70km default
        }
      }
    };

    // ✅ Add skill filter if provided
    if (skill && skill !== 'All Skills') {
      query.$or = [
        { mainSkill: skill },
        { skills: skill }
      ];
    }

    // ✅ DEBUG: Log the final query
    console.log(`📋 Query filter:`, JSON.stringify(query, null, 2));

    // ✅ Fetch workers with geospatial query - simpler and more efficient
    const workers = await WorkerModel.find(query)
      .limit(100)
      .lean();

    // ✅ Now get user profiles for all workers
    const workerPhones = workers.map(w => w.phone);
    const userProfiles = await User.find({ phone: { $in: workerPhones } }).lean();
    const userMap = {};
    userProfiles.forEach(u => {
      userMap[u.phone] = u;
    });

    // ✅ Merge worker and user data, apply wage filter
    const nearby = workers
      .map(worker => {
        const userProfile = userMap[worker.phone] || {};
        return {
          phone: worker.phone,
          name: userProfile.name,
          skills: worker.skills || [],
          mainSkill: worker.mainSkill || 'Not specified',
          expectedWage: userProfile.expectedWage || 'Negotiable',
          rating: worker.rating || 0,
          profilePhoto: userProfile.profilePhoto || worker.profilePhoto,
          distanceKm: worker.distanceKm || 0,
          distanceMeters: worker.distanceMeters || 0,
          location: worker.location,
          isAvailable: worker.isAvailable || false,
          createdAt: userProfile.createdAt
        };
      })
      .filter(worker => {
        // ✅ Apply wage filter after merging
        if (wageMin !== null || wageMax !== null) {
          const wageMatch = worker.expectedWage.match(/(\d+)/);
          const workerWage = wageMatch ? parseInt(wageMatch[0]) : 0;
          
          if (wageMin !== null && workerWage < wageMin) return false;
          if (wageMax !== null && workerWage >= wageMax) return false;
        }
        return true;
      })
      .sort((a, b) => a.distanceMeters - b.distanceMeters);  // Sort by distance

    console.log(`✅ Found ${nearby.length} workers within ${maxMeters / 1000}km (skill: ${skill || 'all'}, wage: ${wageMin || '∞'}-${wageMax || '∞'})`);

    return res.json({
      success: true,
      count: nearby.length,
      maxDistanceMeters: maxMeters || 70000,
      filters: {
        skill: skill || 'All Skills',
        wageMin: wageMin || null,
        wageMax: wageMax || null
      },
      workers: nearby
    });
  } catch (err) {
    console.error('❌ workers/nearby error', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch nearby workers', error: err.message });
  }
});

// POST: Request a specific worker (sends socket event if connected)
app.post('/workers/request', authenticateToken, async (req, res) => {
  try {
    const { workerPhone, message } = req.body || {};
    if (!workerPhone) return res.status(400).json({ success: false, message: 'workerPhone required' });

    const worker = await WorkerModel.findOne({ phone: workerPhone });
    if (!worker) return res.status(404).json({ success: false, message: 'Worker not found' });

    // Emit to worker if socketId present
    if (worker.socketId) {
      try {
        io.to(worker.socketId).emit('workerRequested', { from: req.user.phone, message: message || '' });
      } catch (e) {
        console.warn('Could not emit workerRequested to socket:', e.message);
      }
    }

    // Record notification history
    try {
      await NotificationHistory.create({ recipientPhone: workerPhone, phone: workerPhone, type: 'worker_request', message: `Requested by ${req.user.phone}: ${message || ''}` });
    } catch (e) {
      console.warn('Could not save notification history:', e.message);
    }

    // Send push notification to worker if possible
    try {
      const title = `Request from contractor`;
      const body = `You have a new request from ${req.user.phone}`;
      const payload = {
        type: 'worker_request',
        title,
        body,
        metadata: { from: req.user.phone, message: message || '' },
      };
      const pushRes = await sendNotificationToUserPhone(workerPhone, payload);
      if (pushRes && pushRes.success) {
        console.log('Push notification sent to', workerPhone);
      } else {
        console.log('Push not sent / no token for', workerPhone);
      }
    } catch (e) {
      console.error('Error sending push for worker request:', e && e.message);
    }

    return res.json({ success: true, message: 'Request sent' });
  } catch (err) {
    console.error('workers/request error', err);
    return res.status(500).json({ success: false, message: 'Failed to request worker' });
  }
});

// ✅ POST: Subscribe to premium plan (simple)
app.post("/premium/subscribe", authenticateToken, async (req, res) => {
  try {
    const { planId } = req.body;
    const user = await User.findOne({ phone: req.user.phone });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Plan pricing
    const planPrice = planId === "basic" ? 399 : planId === "pro" ? 699 : 0;

    if (!planPrice) {
      return res.status(400).json({ success: false, message: "Invalid plan" });
    }

    // Check wallet balance
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    
    // Create wallet if it doesn't exist
    if (!wallet) {
      wallet = new Wallet({
        phone: req.user.phone,
        balance: 0,
        transactions: [],
      });
      await wallet.save();
    }
    
    if (wallet.balance < planPrice) {
      return res.status(400).json({
        success: false,
        message: `Insufficient balance. You have ₹${wallet.balance}, but plan costs ₹${planPrice}`,
      });
    }

    // Deduct from wallet
    wallet.balance -= planPrice;
    wallet.transactions.push({
      type: "premium_subscription",
      amount: planPrice,
      planId: planId,
      date: new Date(),
    });
    await wallet.save();

    // Update user premium plan
    const startDate = new Date();
    const endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

    user.premiumPlan = {
      type: planId,  // 'basic' or 'pro'
      price: planPrice,
      startDate: startDate,
      expiryDate: endDate,
      autoRenew: false,
    };

    await user.save();

    // Log activity
    await ActivityLog.create({
      userId: req.user.phone,
      phone: req.user.phone,
      action: "premium_subscription",
      description: `Subscribed to ${planId} plan for ₹${planPrice}`,
      status: "success",
    });

    // ✅ NEW: Emit socket event to notify all contractors about premium subscription
    // This triggers frontend to refresh leaderboard immediately
    const io = global.io;
    if (io) {
      io.emit('premiumSubscriptionUpdate', {
        contractorPhone: req.user.phone,
        contractorName: user.name,
        planType: planId,
        timestamp: new Date(),
      });
      console.log(`📤 Emitted premiumSubscriptionUpdate for contractor ${req.user.phone}`);
    }

    res.json({
      success: true,
      message: `Successfully subscribed to ${planId} plan`,
      premiumPlan: user.premiumPlan,
      newBalance: wallet.balance,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Subscription failed" });
  }
});

// ✅ GET: Check user premium status
app.get("/premium/status", authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.user.phone });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Check if premium is still active
    const now = new Date();
    const isActive = user.premiumPlan?.expiryDate && user.premiumPlan.expiryDate > now;

    res.json({
      success: true,
      premiumPlan: user.premiumPlan?.type || "free",
      isActive: isActive,
      premiumDetails: user.premiumPlan,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to check status" });
  }
});

// ✅ POST: Cancel premium plan
app.post("/premium/cancel", authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({ phone: req.user.phone });

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    user.premiumPlan = {
      type: "free",
      price: 0,
      startDate: null,
      expiryDate: null,
      autoRenew: false,
    };

    await user.save();

    await ActivityLog.create({
      userId: req.user.phone,
      phone: req.user.phone,
      action: "premium_cancelled",
      description: "Premium plan cancelled",
      status: "success",
    });

    res.json({
      success: true,
      message: "Premium plan cancelled",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to cancel plan" });
  }
});

// ✅ GET: Get wallet balance
app.get("/wallet/balance", authenticateToken, async (req, res) => {
  try {
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    
    if (!wallet) {
      wallet = new Wallet({
        phone: req.user.phone,
        balance: 0,
        transactions: [],
      });
      await wallet.save();
    }

    res.json({
      success: true,
      balance: wallet.balance,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Failed to get balance" });
  }
});

// ✅ GET transactions for contractor
app.get("/wallet/transactions", authenticateToken, async (req, res) => {
  try {
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    
    if (!wallet) {
      return res.json({ success: true, transactions: [] });
    }
    
    // Sort transactions by date (most recent first)
    const sortedTransactions = wallet.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    
    // Format transactions for frontend
    const formattedTransactions = sortedTransactions.map((t) => {
      const transactionDate = new Date(t.date);
      
      // Explicit date formatting
      const day = String(transactionDate.getDate()).padStart(2, '0');
      const month = String(transactionDate.getMonth() + 1).padStart(2, '0');
      const year = transactionDate.getFullYear();
      const dateStr = `${day}/${month}/${year}`;
      
      // Explicit time formatting
      let hours = transactionDate.getHours();
      const minutes = String(transactionDate.getMinutes()).padStart(2, '0');
      const seconds = String(transactionDate.getSeconds()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12; // the hour '0' should be '12'
      const hoursStr = String(hours).padStart(2, '0');
      const timeStr = `${hoursStr}:${minutes}:${seconds} ${ampm}`;
      
      return {
        id: t._id,
        type: t.type === "deposit" || t.type === "credit" ? "credit" : t.type === "refund" ? "refund" : "debit",
        description: t.description || `${t.type.charAt(0).toUpperCase() + t.type.slice(1)}`,
        amount: t.amount,
        date: `${dateStr} ${timeStr}`,
        status: "completed",
      };
    });
    
    res.json({ success: true, transactions: formattedTransactions });
  } catch (err) {
    console.error('Transactions fetch error:', err);
    res.status(500).json({ success: false, message: "Error fetching transactions" });
  }
});

// ✅ GET: Get premium plans list
app.get("/premium/plans", async (req, res) => {
  try {
    const plans = [
      {
        id: "basic",
        name: "Basic",
        price: 399,
        features: [
          "🔥 Bulk Hiring",
          "⚡ 24/7 Instant",
          "📊 Leaderboard",
        ],
        popular: false,
      },
      {
        id: "pro",
        name: "Pro",
        price: 699,
        features: [
          "🔥 Bulk Hiring",
          "⚡ 24/7 Instant",
          "📊 Leaderboard",
          "✨ Custom Add-ons",
        ],
        popular: true,
      },
    ];
    res.json({ success: true, plans });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to load plans" });
  }
});

// ✅ POST: Add custom add-ons to premium plan (future)
app.post("/premium/add-ons", authenticateToken, async (req, res) => {
  try {
    const { addOns } = req.body;
    const user = await User.findOne({ phone: req.user.phone });

    if (!user || user.premiumPlan?.type === "free") {
      return res.status(400).json({
        success: false,
        message: "Must have active premium plan to add custom add-ons",
      });
    }

    // For now, just return success (implementation for future)
    res.json({
      success: true,
      message: "Custom add-ons feature coming soon",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to add custom add-ons" });
  }
});

// ✅ GET: Leaderboard for premium users (top ranked by points) - PUBLIC
app.get("/leaderboard", async (req, res) => {
  try {
    const { limit = 10 } = req.query;
    
    // Fetch top users by points (exclude current user if authenticated)
    const filter = { 
      role: 'contractor',
      points: { $gt: 0 }
    };
    
    // If authenticated, exclude current user
    if (req.user?.phone) {
      filter.phone = { $ne: req.user.phone };
    }
    
    const topUsers = await User.find(filter)
      .select('name phone profilePhoto points')
      .sort({ points: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      leaderboard: topUsers.map(user => ({
        _id: user._id,
        phone: user.phone,
        name: user.name,
        profilePhoto: user.profilePhoto,
        points: user.points || 0
      }))
    });
  } catch (err) {
    console.error('Leaderboard fetch error:', err);
    res.status(500).json({ success: false, message: "Failed to fetch leaderboard" });
  }
});

// ===== OTP & AUTH ROUTES =====
const { sendOtp } = require('./utils/sendOtp'); // ✅ Import Firebase OTP service

// Request OTP - sends via Firebase Push or Console (for testing)
app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone, name, role, fcmToken } = req.body;
    
    console.log('\n🔐 OTP Request Endpoint Hit');
    console.log('  - Phone:', phone);
    console.log('  - Name:', name);
    console.log('  - Role:', role);
    console.log('  - FCM Token provided:', !!fcmToken);
    if (fcmToken) {
      console.log('  - Token length:', fcmToken.length);
      console.log('  - Token preview:', fcmToken.substring(0, 50) + '...');
    }

    if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });

    let user = await User.findOne({ phone });
    if (!user) {
      console.log('  - Creating new user...');
      user = new User({ phone, name: name || 'Unknown', role: role || 'worker' });
    } else {
      console.log('  - User found, updating...');
    }

    // Store FCM token for push notifications
    if (fcmToken) {
      user.fcmToken = fcmToken;
      console.log('  - FCM Token stored in user document');
    } else {
      console.log('  - ⚠️ No FCM Token to store');
    }

    await user.save();
    console.log('  - User saved to database');

    // Generate and send OTP. Prefer FCM token from request, fall back to stored token.
    console.log('  - Calling sendOtp()...');
    const tokenToUse = fcmToken || user.fcmToken || null;
    const otpResult = await sendOtp(phone, tokenToUse);
    
    if (otpResult.success) {
      // Store OTP in database for verification
      user.otpCode = otpResult.otp;
      user.otpExpiry = new Date(Date.now() + 1000 * 60 * 5); // 5 minutes
      await user.save();

      console.log('  - OTP stored in database');
      console.log('  - Response method:', otpResult.method);

      const method = fcmToken ? 'push notification' : 'console (dev-mode)';
      return res.json({ success: true, message: `OTP sent via ${method}`, method: otpResult.method });
    } else {
      console.error('  - ❌ OTP sending failed:', otpResult.message);
      return res.status(400).json({ success: false, message: otpResult.message });
    }
  } catch (err) {
    console.error('❌ Request OTP error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Verify OTP and issue tokens
app.post('/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ success: false, message: 'Phone and OTP required' });

    const user = await User.findOne({ phone });
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    // Verify OTP from database (simple comparison)
    if (!user.otpCode || !user.otpExpiry || new Date() > user.otpExpiry || user.otpCode !== otp) {
      return res.status(400).json({ success: false, message: 'Invalid or expired OTP' });
    }

    user.phoneVerified = true;
    user.phoneVerifiedAt = new Date();
    user.otpCode = null;
    user.otpExpiry = null;

    // Issue tokens
    const accessToken = jwt.sign({ name: user.name, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = require('crypto').randomBytes(40).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days
    user.refreshTokens.push({ token: refreshToken, issuedAt: new Date(), expiresAt, deviceInfo: req.headers['user-agent'] || 'unknown' });

    await user.save();

    return res.json({ success: true, user: { name: user.name, phone: user.phone, role: user.role }, accessToken, refreshToken });
  } catch (err) {
    console.error('Verify OTP error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Refresh access token
app.post('/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'refreshToken required' });

    const user = await User.findOne({ 'refreshTokens.token': refreshToken });
    if (!user) return res.status(401).json({ success: false, message: 'Invalid refresh token' });

    const entry = user.refreshTokens.find(r => r.token === refreshToken);
    if (!entry || new Date() > new Date(entry.expiresAt)) {
      return res.status(401).json({ success: false, message: 'Refresh token expired' });
    }

    const accessToken = jwt.sign({ name: user.name, phone: user.phone, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    return res.json({ success: true, accessToken });
  } catch (err) {
    console.error('Refresh token error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Logout - revoke refresh token
app.post('/auth/logout', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ success: false, message: 'refreshToken required' });

    const user = await User.findOne({ 'refreshTokens.token': refreshToken });
    if (!user) return res.json({ success: true }); // already revoked

    user.refreshTokens = user.refreshTokens.filter(r => r.token !== refreshToken);
    await user.save();
    return res.json({ success: true });
  } catch (err) {
    console.error('Logout error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});


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

    // Return the image URL that can be accessed - use same logic as profile photos
    const protocol = req.protocol || "http";
    const host = process.env.SERVER_URL_DOMAIN || req.headers.host || "localhost:3000";
    const serverURL = `${protocol}://${host}`;
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
    });
    await newJob.save();

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

    // ✅ CHECK: Worker cannot accept multiple simultaneous jobs
    // Find if worker has any unpaid job
    const hasUnpaidJob = await Job.findOne({
      acceptedBy: workerPhone, // ✅ Check by phone
      paymentStatus: { $ne: "Paid" }  // Any job that's not paid yet
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
      // Prevent duplicate accepts
      if (job.acceptedWorkers && job.acceptedWorkers.find(w => w.phone === workerPhone)) {
        return res.status(400).json({ success: false, message: "You have already accepted this job" });
      }

      job.acceptedWorkers = job.acceptedWorkers || [];
      job.acceptedWorkers.push(acceptedWorkerSnapshot);

      // If required reached, finalize job
      if (job.acceptedWorkers.length >= (job.requiredWorkers || 1)) {
        job.status = 'accepted';
        job.acceptedBy = job.acceptedWorkers[0]?.phone || workerPhone;
        job.acceptedWorker = job.acceptedWorkers[0] || acceptedWorkerSnapshot;
        job.acceptedAt = job.acceptedAt || new Date();
      }

      await job.save();

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

      // Notify contractor about updated accepted count
      try {
        await NotificationHistory.create({
          recipientPhone: job.contractorPhone,
          senderPhone: req.user.phone,
          senderName: workerName || req.user.name,
          type: 'job_accepted',
          title: `Worker Accepted: ${job.title}`,
          body: `${workerName} accepted your job. ${job.acceptedWorkers.length}/${job.requiredWorkers} accepted.`,
          jobId: job._id.toString(),
          metadata: { acceptedCount: job.acceptedWorkers.length, requiredWorkers: job.requiredWorkers },
          deepLink: `contractor/jobs/${job._id.toString()}`,
          pushNotificationSent: false,
        });
      } catch (e) {
        console.error('Error creating job acceptance notification for contractor:', e);
      }

      // Emit targeted update with accepted workers list
      const payload = { ...job.toObject(), _targetedUpdate: true, targetedFor: [job.contractorName] };
      await emitJobUpdatedToUsers(payload, [job.contractorName]);

      // If finalized, also notify workers and start tracking
      if (job.status === 'accepted') {
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
      }

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
    const workerName = req.user.name;
    const MAX_RADIUS_KM = 10; // Maximum search radius

    let jobs = await Job.find();
    
    // ✅ CHECK: Does worker have an active unpaid job?
    const hasActiveUnpaidJob = jobs.some(
      (job) => job.acceptedBy === workerName && job.paymentStatus !== "Paid"
    );
    
    // If worker has active unpaid job, return empty array (block all new jobs)
    if (hasActiveUnpaidJob) {
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
    
    // ✅ Pagination parameters
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50; // Default 50, max 100
    const pageSize = Math.min(limit, 100);
    const skip = (page - 1) * pageSize;

    // ✅ Get total count for pagination info
    const totalCount = await Job.countDocuments({ acceptedBy: workerPhone });

    // ✅ Get paginated jobs - sorted by date descending (newest first)
    // ✅ IMPORTANT: Always return hoursWorked from recentGigs in Worker model
    const jobs = await Job.find({ acceptedBy: workerPhone })
      .sort({ date: -1 }) // Newest first
      .skip(skip)
      .limit(pageSize)
      .lean();
    
    // ✅ Log jobs with rating info for debugging
    jobs.forEach((job) => {
      if (job.rating) {
        console.log(`⭐ Fetched job ${job._id} with rating:`, job.rating);
      }
    });

    console.log(`✅ Worker ${workerName} (${workerPhone}): page ${page}, returned ${jobs.length}/${totalCount} jobs`);
    
    // ✅ Return array format (backward compatible)
    res.json({
      gigs: jobs,
      page,
      limit: pageSize,
      totalCount,
      totalPages: Math.ceil(totalCount / pageSize),
      hasMore: skip + pageSize < totalCount
    });
  } catch (err) {
    console.error("Failed to load worker's accepted jobs", err);
    res.status(500).json({ message: "Failed to load jobs" });
  }
});

// ✅ GET worker details by phone - return full worker info with ID and profile photo
app.get("/worker/:phone", authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.params.phone;
    console.log(`📋 Fetching worker details for phone: ${workerPhone}`);
    
    const worker = await WorkerModel.findOne({ phone: workerPhone });
    if (!worker) {
      console.log(`❌ Worker not found for phone: ${workerPhone}`);
      return res.status(404).json({ success: false, message: "Worker not found" });
    }

    // Also get profile photo from User model
    const user = await User.findOne({ phone: workerPhone });
    
    console.log(`✅ Found worker ${workerPhone}, profilePhoto: ${user?.profilePhoto || 'null'}, location: ${JSON.stringify(worker.location)}`);
    
    // Return worker data with location, ID, and profile photo
    res.json({
      id: worker._id.toString(),
      phone: worker.phone,
      location: worker.location || null,
      isAvailable: worker.isAvailable || false,
      profilePhoto: user?.profilePhoto || null,
      skills: worker.skills || [],
    });
  } catch (err) {
    console.error("Failed to fetch worker details", err);
    res.status(500).json({ success: false, message: "Failed to fetch worker details" });
  }
});

// ---------------- ATTENDANCE & PAYMENT ----------------
app.post("/jobs/attendance/:id", authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const { status } = req.body;

    const job = await Job.findById(jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });

    job.attendanceStatus = status;
    job.attendanceTime = new Date();
    await job.save();

    // Stop tracking location for this job when attendance is set
    try {
      if (trackingJobs.has(jobId)) trackingJobs.delete(jobId);
    } catch (e) {
      console.error("Error clearing tracking for job on attendance:", e);
    }

    // Targeted: notify contractor and accepted worker about attendance change
    await emitJobUpdatedToUsers(job, [job.contractorName, job.acceptedBy || job.contractorName]);
    return res.json({ success: true, job });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/jobs/pay/:id", authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const { mode } = req.body;

    const job = await Job.findById(jobId);
    if (!job) return res.status(404).json({ message: "Job not found" });

    if (job.attendanceStatus !== "Present") {
      return res.status(400).json({ success: false, message: "Payment allowed only for PRESENT workers" });
    }

    job.paymentStatus = "Paid";
    job.paymentMode = mode;
    job.paymentTime = new Date();
    
    // Calculate time spent from acceptance to payment
    if (job.acceptedAt) {
      const timeSpentMs = job.paymentTime - job.acceptedAt;
      job.timeSpentMinutes = Math.round(timeSpentMs / 60000); // Convert milliseconds to minutes
    }
    
    await job.save();

    // ✅ RECORD WORK for milestones: convert minutes -> hours
    try {
      if (job.acceptedBy) {
        const worker = await WorkerModel.findOne({ phone: job.acceptedBy });
        if (worker && typeof worker.recordWork === 'function') {
          const hoursWorked = (job.timeSpentMinutes || 0) / 60;
          worker.recordWork(job.paymentTime || new Date(), hoursWorked, false);
          await worker.save();
          console.log(`📈 Recorded work for ${job.acceptedBy}: ${hoursWorked.toFixed(2)} hours`);
        }
      }
    } catch (recErr) {
      console.error('Error recording worker work on payment:', recErr);
    }

    // ✅ CREATE NOTIFICATION FOR WORKER - PAYMENT SENT (only to the accepted worker)
    try {
      if (job.acceptedWorker && job.acceptedWorker.phone) {
        await NotificationHistory.create({
          recipientPhone: job.acceptedWorker.phone,
          senderPhone: req.user.phone,
          senderName: req.user.name || job.contractorName || 'Contractor',
          type: 'payment_received',
          title: `Payment Received: ₹${job.amount}`,
          body: `Payment for ${job.title} has been transferred to your wallet`,
          jobId: job._id.toString(),
          metadata: {
            jobTitle: job.title,
            amount: job.amount,
            actionRequired: false
          },
          deepLink: `worker/wallet`,
          pushNotificationSent: false,
        });
        console.log(`📬 Payment notification sent to worker ${job.acceptedWorker.name}`);
      }
    } catch (e) {
      console.error('Error creating payment notification:', e);
    }

    // ✅ ADD PAYMENT TRANSACTION TO WORKER'S WALLET
    try {
      let workerWallet = await Wallet.findOne({ phone: job.acceptedBy });
      if (!workerWallet) {
        workerWallet = new Wallet({ phone: job.acceptedBy, balance: 0 });
      }
      
      const oldBalance = workerWallet.balance;
      // Add payment transaction
      workerWallet.balance += Number(job.amount);
      workerWallet.transactions.push({
        type: "payment",
        amount: Number(job.amount),
        date: new Date(),
      });
      
      await workerWallet.save();
      console.log(`💰 Added ₹${job.amount} to worker ${job.acceptedBy}'s wallet. Balance: ₹${oldBalance} → ₹${workerWallet.balance}`);
    } catch (walletErr) {
      console.error('❌ Error updating worker wallet after payment:', walletErr);
    }

    // ✅ AUTO-UPDATE CONTRACTOR STATS AFTER PAYMENT
    await updateContractorStats(req.user.phone);

    // ✅ TRACK: Update gigs data on job completion
    try {
      await updateGigDataOnCompletion(job.acceptedBy, {
        jobId: job._id.toString(),
        title: job.title,
        amount: job.amount,
        workerType: job.workerType,
        timeSpentMinutes: job.timeSpentMinutes || 0
      });
      console.log(`✅ Gigs data updated for completion by ${job.acceptedBy}`);
    } catch (e) {
      console.error("❌ Error updating gigs data on completion:", e);
      // Don't fail the request if tracking fails
    }

    // Targeted: notify contractor and worker about payment
    await emitJobUpdatedToUsers(job, [job.contractorName, job.acceptedBy || job.contractorName]);
    return res.json({ success: true, message: "Payment successful", job });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// -------- WORKER INCENTIVE DATA ENDPOINT --------
app.get("/worker/incentive-data", authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.user.phone;
    console.log(`📊 Fetching incentive data for worker: ${workerPhone}`);

    const gigsData = await getWorkerGigsSummary(workerPhone);
    
    if (!gigsData) {
      return res.status(404).json({ 
        success: false, 
        message: "Worker not found or no gigs data available" 
      });
    }

    return res.json({ 
      success: true, 
      data: gigsData 
    });
  } catch (err) {
    console.error("❌ Error fetching incentive data:", err);
    return res.status(500).json({ 
      success: false, 
      message: "Error fetching incentive data" 
    });
  }
});

// -------- RATING ENDPOINT --------
app.post("/jobs/rate/:id", authenticateToken, async (req, res) => {
  try {
    const jobId = req.params.id;
    const { stars, feedback } = req.body;

    console.log(`⭐ Rating request: Job ${jobId}, Stars: ${stars}, Feedback: ${feedback}`);

    // Validate rating input
    if (!stars || stars < 1 || stars > 5) {
      return res.status(400).json({ message: "Rating must be between 1 and 5 stars" });
    }

    const job = await Job.findById(jobId); // ✅ Fixed: Use MongoDB _id
    if (!job) return res.status(404).json({ message: "Job not found" });

    // Only allow rating if job is paid
    if (job.paymentStatus !== "Paid") {
      return res.status(400).json({ message: "Can only rate jobs that have been paid" });
    }

    // Only allow rating if worker was marked present
    if (job.attendanceStatus !== "Present") {
      return res.status(400).json({ message: "Can only rate workers marked as Present" });
    }

    // Store rating in job
    job.rating = {
      stars: parseInt(stars),
      feedback: feedback || "",
      ratedAt: new Date(),
      ratedBy: req.user.phone || job.contractorName,
    };

    await job.save();
    
    // ✅ Reload job from DB to ensure rating is persisted
    const updatedJob = await Job.findById(jobId);
    console.log(`✅ Rating saved for job ${jobId}:`, updatedJob?.rating);
    
    // ✅ CREATE NOTIFICATION FOR WORKER - RATING RECEIVED (only to the accepted worker)
    try {
      if (job.acceptedWorker && job.acceptedWorker.phone) {
        const ratingText = `${stars} star${stars > 1 ? 's' : ''}`;
        await NotificationHistory.create({
          recipientPhone: job.acceptedWorker.phone,
          senderPhone: req.user.phone,
          senderName: req.user.name || job.contractorName || 'Contractor',
          type: 'rating_received',
          title: `Rating Received: ${ratingText}`,
          body: feedback || `You received a ${ratingText} rating for ${job.title}`,
          jobId: job._id.toString(),
          metadata: {
            rating: stars,
            jobTitle: job.title,
            actionRequired: false
          },
          deepLink: `worker/profile`,
          pushNotificationSent: false,
        });
        console.log(`📬 Rating notification sent to worker ${job.acceptedWorker.name}`);
      }
    } catch (e) {
      console.error('Error creating rating notification:', e);
    }

    // Targeted: notify contractor and worker about rating
    await emitJobUpdatedToUsers(updatedJob || job, [job.contractorName, job.acceptedBy || job.contractorName]);
    console.log(`📤 Sent targeted jobUpdated event with rating`);
    return res.json({ 
      success: true, 
      message: "Rating submitted successfully", 
      job 
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ---------------- WALLET ROUTES ----------------
app.get("/wallet", authenticateToken, async (req, res) => {
  try {
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    
    // Auto-create if missing
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone });
      await wallet.save();
      console.log(`✅ Auto-created wallet for ${req.user.phone} on GET /wallet`);
    }

    return res.json({ success: true, wallet });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/wallet/deposit", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Invalid amount" });

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    // Auto-create if missing
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone });
      await wallet.save();
      console.log(`✅ Auto-created wallet for ${req.user.phone} on DEPOSIT`);
    }

    wallet.balance += Number(amount);
    wallet.transactions.push({ type: "deposit", amount, date: new Date() });
    await wallet.save();

    return res.json({ success: true, wallet, message: "Deposit successful" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/wallet/withdraw", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Invalid amount" });

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    // Auto-create if missing
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone });
      await wallet.save();
      console.log(`✅ Auto-created wallet for ${req.user.phone} on WITHDRAW`);
    }
    if (wallet.balance < amount) return res.status(400).json({ success: false, message: "Insufficient balance" });

    wallet.balance -= Number(amount);
    wallet.transactions.push({ type: "withdraw", amount, date: new Date() });
    await wallet.save();

    return res.json({ success: true, wallet, message: "Withdrawal successful" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ----------------CONTRACTOR STATS ----------------
// Save/Update contractor daily stats (called after job completion or manually)
app.post('/contractor/stats/save', authenticateToken, async (req, res) => {
  try {
    const { phone } = req.user;
    const { jobsPosted, jobsCompleted, workersEngaged, totalSpending, jobDetails, workersList } = req.body;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let stats = await ContractorStats.findOne({ phone, date: today });

    if (stats) {
      // Update existing stats
      stats.jobsPosted = jobsPosted || stats.jobsPosted;
      stats.jobsCompleted = jobsCompleted || stats.jobsCompleted;
      stats.workersEngaged = workersEngaged || stats.workersEngaged;
      stats.totalSpending = totalSpending || stats.totalSpending;
      if (jobDetails) stats.jobDetails = jobDetails;
      if (workersList) stats.workersList = workersList;
      stats.updatedAt = new Date();
    } else {
      // Create new stats entry
      stats = new ContractorStats({
        phone,
        date: today,
        jobsPosted: jobsPosted || 0,
        jobsCompleted: jobsCompleted || 0,
        workersEngaged: workersEngaged || 0,
        totalSpending: totalSpending || 0,
        jobDetails: jobDetails || [],
        workersList: workersList || [],
      });
    }

    await stats.save();
    return res.json({ success: true, stats, message: 'Stats saved successfully' });
  } catch (err) {
    console.error('Save stats error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Fetch contractor stats with date range filter
app.get('/contractor/stats', authenticateToken, async (req, res) => {
  try {
    const { phone } = req.user;
    const { range = 'today' } = req.query; // 'today', 'week', 'month'

    let startDate = new Date();
    startDate.setHours(0, 0, 0, 0);

    if (range === 'week') {
      startDate.setDate(startDate.getDate() - 7);
    } else if (range === 'month') {
      startDate.setMonth(startDate.getMonth() - 1);
    }

    const stats = await ContractorStats.find({
      phone,
      date: { $gte: startDate },
    }).sort({ date: -1 });

    // Calculate aggregate stats
    const aggregated = {
      totalJobsPosted: stats.reduce((sum, s) => sum + s.jobsPosted, 0),
      totalJobsCompleted: stats.reduce((sum, s) => sum + s.jobsCompleted, 0),
      totalWorkersEngaged: new Set(stats.flatMap(s => s.workersList)).size,
      totalSpending: stats.reduce((sum, s) => sum + s.totalSpending, 0),
      avgJobsPerDay: stats.length > 0 ? (stats.reduce((sum, s) => sum + s.jobsPosted, 0) / stats.length).toFixed(2) : 0,
      avgCompletionPerDay: stats.length > 0 ? (stats.reduce((sum, s) => sum + s.jobsCompleted, 0) / stats.length).toFixed(2) : 0,
    };

    return res.json({ success: true, stats, aggregated, range });
  } catch (err) {
    console.error('Fetch stats error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Fetch specific date range stats (for charts/trends)
app.get('/contractor/stats/range', authenticateToken, async (req, res) => {
  try {
    const { phone } = req.user;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, message: 'startDate and endDate required' });
    }

    const stats = await ContractorStats.find({
      phone,
      date: {
        $gte: new Date(startDate),
        $lte: new Date(endDate),
      },
    }).sort({ date: 1 });

    return res.json({ success: true, stats });
  } catch (err) {
    console.error('Fetch range stats error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Auto-save stats endpoint (call this when job is completed/paid)
app.post('/contractor/stats/update-from-jobs', authenticateToken, async (req, res) => {
  try {
    const { phone } = req.user;

    // Fetch all jobs for this contractor
    const jobs = await Job.find({ contractorName: phone });

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Filter today's jobs
      const todayJobs = jobs.filter(j => {
      const jDate = new Date(j.createdAt); // ✅ Changed from timestamp to createdAt
      jDate.setHours(0, 0, 0, 0);
      return jDate.getTime() === today.getTime();
    });    const jobsPosted = todayJobs.length;
    const jobsCompleted = todayJobs.filter(j => j.attendanceStatus && j.paymentStatus === 'Paid').length;
    const workersList = [...new Set(todayJobs.map(j => j.acceptedBy))];
    const workersEngaged = workersList.length;
    const totalSpending = todayJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);

    const jobDetails = todayJobs.map(j => ({
      jobId: j._id, // ✅ Fixed: Use _id instead of id
      title: j.title,
      workerName: j.acceptedBy,
      amount: j.amount,
      status: j.status,
      paymentStatus: j.paymentStatus,
      timestamp: j.createdAt, // ✅ Changed from j.timestamp to j.createdAt
    }));

    // Save or update stats
    let stats = await ContractorStats.findOne({ phone, date: today });
    if (stats) {
      stats.jobsPosted = jobsPosted;
      stats.jobsCompleted = jobsCompleted;
      stats.workersEngaged = workersEngaged;
      stats.totalSpending = totalSpending;
      stats.workersList = workersList;
      stats.jobDetails = jobDetails;
      stats.updatedAt = new Date();
    } else {
      stats = new ContractorStats({
        phone,
        date: today,
        jobsPosted,
        jobsCompleted,
        workersEngaged,
        totalSpending,
        workersList,
        jobDetails,
      });
    }

    await stats.save();
    return res.json({ success: true, stats, message: 'Stats updated from jobs' });
  } catch (err) {
    console.error('Update stats from jobs error', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// ============================================================
// ✅ NEW ENDPOINTS FOR CRITICAL COLLECTIONS
// ============================================================

// ---------- ACTIVITY LOG ENDPOINTS ----------
app.post('/activity/log', authenticateToken, async (req, res) => {
  try {
    const { action, jobId, relatedPhone, metadata } = req.body;

    const activityLog = new ActivityLog({
      userId: req.user._id || req.user.phone,
      phone: req.user.phone,
      action,
      jobId,
      relatedPhone,
      metadata,
      status: 'success',
      timestamp: new Date(),
    });

    await activityLog.save();
    console.log(`✅ Activity logged: ${action} by ${req.user.phone}`);
    res.json({ success: true, activity: activityLog });
  } catch (err) {
    console.error('Activity log error:', err);
    res.status(500).json({ success: false, message: 'Error logging activity' });
  }
});

app.get('/activity/history', authenticateToken, async (req, res) => {
  try {
    const { limit = 50, skip = 0 } = req.query;
    
    const activities = await ActivityLog.find({ phone: req.user.phone })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await ActivityLog.countDocuments({ phone: req.user.phone });

    res.json({ success: true, activities, total, page: Math.ceil((parseInt(skip) + parseInt(limit)) / parseInt(limit)) });
  } catch (err) {
    console.error('Activity history error:', err);
    res.status(500).json({ success: false, message: 'Error fetching activity history' });
  }
});

// ---------- SUPPORT TICKET ENDPOINTS ----------
app.post('/support/create', authenticateToken, async (req, res) => {
  try {
    const { type, subject, description, jobId, reportedPhone, screenshots } = req.body;
    
    if (!type || !subject || !description) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const ticketId = `TICKET-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const ticket = new SupportTicket({
      ticketId,
      reporterPhone: req.user.phone,
      reportedPhone,
      jobId,
      type,
      subject,
      description,
      screenshots: screenshots || [],
      status: 'open',
      createdAt: new Date(),
    });

    await ticket.save();

    // Log activity
    await ActivityLog.create({
      userId: req.user._id || req.user.phone,
      phone: req.user.phone,
      action: 'support_ticket_created',
      description: `Support ticket created: ${subject}`,
      status: 'success',
      metadata: { ticketId, type },
    });

    console.log(`📋 Support ticket created: ${ticketId} by ${req.user.phone}`);
    res.json({ success: true, ticket, message: 'Support ticket created successfully' });
  } catch (err) {
    console.error('Support ticket creation error:', err);
    res.status(500).json({ success: false, message: 'Error creating support ticket' });
  }
});

app.get('/support/tickets', authenticateToken, async (req, res) => {
  try {
    const tickets = await SupportTicket.find({
      $or: [
        { reporterPhone: req.user.phone },
        { reportedPhone: req.user.phone }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ success: true, tickets, count: tickets.length });
  } catch (err) {
    console.error('Fetch tickets error:', err);
    res.status(500).json({ success: false, message: 'Error fetching tickets' });
  }
});

app.get('/support/ticket/:ticketId', authenticateToken, async (req, res) => {
  try {
    const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
    
    if (!ticket) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    // Mark as read
    if (ticket.reporterPhone === req.user.phone && !ticket.isRead) {
      ticket.isRead = true;
      ticket.readAt = new Date();
      await ticket.save();
    }

    res.json({ success: true, ticket });
  } catch (err) {
    console.error('Fetch ticket error:', err);
    res.status(500).json({ success: false, message: 'Error fetching ticket' });
  }
});

// ---------- VERIFICATION DOCUMENT ENDPOINTS ----------
// Accept both multipart/form-data uploads (preferred) and legacy base64 JSON payloads
app.post('/verification/upload', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    // Fields from either multipart/form-data (req.body) or JSON
    // Safely destructure with fallback values
    const type = req.body?.type || req.query?.type;
    const documentNumber = req.body?.documentNumber || req.query?.documentNumber;
    const expiryDate = req.body?.expiryDate || req.query?.expiryDate;

    // If neither a file nor a type is provided, reject
    if (!type && !req.file && !req.body?.imageData) {
      return res.status(400).json({ success: false, message: 'Missing document type or file' });
    }

    let verification = await VerificationDocument.findOne({ phone: req.user.phone });
    if (!verification) {
      verification = new VerificationDocument({
        userId: req.user._id || req.user.phone,
        phone: req.user.phone,
        documents: [],
        accountStatus: 'restricted',
      });
    }

    // Determine file storage: prefer uploaded file (multer), fallback to base64 imageData
    let fileUrl = null;
    let fileName = null;

    if (req.file) {
      // Serve uploaded file from /uploads
      fileName = req.file.originalname || req.file.filename;
      // Build an absolute URL so clients can preview if required
      const host = req.headers.host || `localhost:${PORT}`;
      const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http';
      fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
      console.log(`📄 Stored uploaded file for ${req.user.phone}: ${fileUrl}`);
    } else if (req.body?.imageData) {
      // Legacy: store base64 string directly
      fileUrl = req.body.imageData;
      fileName = req.body.fileName || `${type || 'doc'}_${Date.now()}`;
      console.log(`📄 Received base64 document for ${req.user.phone} (legacy path)`);
    }

    const document = {
      type: type || 'unknown',
      fileUrl: fileUrl,
      fileName: fileName || '',
      documentNumber: documentNumber || undefined,
      uploadedAt: new Date(),
      verificationStatus: 'pending',
      expiryDate: expiryDate ? new Date(expiryDate) : undefined,
    };

    verification.documents.push(document);
    await verification.save();

    return res.json({ success: true, verification, message: 'Document uploaded for verification' });
  } catch (err) {
    console.error('Document upload error:', err);
    return res.status(500).json({ success: false, message: 'Error uploading document' });
  }
});

app.get('/verification/status', authenticateToken, async (req, res) => {
  try {
    let verification = await VerificationDocument.findOne({ phone: req.user.phone });

    if (!verification) {
      verification = new VerificationDocument({
        userId: req.user._id || req.user.phone,
        phone: req.user.phone,
        overallVerificationStatus: 'pending',
        accountStatus: 'restricted',
      });
      await verification.save();
    }

    res.json({ success: true, verification });
  } catch (err) {
    console.error('Verification status error:', err);
    res.status(500).json({ success: false, message: 'Error fetching verification status' });
  }
});

// ---------- CANCELLATION LOG ENDPOINTS ----------
app.post('/jobs/cancel/:id', authenticateToken, async (req, res) => {
  try {
    const { reason, reasonDescription } = req.body;
    const jobId = req.params.id;

    if (!reason) {
      return res.status(400).json({ success: false, message: 'Cancellation reason required' });
    }

    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    // Determine who is cancelling
    let cancelledBy = 'admin';
    if (req.user.phone === job.contractorPhone) cancelledBy = 'contractor';
    if (req.user.phone === job.acceptedBy) cancelledBy = 'worker';

    // ✅ CORRECT REFUND LOGIC:
    // - When contractor cancels BEFORE acceptance: refund only ₹25 platform fee (that was deducted)
    // - When contractor cancels AFTER acceptance: no refund (worker already agreed to do job, contractor pays)
    // - When worker cancels: no refund (worker forfeited job)
    let refundAmount = 0;
    let cancellationFee = 0;

    if (cancelledBy === 'contractor' && !job.acceptedBy) {
      // No worker accepted yet - refund only the ₹25 platform fee that was deducted
      refundAmount = 25;
    }
    // If worker accepted and then either cancels, or contractor cancels: NO REFUND
    // The ₹25 platform fee and job amount stay with platform/contractor

    // Log cancellation
    const cancellation = new CancellationLog({
      jobId,
      contractorPhone: job.contractorPhone,
      contractorName: job.contractorName,
      workerPhone: job.acceptedBy,
      cancelledBy,
      reason,
      reasonDescription,
      jobAmount: job.amount,
      cancellationFee,
      refundAmount,
      refundToPhone: job.contractorPhone,
      cancelledAt: new Date(),
    });

    await cancellation.save();

    // Update job status
    job.status = 'cancelled';
    await job.save();

    // ✅ Process refund ONLY when contractor cancels before acceptance
    if (refundAmount > 0 && cancelledBy === 'contractor' && !job.acceptedBy) {
      let wallet = await Wallet.findOne({ phone: job.contractorPhone });
      if (!wallet) {
        wallet = new Wallet({ phone: job.contractorPhone });
      }
      wallet.balance += refundAmount;
      wallet.transactions.push({
        type: 'refund',
        amount: refundAmount,
        date: new Date(),
      });
      await wallet.save();
      console.log(`💰 Refunded ₹${refundAmount} to contractor ${job.contractorPhone}`);
    }

    // ✅ EMIT CANCELLATION EVENT TO ALL USERS
    // Notify contractor and any workers viewing/considering this job
    const cancellationPayload = {
      ...job.toObject(),
      _id: job._id.toString(), // ✅ Ensure _id is a string for consistent comparison
      id: job._id.toString(), // ✅ Also include as 'id' for compatibility
      status: 'cancelled',
      cancelledBy,
      cancelledAt: new Date(),
    };

    // ✅ Send to ALL connected sockets so all workers see it immediately
    io.emit('jobCancelled', cancellationPayload);
    console.log(`📤 Broadcasted job cancellation event for job ${jobId} to all users`);

    // Clear any pending timeouts related to this job (retry/timeouts/expiry)
    try {
      if (pendingJobTimeouts.has(jobId)) {
        clearTimeout(pendingJobTimeouts.get(jobId));
        pendingJobTimeouts.delete(jobId);
        console.log(`🧹 Cleared pending retry timeout for cancelled job ${jobId}`);
      }
      if (pendingJobExpirations.has(jobId)) {
        clearTimeout(pendingJobExpirations.get(jobId));
        pendingJobExpirations.delete(jobId);
        console.log(`🧹 Cleared expiry timer for cancelled job ${jobId}`);
      }
    } catch (e) {
      console.error('Error clearing timeouts on cancellation:', e);
    }
    
    // Also specifically target workers who might have seen this job
    if (job.declinedBy && job.declinedBy.length > 0) {
      console.log(`📤 Job was declined by ${job.declinedBy.length} workers, they will see cancellation`);
    }

    // Log activity
    await ActivityLog.create({
      userId: req.user._id || req.user.phone,
      phone: req.user.phone,
      action: 'job_cancelled',
      jobId,
      description: `Job cancelled by ${cancelledBy}: ${reason}`,
      status: 'success',
      metadata: { reason, refundAmount, cancellationFee },
    });

    // If worker cancelled, record cancellation in worker's workHistory for milestone tracking
    try {
      if (cancelledBy === 'worker' && job.acceptedBy) {
        const worker = await WorkerModel.findOne({ phone: job.acceptedBy });
        if (worker && typeof worker.recordWork === 'function') {
          worker.recordWork(new Date(), 0, true);
          await worker.save();
          console.log(`📉 Recorded cancellation for ${job.acceptedBy} due to job cancel`);
        }
      }
    } catch (recErr) {
      console.error('Error recording work cancellation on job cancel endpoint:', recErr);
    }
    console.log(`❌ Job ${jobId} cancelled by ${cancelledBy}. Refunded: ₹${refundAmount}`);
    res.json({ success: true, cancellation, message: 'Job cancelled successfully' });
  } catch (err) {
    console.error('Job cancellation error:', err);
    res.status(500).json({ success: false, message: 'Error cancelling job' });
  }
});

app.get('/jobs/cancellations', authenticateToken, async (req, res) => {
  try {
    const cancellations = await CancellationLog.find({
      $or: [
        { contractorPhone: req.user.phone },
        { workerPhone: req.user.phone }
      ]
    })
      .sort({ cancelledAt: -1 })
      .limit(50);

    res.json({ success: true, cancellations, count: cancellations.length });
  } catch (err) {
    console.error('Fetch cancellations error:', err);
    res.status(500).json({ success: false, message: 'Error fetching cancellations' });
  }
});

// ---------- NOTIFICATION HISTORY ENDPOINTS ----------
app.get('/notifications', authenticateToken, async (req, res) => {
  try {
    const { unreadOnly = false, limit = 50, skip = 0 } = req.query;

    let query = { recipientPhone: req.user.phone };
    if (unreadOnly === 'true') {
      query.isRead = false;
    }

    const notifications = await NotificationHistory.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(skip));

    const total = await NotificationHistory.countDocuments(query);
    const unreadCount = await NotificationHistory.countDocuments({
      recipientPhone: req.user.phone,
      isRead: false,
    });

    res.json({ success: true, notifications, total, unreadCount });
  } catch (err) {
    console.error('Fetch notifications error:', err);
    res.status(500).json({ success: false, message: 'Error fetching notifications' });
  }
});

app.put('/notifications/:id/read', authenticateToken, async (req, res) => {
  try {
    const notification = await NotificationHistory.findByIdAndUpdate(
      req.params.id,
      { isRead: true, readAt: new Date() },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ success: false, message: 'Notification not found' });
    }

    // ✅ Emit socket event to update notification count for this user
    const unreadCount = await NotificationHistory.countDocuments({
      recipientPhone: req.user.phone,
      isRead: false,
    });

    io.emit('notificationCountUpdated', {
      recipientPhone: req.user.phone,
      unreadCount: unreadCount,
    });

    res.json({ success: true, notification });
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ success: false, message: 'Error updating notification' });
  }
});

app.put('/notifications/read-all', authenticateToken, async (req, res) => {
  try {
    await NotificationHistory.updateMany(
      { recipientPhone: req.user.phone, isRead: false },
      { isRead: true, readAt: new Date() }
    );

    // ✅ Emit socket event to update notification count for this user
    io.emit('notificationCountUpdated', {
      recipientPhone: req.user.phone,
      unreadCount: 0,
    });

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Mark all notifications read error:', err);
    res.status(500).json({ success: false, message: 'Error updating notifications' });
  }
});

// ✅ VERIFY WORKER PROFILE IS COMPLETE (CHECK MAIN SKILL & WAGE)
app.post('/workers/verify-profile', authenticateToken, async (req, res) => {
  try {
    const phone = req.user.phone;

    console.log(`\n🔍 Profile verification request for phone: ${phone}`);

    // Find user and check mainSkill and expectedWage
    const user = await User.findOne({ phone });

    if (!user) {
      console.error(`❌ User not found for phone: ${phone}`);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    console.log(`📋 User found: ${user.name}`);
    console.log(`   - mainSkill: ${user.mainSkill || 'NOT SET'}`);
    console.log(`   - expectedWage: ${user.expectedWage || 'NOT SET'}`);

    // Check if both mainSkill and expectedWage are set
    const isProfileComplete = !!(user.mainSkill && user.expectedWage);

    if (isProfileComplete) {
      console.log(`✅ Profile is COMPLETE - User can go online`);
      return res.status(200).json({ 
        success: true, 
        message: 'Profile is complete',
        isProfileComplete: true,
        mainSkill: user.mainSkill,
        expectedWage: user.expectedWage
      });
    } else {
      console.log(`❌ Profile is INCOMPLETE`);
      return res.status(200).json({ 
        success: false, 
        message: 'Profile is incomplete. Please set Main Skill and Expected Wage.',
        isProfileComplete: false,
        missingFields: {
          mainSkill: !user.mainSkill,
          expectedWage: !user.expectedWage
        }
      });
    }
  } catch (err) {
    console.error(`❌ Profile verification error:`, err);
    res.status(500).json({ success: false, message: 'Failed to verify profile', error: err.message });
  }
});

// ✅ UPDATE WORKER AVAILABILITY (ONLINE/OFFLINE)
app.put('/workers/availability', authenticateToken, async (req, res) => {
  try {
    const { isAvailable } = req.body;
    const phone = req.user.phone;

    console.log(`\n📱 Availability toggle request for phone: ${phone}`);
    console.log(`🔘 Setting isAvailable to: ${isAvailable}`);

    // Validate input
    if (typeof isAvailable !== 'boolean') {
      console.error(`❌ Invalid isAvailable type: ${typeof isAvailable}`);
      return res.status(400).json({ success: false, message: 'isAvailable must be a boolean' });
    }

    // ✅ Update User model (PRIMARY - where user profile lives)
    console.log(`🔄 Updating User model for phone: ${phone}`);
    const updatedUser = await User.findOneAndUpdate(
      { phone: phone },
      { 
        isAvailable: isAvailable,
        updatedAt: new Date()
      },
      { new: true }
    );

    console.log(`✅ User model updated:`, updatedUser ? `${updatedUser.name} (${updatedUser.phone}) - isAvailable: ${updatedUser.isAvailable}` : 'null');

    if (!updatedUser) {
      console.error(`❌ User not found in database for phone: ${phone}`);
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    // Verify update actually persisted
    const userAfter = await User.findOne({ phone });
    console.log(`📊 User After update - isAvailable: ${userAfter?.isAvailable}`);

    if (userAfter?.isAvailable !== isAvailable) {
      console.error(`❌ USER UPDATE FAILED! Expected ${isAvailable}, got ${userAfter?.isAvailable}`);
    }

    // ✅ Also update Worker model for consistency
    console.log(`🔄 Updating Worker model for phone: ${phone}`);
    const updatedWorker = await WorkerModel.findOneAndUpdate(
      { phone: phone },
      { 
        isAvailable: isAvailable,
        updatedAt: new Date()
      },
      { new: true }
    );

    console.log(`✅ Worker model updated:`, updatedWorker ? `${updatedWorker.name} (${updatedWorker.phone}) - isAvailable: ${updatedWorker.isAvailable}` : 'null');

    // ✅ Update connectedWorkers map in real-time
    let found = false;
    for (const [socketId, worker] of connectedWorkers.entries()) {
      if (worker.phone === phone) {
        worker.isAvailable = isAvailable;
        console.log(`🔄 Updated connected worker ${worker.name} isAvailable to: ${isAvailable}`);
        found = true;
        break;
      }
    }
    
    if (!found) {
      console.warn(`⚠️ Worker ${phone} not found in connectedWorkers map. Total connected: ${connectedWorkers.size}`);
      console.warn(`📋 Connected workers:`, Array.from(connectedWorkers.values()).map(w => `${w.name} (${w.phone})`).join(', '));
    }

    console.log(`✅ ${phone} availability updated to: ${isAvailable}\n`);

    res.json({ 
      success: true, 
      message: `Worker is now ${isAvailable ? 'online' : 'offline'}`,
      user: {
        phone: updatedUser.phone,
        name: updatedUser.name,
        isAvailable: updatedUser.isAvailable,
        role: updatedUser.role
      }
    });
  } catch (err) {
    console.error('❌ Update worker availability error:', err);
    res.status(500).json({ success: false, message: 'Error updating worker availability', error: err.message });
  }
});

// ✅ REFRESH FCM TOKEN - Update user's FCM token when they reopen app
app.post("/auth/refresh-fcm-token", authenticateToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    
    if (!fcmToken) {
      return res.status(400).json({ success: false, message: "FCM token required" });
    }

    const user = await User.findOne({ phone: req.user.phone });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Update FCM token
    user.fcmToken = fcmToken;
    await user.save();

    console.log(`📱 FCM token refreshed for ${req.user.phone}: ${fcmToken.substring(0, 30)}...`);
    res.json({ success: true, message: "FCM token updated" });
  } catch (err) {
    console.error("Error refreshing FCM token:", err);
    res.status(500).json({ success: false, message: "Internal server error" });
  }
});



// 🐛 DEBUG: List all workers with their locations (for troubleshooting)
app.get('/debug/workers-locations', authenticateToken, async (req, res) => {
  try {
    const workers = await WorkerModel.find({}).select('phone name location isAvailable').lean();
    const formattedWorkers = workers.map(w => ({
      phone: w.phone,
      name: w.name,
      location: w.location?.coordinates || [0, 0],
      isAvailable: w.isAvailable
    }));
    return res.json({ 
      success: true, 
      count: workers.length,
      workers: formattedWorkers 
    });
  } catch (err) {
    console.error('debug/workers-locations error', err);
    return res.status(500).json({ success: false, message: 'Error fetching workers', error: err.message });
  }
});

// 🐛 DEBUG: Check if 2dsphere index exists and test $geoNear query
app.get('/debug/geo-test', authenticateToken, async (req, res) => {
  try {
    const { lat = 26.9988724, lon = 75.9130502 } = req.query;
    
    // Check indexes on Worker collection
    const indexes = await WorkerModel.collection.getIndexes();
    console.log('Worker collection indexes:', indexes);

    // Try a simple $geoNear query
    const result = await WorkerModel.aggregate([
      {
        $geoNear: {
          near: { type: 'Point', coordinates: [parseFloat(lon), parseFloat(lat)] },
          distanceField: 'distance',
          maxDistance: 100000, // 100km for testing
          spherical: true
        }
      },
      { $limit: 10 }
    ]);

    console.log(`✅ $geoNear test: Found ${result.length} workers`);

    return res.json({ 
      success: true, 
      message: '$geoNear query executed successfully',
      indexes: indexes,
      testCoordinates: [parseFloat(lon), parseFloat(lat)],
      resultCount: result.length,
      workers: result.slice(0, 5).map(w => ({
        phone: w.phone,
        distance: w.distance,
        location: w.location?.coordinates
      }))
    });
  } catch (err) {
    console.error('❌ debug/geo-test error', err);
    return res.status(500).json({ success: false, message: 'Geo test failed', error: err.message });
  }
});

// ✅ Start leaderboard scheduler when server starts
setTimeout(() => {
  startLeaderboardScheduler();
}, 2000); // Wait 2 seconds for DB to stabilize

// ---------------- START SERVER ----------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running with Socket.io on port ${PORT}`);
});
