require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const http = require("http");
const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const rateLimit = require("express-rate-limit");
// const { v4: uuidv4 } = require("uuid"); // No longer needed - using MongoDB _id
const { getDistanceFromLatLonInKm } = require("./utils/distance");
const { authenticateToken } = require("./utils/auth"); // ✅ Centralized auth middleware
const multer = require("multer"); // ✅ For profile photo uploads
const mongoose = require("mongoose");
const WorkerModel = require("./models/Worker");
const { findNearbyWorkers } = require("./services/matchingService");

// ---------------- CONFIG ----------------
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

// ---------------- MONGODB CONNECTION ----------------
mongoose.connect(process.env.MONGO_URI || "mongodb://127.0.0.1:27017/kaamwale")
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

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/uploads", express.static(path.join(__dirname, "uploads"))); // ✅ serve uploaded images

// ✅ Mount wallet routes for deposit/withdraw
const walletRoutes = require("./routes/wallet");
app.use("/wallet", walletRoutes);

// ✅ Mount Razorpay payment routes
const razorpayRoutes = require("./routes/razorpay");
app.use("/api/payment", razorpayRoutes);

// ✅ Mount leaderboard routes
const leaderboardRoutes = require("./routes/leaderboardRoutes");
app.use("/leaderboard", leaderboardRoutes);

// ✅ Import and start leaderboard scheduler
const { startLeaderboardScheduler } = require("./services/leaderboardScheduler");

// Ensure uploads folder exists
const fs = require("fs").promises;
const uploadsDir = path.join(__dirname, "uploads");
fs.mkdir(uploadsDir, { recursive: true }).catch(console.error);

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

// ✅ HELPER: Update contractor stats for a given day
async function updateContractorStats(phone) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Fetch today's jobs for this contractor (using phone)
    const todayJobs = await Job.find({
      contractorPhone: phone,
      createdAt: { $gte: today }
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
    
    // ✅ DYNAMIC: Find nearby workers RIGHT NOW (not from stored list)
    const currentNearbyWorkers = findNearbyWorkers(
      { lat: job.lat, lon: job.lon, workerType: job.workerType },
      connectedWorkers
    );
    
    console.log(`🔍 Dynamic search: Found ${currentNearbyWorkers.length} nearby workers (${declinedWorkerNames.length} declined)`);
    
    // Find first worker who hasn't declined AND doesn't have unpaid jobs AND is ONLINE
    let nextWorker = null;
    for (const worker of currentNearbyWorkers) {
      if (declinedWorkerNames.includes(worker.name)) {
        continue; // Skip declined workers
      }
      
      // ✅ CHECK: Is worker online/available in USER model (primary source of truth)?
      const userRecord = await User.findOne({ phone: worker.phone });
      if (!userRecord || !userRecord.isAvailable) {
        console.log(`🔴 Worker ${worker.name} (${worker.phone}) is OFFLINE in User model (isAvailable: ${userRecord?.isAvailable}), skipping...`);
        continue; // Skip offline workers
      }
      
      // ✅ CHECK: Does this worker have an unpaid job?
      const hasUnpaidJob = await Job.findOne({
        acceptedBy: worker.name,
        paymentStatus: { $ne: "Paid" }
      });
      
      if (hasUnpaidJob) {
        console.log(`⏭️ Worker ${worker.name} has unpaid job, skipping...`);
        continue; // Skip workers with unpaid jobs
      }
      
      // This worker is available!
      nextWorker = worker;
      break;
    }
    
    if (!nextWorker) {
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
    
    // Found a worker! Offer the job
    console.log(`📤 Offering job ${job._id} to worker: ${nextWorker.name} (distance: ${nextWorker.distance}km)`);

    const workerSocket = io.sockets.sockets.get(nextWorker.socketId);
    if (workerSocket) {
      workerSocket.emit("newJob", {
        ...job.toObject(),
        distance: nextWorker.distance,
        totalNearbyWorkers: currentNearbyWorkers.length,
      });
      
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
            existing.isAvailable = true;
            await existing.save();
            // keep a lightweight map for quick access
            connectedWorkers.set(socket.id, {
              name: existing.phone || user.name,
              phone: existing.phone,
              lat: existing.location?.coordinates?.[1] || 0,
              lon: existing.location?.coordinates?.[0] || 0,
              workerType: existing.skills && existing.skills[0],
              socketId: socket.id,
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

      console.log("Worker Registered:", name, "at", { lat, lon });

      // Persist session in Worker collection (upsert)
      try {
        const loc = {
          type: "Point",
          coordinates: [lon || 0, lat || 0],
        };

        // Fetch User record to get profilePhoto
        let profilePhoto = null;
        try {
          const userRecord = await User.findOne({ phone });
          if (userRecord) {
            profilePhoto = userRecord.profilePhoto;
          }
        } catch (e) {
          console.error("Error fetching user profile photo for worker:", e);
        }

        const updated = await WorkerModel.findOneAndUpdate(
          { phone },
          { $set: { name, socketId: socket.id, isAvailable: true, location: loc, profilePhoto } },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        connectedWorkers.set(socket.id, {
          name,
          phone,
          lat: lat || 0,
          lon: lon || 0,
          workerType: workerType || (updated.skills && updated.skills[0]),
          socketId: socket.id,
          isAvailable: true, // ✅ Add isAvailable status
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
const upload = multer({ storage });

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
    return res.json({ success: true, profilePhoto: user.profilePhoto });
  } catch (err) {
    console.error("Profile photo upload error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ---------------- USER ROUTES ----------------
app.post("/users/register", async (req, res) => {
  try {
    const { name, phone, password, role } = req.body;
    if (!name || !phone || !password || !role)
      return res.status(400).json({ success: false, message: "All fields required" });

    const existingUser = await User.findOne({ phone });
    if (existingUser) return res.status(400).json({ success: false, message: "Phone already registered" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, phone, password: hashedPassword, role });
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

    // issue refresh token and access token
    const accessToken = jwt.sign({ name, phone, role }, JWT_SECRET, { expiresIn: "1h" });
    const refreshToken = require("crypto").randomBytes(40).toString("hex");
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days
    newUser.refreshTokens.push({ token: refreshToken, issuedAt: new Date(), expiresAt, deviceInfo: req.headers['user-agent'] || 'unknown' });
    await newUser.save();

    return res.json({ success: true, user: { name, phone, role }, accessToken, refreshToken });
  } catch (err) {
    console.error("Register error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

app.post("/login", loginLimiter, async (req, res) => {
  try {
    console.log("📱 Login request body:", req.body);
    console.log("📝 Headers:", req.headers);
    const { phone, password, latitude, longitude } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, message: "Phone and password required" });
    }
    const user = await User.findOne({ phone });
    if (!user) return res.status(401).json({ success: false, message: "Invalid phone or password" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ success: false, message: "Invalid phone or password" });

    // ✅ NEW: Handle location for contractors
    let cityLeaderboard = null;
    if (user.role === 'contractor' && latitude && longitude) {
      try {
        const axios = require('axios');
        const { normalizeLocation } = require('./utils/cityHierarchy');
        
        const geoResponse = await axios.get(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`,
          {
            headers: { 'User-Agent': 'KaamwaleApp/1.0' },
            timeout: 5000,
          }
        );

        const geoData = geoResponse.data;
        let detectedCity = (
          geoData.address?.city ||
          geoData.address?.town ||
          geoData.address?.village ||
          geoData.address?.county ||
          'Unknown'
        );
        let detectedState = (geoData.address?.state || 'Unknown');

        // ✅ NEW: Normalize to parent city (e.g., Mulshi → Pune)
        const normalized = normalizeLocation(detectedCity, detectedState);
        const city = normalized.city;
        const state = normalized.state;

        // Update user's location with normalized city
        user.city = city;
        user.state = state;
        user.latitude = parseFloat(latitude);
        user.longitude = parseFloat(longitude);
        user.locationLastUpdated = new Date();
        await user.save();

        console.log(`📍 Location: ${detectedCity} → ${city}, ${state}${normalized.isMapped ? ' (mapped)' : ''}`);

        // ✅ NEW: Auto-invalidate old cache for this city when new contractor logs in
        // This ensures fresh leaderboard calculation with latest contractors
        const CityLeaderboard = require('./models/CityLeaderboard');
        await CityLeaderboard.deleteOne({ city, state });
        console.log(`🔄 Cleared old leaderboard cache for ${city}, ${state}`);

        // Fetch city leaderboard (will calculate fresh since cache was cleared)
        const { calculateCityLeaderboard } = require('./services/leaderboardService');
        const leaderboardData = await calculateCityLeaderboard(city, state);

        let leaderboard = await CityLeaderboard.findOneAndUpdate(
          { city, state },
          {
            city,
            state,
            leaderboard: leaderboardData,
            totalContractors: leaderboardData.length,
            calculatedAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
          { upsert: true, new: true }
        );

        const currentUserRank = leaderboard.leaderboard.find(
          (item) => item.contractorId.toString() === user._id.toString()
        );

        cityLeaderboard = {
          city,
          state,
          totalContractors: leaderboard.totalContractors,
          leaderboard: leaderboard.leaderboard,
          myRank: currentUserRank?.rank || null,
          myScore: currentUserRank?.score || 0,
        };

        console.log(`✅ Updated location for contractor: ${city}, ${state}`);
      } catch (err) {
        console.warn('⚠️ Could not get city leaderboard:', err.message);
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

// ✅ DELETE: Remove old premium endpoints by not including them - this simplifies the API

// ---------------- AUTH - OTP & REFRESH ----------------
// Request OTP (dev-mode: prints OTP to console). If user doesn't exist, create a record.
app.post('/auth/request-otp', async (req, res) => {
  try {
    const { phone, name, role } = req.body;
    if (!phone) return res.status(400).json({ success: false, message: 'Phone is required' });

    let user = await User.findOne({ phone });
    if (!user) {
      user = new User({ phone, name: name || 'Unknown', role: role || 'worker' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiry = new Date(Date.now() + 1000 * 60 * 5); // 5 minutes
    user.otpCode = otp;
    user.otpExpiry = expiry;
    await user.save();

    // In development print OTP to console. Replace with SMS provider in production.
    console.log(`🔐 OTP for ${phone}: ${otp} (expires ${expiry.toISOString()})`);

    return res.json({ success: true, message: 'OTP generated (dev-mode), check server logs' });
  } catch (err) {
    console.error('Request OTP error', err);
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
app.post("/jobs/post", authenticateToken, async (req, res) => {
  try {
    const { title, description, workerType, amount, lat, lon, date } = req.body;
    const contractorName = req.user.name;

    if (!title || !lat || !lon)
      return res.status(400).json({ success: false, message: "Missing required fields" });

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone });
      await wallet.save();
    }

    if (wallet.balance < 200)
      return res.status(400).json({
        success: false,
        message: "Insufficient wallet balance to post job (min ₹200 required)"
      });

    wallet.balance -= 25;
    wallet.transactions.push({
      type: "job_post_fee",
      amount: 25,
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
      lat,
      lon,
      date: date || new Date(),
      status: "pending",
      declinedBy: [],
    });
    await newJob.save();

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

    console.log(`✅ Accept request for job: ${jobId} by worker: ${workerName}`);

    // ✅ CHECK: Worker cannot accept multiple simultaneous jobs
    // Find if worker has any unpaid job
    const hasUnpaidJob = await Job.findOne({
      acceptedBy: workerName,
      paymentStatus: { $ne: "Paid" }  // Any job that's not paid yet
    });

    if (hasUnpaidJob) {
      console.log(`❌ Worker ${workerName} already has unpaid job: ${hasUnpaidJob._id}`);
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
      
      if (workerRecord) {
        acceptedWorkerSnapshot = {
          id: workerRecord._id.toString(),
          name: req.user.name || req.user.phone,
          phone: workerRecord.phone,
          skills: workerRecord.skills || [],
          profilePhoto: userRecord?.profilePhoto || null, // ✅ Get from User model
          location: workerRecord.location || null,
        };
      }
    } catch (e) {
      console.error("Error fetching worker record for accept snapshot:", e);
    }

    // Atomic update: only accept if status is still 'pending'
    const updated = await Job.findOneAndUpdate(
      { _id: jobId, status: "pending" },
      { $set: { status: "accepted", acceptedBy: workerName, acceptedWorker: acceptedWorkerSnapshot, acceptedAt: new Date() } },
      { new: true }
    );

    if (!updated) {
      console.log(`❌ Job ${jobId} was already taken or not found`);
      return res.status(400).json({ success: false, message: "Job already accepted or not found" });
    }

    console.log(`✅ Job accepted successfully by ${workerName}`);
    
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
    
    // If job was accepted by this worker, reset status to pending and clear tracking
    if (job.acceptedBy === workerName && job.status === "accepted") {
      job.status = "pending";
      job.acceptedBy = null;
      job.acceptedWorker = null;
      job.acceptedAt = null;
      // Stop tracking location for this declined job
      if (trackingJobs.has(jobId)) {
        trackingJobs.delete(jobId);
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

    availableJobs.forEach((j) => {
      j.distance = getDistanceFromLatLonInKm(lat, lon, j.lat, j.lon);
    });

    availableJobs.sort((a, b) => a.distance - b.distance);
    return res.json(availableJobs);
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
    
    // Get all jobs accepted by this worker - explicitly include all fields
    const jobs = await Job.find({ acceptedBy: workerName }).lean();
    
    // Log jobs with rating info for debugging
    jobs.forEach((job) => {
      if (job.rating) {
        console.log(`⭐ Fetched job ${job._id} with rating:`, job.rating);
      }
    });
    
    console.log(`✅ Worker ${workerPhone} retrieved ${jobs.length} accepted jobs`);
    res.json(jobs);
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

    // Targeted: notify contractor and worker about payment
    await emitJobUpdatedToUsers(job, [job.contractorName, job.acceptedBy || job.contractorName]);
    return res.json({ success: true, message: "Payment successful", job });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ success: false, message: "Internal server error" });
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
app.post('/verification/upload', authenticateToken, async (req, res) => {
  try {
    const { type, fileUrl, documentNumber, expiryDate } = req.body;

    if (!type || !fileUrl) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
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

    const document = {
      type,
      fileUrl,
      fileName: `${type}_${Date.now()}`,
      documentNumber,
      uploadedAt: new Date(),
      verificationStatus: 'pending',
      expiryDate: expiryDate ? new Date(expiryDate) : undefined,
    };

    verification.documents.push(document);
    await verification.save();

    console.log(`📄 Document uploaded: ${type} by ${req.user.phone}`);
    res.json({ success: true, verification, message: 'Document uploaded for verification' });
  } catch (err) {
    console.error('Document upload error:', err);
    res.status(500).json({ success: false, message: 'Error uploading document' });
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

    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('Mark all notifications read error:', err);
    res.status(500).json({ success: false, message: 'Error updating notifications' });
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

// ============================================================
// START SERVER
// ============================================================

// ✅ Start leaderboard scheduler when server starts
setTimeout(() => {
  startLeaderboardScheduler();
}, 2000); // Wait 2 seconds for DB to stabilize

// ---------------- START SERVER ----------------
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running with Socket.io on port ${PORT}`);
});
