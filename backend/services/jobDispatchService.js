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

  return { checkJobMatchesForWorker, offerJobToNextWorker };
}

module.exports = {
  createJobDispatchHelpers,
};
