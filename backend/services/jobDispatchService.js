function createJobDispatchHelpers(deps) {
  const {
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
  } = deps;
  const { scheduleDispatchState } = require("./dispatchStateService");
  const offerInFlightLocks = new Set();
  const recentOfferTargets = new Map(); // key: `${jobId}:${phone}` -> ts
  const RECENT_OFFER_TTL_MS = 15000;

  const cleanupRecentOffers = () => {
    const now = Date.now();
    for (const [key, ts] of recentOfferTargets.entries()) {
      if (now - ts > RECENT_OFFER_TTL_MS) {
        recentOfferTargets.delete(key);
      }
    }
  };

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

    // ✅ CRITICAL: Check if worker has unpaid jobs before offering new ones
    const hasUnpaidJob = await Job.findOne({
      $and: [
        {
          $or: [
            { acceptedBy: workerPhone, paymentStatus: { $ne: "paid" } }, // Single job
            {
              acceptedWorkers: {
                $elemMatch: {
                  phone: workerPhone,
                  paymentStatus: { $ne: "paid" },
                },
              },
            }, // Bulk job (per-worker)
          ],
        },
        { status: { $nin: ["cancelled", "expired", "completed"] } },
      ],
    });

    if (hasUnpaidJob) {
      console.log(`⏭️ Worker ${workerPhone} has unpaid job, skipping job matching...`);
      return; // Skip workers with unpaid jobs
    }

    // ✅ OPTIMIZATION: Use geospatial aggregation instead of N+1 queries
    // Build wage range filter
    const workerWage = userRecord.expectedWage;
    const wageRanges = {
      "0-400": { min: 0, max: 400 },
      "400-550": { min: 400, max: 550 },
      "550-700": { min: 550, max: 700 },
      "700-max": { min: 700, max: 999999 }
    };
    const wageRange = wageRanges[workerWage];
    
    // Build aggregation pipeline for efficient geospatial matching
    const pipeline = [
      {
        $geoNear: {
          near: {
            type: "Point",
            coordinates: [workerLon, workerLat] // [longitude, latitude]
          },
          key: "jobLocation",
          distanceField: "distanceKm",
          maxDistance: 15000, // 15km in meters
          spherical: true,
          query: {
            status: "pending",
            declinedBy: { $ne: workerPhone }, // Worker hasn't declined this job
            ...(userRecord.mainSkill && { workerType: userRecord.mainSkill }), // Skill match using workerType field
            ...(wageRange && {
              amount: {
                $gte: wageRange.min,
                $lte: wageRange.max
              }
            })
          }
        }
      },
      {
        $lookup: {
          from: "users",
          let: { contractorPhone: "$contractorPhone" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$phone", "$$contractorPhone"] }
              }
            },
            {
              $project: {
                premiumPlan: 1,
                isAvailable: 1
              }
            }
          ],
          as: "contractor"
        }
      },
      {
        $match: {
          "contractor.0.isAvailable": { $ne: false } // Contractor is available
        }
      },
      {
        $sort: {
          distanceKm: 1, // Closest jobs first
          createdAt: -1 // Most recent first
        }
      },
      {
        $limit: 10 // Limit results to prevent overload
      }
    ];

    const matchingJobIds = await Job.aggregate([...pipeline, { $project: { _id: 1 } }]);
    console.log(`📋 [Availability] Found ${matchingJobIds.length} matching jobs for ${workerPhone}...`);
    
    let matchCount = 0;
    for (const jobRef of matchingJobIds) {
      const jobId = jobRef._id;
      // ✅ FIX: Fetch full Mongoose document (aggregation returns plain objects without .toObject())
      const fullJob = await Job.findById(jobId);
      if (!fullJob || fullJob.status !== 'pending') continue;
      
      console.log(`✅ [Availability] Worker ${workerPhone} matches job ${jobId} (${fullJob.title}, ₹${fullJob.amount})`);
      matchCount++;
      
      // Offer the job with full Mongoose document
      await offerJobToNextWorker(fullJob);
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
  const jobId = String(job?._id || "");
  if (!jobId) return;
  if (offerInFlightLocks.has(jobId)) {
    return;
  }
  offerInFlightLocks.add(jobId);
  try {
    // ✅ FIX: Fetch full Mongoose document to ensure .toObject() works (aggregation results are plain objects)
    const currentJob = await Job.findById(jobId).lean();
    if (!currentJob || currentJob.status !== 'pending') {
      console.log(`⏹️ Job ${jobId} is no longer pending (${currentJob?.status ?? 'missing'}) - aborting offer`);
      offerInFlightLocks.delete(jobId);
      return;
    }
    cleanupRecentOffers();
    const declinedWorkerIds = Array.isArray(job.declinedBy) ? job.declinedBy : [];
    
    // Clear previous timeout
    if (pendingJobTimeouts.has(job._id.toString())) {
      clearTimeout(pendingJobTimeouts.get(job._id.toString()));
      pendingJobTimeouts.delete(job._id.toString());
    }
    
    // ✅ PROGRESSIVE RADIUS EXPANSION: Try nearby radii up to maximum 15km
    // Start from closest workers and expand to farther ones, but never beyond 15km
    const radiiToTry = [5, 10, 15]; // km
    let currentNearbyWorkers = [];
    let usedRadius = 10;

    for (const radius of radiiToTry) {
      console.log(`🔍 [DISPATCH] Searching for workers within ${radius}km radius...`);
      currentNearbyWorkers = findNearbyWorkers(
        { 
          lat: job.lat, 
          lon: job.lon, 
          mainSkill: job.workerType,
          amount: job.amount, // Job wage
          workerType: job.workerType,
        },
        connectedWorkers,
        radius, // Pass radius parameter
        30 // Max location age: 30 minutes
      );

      console.log(`🔍 [DISPATCH] Found ${currentNearbyWorkers.length} workers within ${radius}km`);
      usedRadius = radius;

      // If we found candidates, break out of the loop
      if (currentNearbyWorkers.length > 0) {
        break;
      }
    }

    console.log(`🔍 Job Details - Title: ${job.title}, Skill: ${job.description}, Amount: ${job.amount}, Location: (${job.lat}, ${job.lon})`);
    console.log(`🔍 Smart matching: Found ${currentNearbyWorkers.length} nearby workers with matching skill & wage within ${usedRadius}km (${declinedWorkerIds.length} declined)`);
    
    // Build list of candidate workers who haven't declined, are online and don't have unpaid jobs
    // ✅ For bulk hiring, also skip workers already in acceptedWorkers
    const acceptedPhones = (job.bulkHiring && job.acceptedWorkers) ? job.acceptedWorkers.map(w => w.phone) : [];
    const candidates = [];
    
    // ✅ BULK OPTIMIZATION: Fetch all user records and unpaid job checks in single queries
    const candidatePhones = currentNearbyWorkers
      .filter(worker => !declinedWorkerIds.includes(worker.phone) && 
                       !(job.bulkHiring && acceptedPhones.includes(worker.phone)))
      .map(worker => worker.phone);
    
    if (candidatePhones.length === 0) {
      // No candidates after filtering
      console.log(`⏳ No candidate workers for job ${job._id} after filtering declined/accepted`);
      // ... existing retry logic ...
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
      await scheduleDispatchState({
        jobId: job._id,
        type: "retry_offer",
        runAt: new Date(Date.now() + RETRY_SECONDS * 1000),
        metadata: { reason: "no_available_workers" },
      });
      offerInFlightLocks.delete(jobId);
      return;
    }

    const [userRecords, workerRecords] = await Promise.all([
      User.find({ phone: { $in: candidatePhones } }).select('phone isAvailable fcmToken expectedWage').lean(),
      WorkerModel.find({ phone: { $in: candidatePhones } }).select('phone mainSkill location socketId').lean(),
    ]);

    const availablePhones = new Set(userRecords.filter(u => u.isAvailable).map(u => u.phone));
    const userMap = new Map(userRecords.map(u => [u.phone, u]));
    const workerMap = new Map(workerRecords.map(w => [w.phone, w]));

    console.log(`🔍 [DISPATCH] Candidate phones after initial filter: ${candidatePhones.length}`);
    console.log(`🔍 [DISPATCH] Available phones (isAvailable=true in DB): ${availablePhones.size}`);
    if (candidatePhones.length !== availablePhones.size) {
      const offlinePhones = candidatePhones.filter(p => !availablePhones.has(p));
      console.log(`⚠️ [DISPATCH] Filtering out OFFLINE workers: ${offlinePhones.join(', ')}`);
    }

    // Bulk check for unpaid jobs
    const unpaidJobs = await Job.find({
      $and: [
        {
          $or: [
            { acceptedBy: { $in: candidatePhones }, paymentStatus: { $ne: "paid" } },
            {
              acceptedWorkers: {
                $elemMatch: {
                  phone: { $in: candidatePhones },
                  paymentStatus: { $ne: "paid" },
                },
              },
            },
          ],
        },
        { status: { $nin: ["cancelled", "expired", "completed"] } },
      ],
    }).select('acceptedBy acceptedWorkers');

    // Build set of phones with unpaid jobs
    const phonesWithUnpaidJobs = new Set();
    unpaidJobs.forEach(job => {
      if (job.acceptedBy && candidatePhones.includes(job.acceptedBy)) {
        phonesWithUnpaidJobs.add(job.acceptedBy);
      }
      if (job.acceptedWorkers) {
        job.acceptedWorkers.forEach(worker => {
          if (candidatePhones.includes(worker.phone) && worker.paymentStatus !== "paid") {
            phonesWithUnpaidJobs.add(worker.phone);
          }
        });
      }
    });

    // Determine contractor location (fall back to job location when missing)
    let contractorLat = job.lat;
    let contractorLon = job.lon;
    try {
      const contractorRecord = await User.findOne({ phone: job.contractorPhone }).select('location.coordinates latitude longitude').lean();
      if (contractorRecord) {
        contractorLat = contractorRecord.location?.coordinates?.[1] ?? contractorRecord.latitude ?? contractorLat;
        contractorLon = contractorRecord.location?.coordinates?.[0] ?? contractorRecord.longitude ?? contractorLon;
      }
    } catch (e) {
      console.error('Error fetching contractor location for prioritization:', e);
    }

    // Filter candidates based on DB skill, wage, availability, unpaid jobs and fresh location
    for (const worker of currentNearbyWorkers) {
      if (!candidatePhones.includes(worker.phone)) continue;

      const userRecord = userMap.get(worker.phone);
      const dbWorkerRecord = workerMap.get(worker.phone);
      const candidateSkill = dbWorkerRecord?.mainSkill || worker.mainSkill;
      const candidateWage = userRecord?.expectedWage ?? worker.expectedWage;
      const candidateLat = dbWorkerRecord?.location?.coordinates?.[1] ?? worker.lat;
      const candidateLon = dbWorkerRecord?.location?.coordinates?.[0] ?? worker.lon;

      if (!availablePhones.has(worker.phone)) {
        console.log(`🔴 [DISPATCH] Worker ${worker.name} (${worker.phone}) is OFFLINE in User model ← BLOCKED from receiving job`);
        continue;
      }

      if (phonesWithUnpaidJobs.has(worker.phone)) {
        console.log(`⏭️ [DISPATCH] Worker ${worker.name} (${worker.phone}) has unpaid job ← BLOCKED from receiving job`);
        continue;
      }

      if (job.workerType && candidateSkill !== job.workerType) {
        console.log(`🔴 [DISPATCH] Worker ${worker.name} (${worker.phone}) skill mismatch: requires ${job.workerType}, has ${candidateSkill}`);
        continue;
      }

      if (!isWageInRange(job.amount, candidateWage)) {
        console.log(`🔴 [DISPATCH] Worker ${worker.name} (${worker.phone}) wage mismatch: job=₹${job.amount}, expects ${candidateWage}`);
        continue;
      }

      const realDist = getDistanceFromLatLonInKm(job.lat, job.lon, candidateLat, candidateLon);
      const contractorDist = getDistanceFromLatLonInKm(contractorLat, contractorLon, candidateLat, candidateLon);
      if (realDist > usedRadius) {
        console.log(`🔴 [DISPATCH] Worker ${worker.name} (${worker.phone}) location moved outside radius: ${realDist.toFixed(2)}km`);
        continue;
      }

      console.log(`✅ [DISPATCH] Worker ${worker.name} (${worker.phone}) is AVAILABLE and eligible ← CAN receive job`);
      candidates.push({
        ...worker,
        mainSkill: candidateSkill,
        expectedWage: candidateWage,
        lat: candidateLat,
        lon: candidateLon,
        distance: Math.round(realDist * 10) / 10,
        contractorDistance: Math.round(contractorDist * 10) / 10,
        socketId: dbWorkerRecord?.socketId || worker.socketId,
      });
    }

    if (!candidates || candidates.length === 0) {
      // No available worker right now - just wait and retry
      console.log(`⏳ No available workers for job ${job._id} - will retry when workers come online`);

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
      await scheduleDispatchState({
        jobId: job._id,
        type: "retry_offer",
        runAt: new Date(Date.now() + RETRY_SECONDS * 1000),
        metadata: { reason: "no_available_workers" },
      });
      offerInFlightLocks.delete(jobId);
      return;
    }

    if (job.bulkHiring) {
      const alreadyAccepted = job.acceptedWorkers ? job.acceptedWorkers.length : 0;
      const slots = Math.max(0, (job.requiredWorkers || 1) - alreadyAccepted);
      if (slots <= 0) {
        console.log(`✅ Job ${job._id} already has required workers accepted`);
        offerInFlightLocks.delete(jobId);
        return;
      }

      console.log(`📤 Bulk offer: offering to up to ${slots} workers from ${candidates.length} candidates`);
      let offered = 0;

      // Prioritize candidates by distance to contractor first, then distance to job
      candidates.sort((a, b) => (a.contractorDistance || 0) - (b.contractorDistance || 0) || (a.distance || 0) - (b.distance || 0));

      for (const candidate of candidates) {
        if (offered >= slots) break;
        const dedupeKey = `${jobId}:${candidate.phone}`;
        if (recentOfferTargets.has(dedupeKey)) continue;
        const workerSocket = io.sockets.sockets.get(candidate.socketId);
        if (!workerSocket) continue;

        try {
          const currentJobBeforeEmit = await Job.findById(job._id).lean();
          if (!currentJobBeforeEmit || currentJobBeforeEmit.status !== 'pending' ||
              (currentJobBeforeEmit.bulkHiring && (currentJobBeforeEmit.acceptedWorkers?.length || 0) >= (currentJobBeforeEmit.requiredWorkers || 1))) {
            console.log(`⏹️ Job ${job._id} is no longer open for bulk offering; aborting further emits`);
            break;
          }

          const realDist = getDistanceFromLatLonInKm(job.lat, job.lon, candidate.lat, candidate.lon);
          if (realDist <= 15) {
            workerSocket.emit("newJob", {
              ...job.toObject(),
              _id: job._id.toString(),
              id: job._id.toString(),
              distance: Math.round(realDist * 10) / 10,
              totalNearbyWorkers: currentNearbyWorkers.length,
              bulkOffer: true,
            });
            recentOfferTargets.set(dedupeKey, Date.now());
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
            offered++;
            console.log(`⏳ Bulk offer sent to ${candidate.name} (${candidate.phone})`);
          } else {
            console.log(`❌ Skipping emit to ${candidate.name} due to distance ${realDist.toFixed(2)}km (>15km)`);
          }
        } catch (emitErr) {
          console.error('Error emitting bulk offer to candidate:', emitErr);
        }

        try {
          const worker = userMap.get(candidate.phone);
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
      }

      if (offered === 0) {
        console.log(`⚠️ No bulk offers were delivered for job ${job._id}; scheduling a retry.`);
      } else {
        // At least one offer sent, proceed to bulk retry timer
      }

      const WORKER_TIMEOUT_SECONDS = 60;
      const timeoutId = setTimeout(async () => {
        try {
          const jobCheck = await Job.findById(job._id);
          if (jobCheck && (!jobCheck.bulkHiring || (jobCheck.acceptedWorkers?.length || 0) < (jobCheck.requiredWorkers || 1))) {
            console.log(`⏱️ Bulk retry timer fired for job ${job._id} after ${WORKER_TIMEOUT_SECONDS}s`);
            await offerJobToNextWorker(jobCheck);
          }
        } catch (e) {
          console.error('Error in bulk job timeout:', e);
        }
      }, WORKER_TIMEOUT_SECONDS * 1000);

      pendingJobTimeouts.set(job._id.toString(), timeoutId);
      await scheduleDispatchState({
        jobId: job._id,
        type: "retry_offer",
        runAt: new Date(Date.now() + WORKER_TIMEOUT_SECONDS * 1000),
        metadata: { reason: "bulk_worker_offer_timeout", offeredCandidates: offered },
      });
      offerInFlightLocks.delete(jobId);
      return;
    }

    // Single-offer flow: pick first candidate
    const nextWorker = candidates[0];
    if (!nextWorker) {
      console.log(`⚠️ No single candidate found after filtering for job ${job._id}`);
      offerInFlightLocks.delete(jobId);
      return;
    }
    
    // ✅ CRITICAL: Verify worker is still online in database before sending offer
    try {
      const workerCheckBeforeOffer = await User.findOne({ phone: nextWorker.phone }).select('isAvailable').lean();
      if (!workerCheckBeforeOffer?.isAvailable) {
        console.log(`🚨 [SAFETY CHECK] Worker ${nextWorker.name} (${nextWorker.phone}) is OFFLINE in database! Cannot offer job ${job._id}`);
        console.log(`⚠️ [SAFETY CHECK] This worker was in candidates but is now offline - possible race condition or socket lag`);
        offerInFlightLocks.delete(jobId);
        return; // Do not offer to offline worker
      }
    } catch (checkErr) {
      console.error(`❌ [SAFETY CHECK] Could not verify worker status before offer:`, checkErr);
    }

    const singleDedupeKey = `${jobId}:${nextWorker.phone}`;
    if (recentOfferTargets.has(singleDedupeKey)) {
      offerInFlightLocks.delete(jobId);
      return;
    }

    const currentJobBeforeEmit = await Job.findById(job._id).lean();
    if (!currentJobBeforeEmit || currentJobBeforeEmit.status !== 'pending') {
      console.log(`⏹️ Job ${job._id} is no longer pending before emit; aborting offer to ${nextWorker.phone}`);
      offerInFlightLocks.delete(jobId);
      return;
    }

    console.log(`📤 [JOB OFFER] Offering job ${job._id} (₹${job.amount}) to worker: ${nextWorker.name} (${nextWorker.phone}) - Skill: ${nextWorker.mainSkill}, Distance: ${nextWorker.distance}km`);

    const workerSocket = io.sockets.sockets.get(nextWorker.socketId);
    if (workerSocket) {
      // Double-check distance server-side and make sure _id is a string
      try {
        const realDist = getDistanceFromLatLonInKm(job.lat, job.lon, nextWorker.lat, nextWorker.lon);
        if (realDist <= 15) {
          workerSocket.emit("newJob", {
            ...job.toObject(),
            _id: job._id.toString(),
            id: job._id.toString(),
            distance: Math.round(realDist * 10) / 10,
            totalNearbyWorkers: currentNearbyWorkers.length,
          });
          recentOfferTargets.set(singleDedupeKey, Date.now());
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
          console.log(`❌ Skipping emit to ${nextWorker.name} due to distance ${realDist.toFixed(2)}km (>15km)`);
        }
      } catch (e) {
        console.error('Error while verifying distance before emit (single):', e);
      }
      
      // ✅ ALSO SEND FIREBASE PUSH NOTIFICATION FOR FOREGROUND ALERT
      try {
        const worker = userMap.get(nextWorker.phone);
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
      await scheduleDispatchState({
        jobId: job._id,
        type: "retry_offer",
        runAt: new Date(Date.now() + WORKER_TIMEOUT_SECONDS * 1000),
        metadata: { reason: "single_worker_offer_timeout", workerPhone: nextWorker.phone },
      });
      console.log(`⏳ Timeout set for ${nextWorker.name} (${WORKER_TIMEOUT_SECONDS}s)`);
    } else {
      // Worker not connected - try next one
      console.log(`⚠️ Worker ${nextWorker.name} not connected, trying next...`);
      setTimeout(() => {
        offerJobToNextWorker(job).catch((err) => {
          console.error("Error retrying offer after disconnected worker:", err);
        });
      }, 0);
    }
  } catch (e) {
    console.error('Error offering job to next worker:', e);
  } finally {
    offerInFlightLocks.delete(jobId);
  }
}

  // Cleanup function for expired timeouts to prevent memory leaks
  function cleanupExpiredTimeouts() {
    const now = Date.now();
    
    // Cleanup pendingJobTimeouts
    for (const [jobId, timeoutId] of pendingJobTimeouts.entries()) {
      // Check if job still exists and is relevant
      Job.findById(jobId).select('status').lean().then(job => {
        if (!job || !['pending', 'offered', 'accepted'].includes(job.status)) {
          clearTimeout(timeoutId);
          pendingJobTimeouts.delete(jobId);
        }
      }).catch(err => {
        console.warn(`Error checking job ${jobId} for cleanup:`, err.message);
        // If job doesn't exist, clean up the timeout
        clearTimeout(timeoutId);
        pendingJobTimeouts.delete(jobId);
      });
    }
    
    // Cleanup recentOfferTargets
    for (const [key, ts] of recentOfferTargets.entries()) {
      if (now - ts > RECENT_OFFER_TTL_MS) {
        recentOfferTargets.delete(key);
      }
    }
  }
  
  // Run cleanup every 5 minutes
  const cleanupInterval = setInterval(cleanupExpiredTimeouts, 5 * 60 * 1000);
  
  // Cleanup on process exit
  process.on('SIGINT', () => {
    clearInterval(cleanupInterval);
    // Clear all pending timeouts
    for (const timeoutId of pendingJobTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    pendingJobTimeouts.clear();
  });
  
  process.on('SIGTERM', () => {
    clearInterval(cleanupInterval);
    // Clear all pending timeouts
    for (const timeoutId of pendingJobTimeouts.values()) {
      clearTimeout(timeoutId);
    }
    pendingJobTimeouts.clear();
  });

  return { checkJobMatchesForWorker, offerJobToNextWorker, cleanupExpiredTimeouts };
}

module.exports = {
  createJobDispatchHelpers,
};
