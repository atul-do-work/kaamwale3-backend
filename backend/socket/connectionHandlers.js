function attachSocketConnectionHandlers(io, deps) {
  const { scheduleDispatchState, cancelDispatchState } = require("../services/dispatchStateService");
  const {
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
  } = deps;

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
                const payload = { ...jobCheck.toObject(), _id: jobCheck._id.toString(), id: jobCheck._id.toString(), status: 'expired', expiredAt: new Date() };
                const targetUsers = [
                  jobCheck.contractorPhone,
                  jobCheck.contractorName,
                  jobCheck.acceptedBy,
                  ...(Array.isArray(jobCheck.acceptedWorkers) ? jobCheck.acceptedWorkers.map((w) => w?.phone).filter(Boolean) : []),
                ];
                if (typeof emitJobCancelledToUsers === 'function') {
                  await emitJobCancelledToUsers(payload, targetUsers);
                } else {
                  io.emit('jobCancelled', payload);
                }
                if (pendingJobTimeouts.has(jobCheck._id.toString())) {
                  clearTimeout(pendingJobTimeouts.get(jobCheck._id.toString()));
                  pendingJobTimeouts.delete(jobCheck._id.toString());
                }
                pendingJobExpirations.delete(jobCheck._id.toString());
                await cancelDispatchState({ jobId: jobCheck._id, reason: "expired_socket_post" });
              }
            } catch (e) {
              console.error('Error expiring job (socket post):', e);
            }
          }, EXPIRE_MS);
          pendingJobExpirations.set(newJob._id.toString(), expireId);
          await scheduleDispatchState({
            jobId: newJob._id,
            type: "expire_offer",
            runAt: new Date(Date.now() + EXPIRE_MS),
            metadata: { source: "socket_post" },
          });
        } catch (e) {
          console.error('Error scheduling job expiry (socket post):', e);
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

}

module.exports = {
  attachSocketConnectionHandlers,
};
