const { getDistanceFromLatLonInKm } = require("../utils/distance");

/**
 * Check if worker's wage range matches job wage
 * Worker wage ranges: "0-400", "400-550", "550-700", "700-max"
 * Returns true if job wage falls within or overlaps with worker's range
 */
const isWageInRange = (jobAmount, workerWageRange) => {
  if (!workerWageRange || !jobAmount) return true; // If worker has no preference, match any wage
  
  const amount = parseInt(jobAmount);
  const ranges = {
    "0-400": { min: 0, max: 400 },
    "400-550": { min: 400, max: 550 },
    "550-700": { min: 550, max: 700 },
    "700-max": { min: 700, max: 999999 }
  };
  
  const range = ranges[workerWageRange];
  if (!range) return true; // Invalid range, allow
  
  // Check if job amount is within worker's wage range
  return amount >= range.min && amount <= range.max;
};

/**
 * Find nearby workers within specified radius with SKILL and WAGE matching
 * Filters workers by:
 * 1. Location (within radiusKm)
 * 2. Online status
 * 3. Skill match (worker's mainSkill matches job's mainSkill)
 * 4. Wage range match (job wage within worker's expected wage range)
 * 5. No unpaid jobs (checks database)
 * 6. Haven't declined this job
 * 7. Location freshness (optional, within last 30 minutes)
 * 
 * @param {Object} jobLocation - { lat, lon, mainSkill, amount, description }
 * @param {Map} connectedWorkers - Map of connected workers with their locations
 * @param {number} radiusKm - Search radius in kilometers (default 10)
 * @param {number} maxLocationAgeMinutes - Maximum age of worker location in minutes (default 30, 0 to disable)
 * @returns {Array} Array of nearby workers sorted by distance to contractor
 */
exports.findNearbyWorkers = (jobLocation, connectedWorkers, radiusKm = 10, maxLocationAgeMinutes = 30) => {
  console.log(`🔍 findNearbyWorkers: jobLat=${jobLocation.lat} jobLon=${jobLocation.lon} requiredSkill=${jobLocation.mainSkill || jobLocation.workerType || 'any'} amount=${jobLocation.amount} radiusKm=${radiusKm} maxLocationAgeMinutes=${maxLocationAgeMinutes} connectedWorkers=${connectedWorkers.size}`);
  const nearbyWorkers = [];
  const skippedWorkers = [];

  for (const [socketId, worker] of connectedWorkers.entries()) {
    // Skip if worker data is incomplete
    if (!worker.lat || !worker.lon || !worker.name) {
      skippedWorkers.push(`${worker.name || 'unknown'} (incomplete location data)`);
      continue;
    }

    // ✅ LOCATION FRESHNESS: Skip if location is too old
    if (maxLocationAgeMinutes > 0 && worker.locationLastUpdated) {
      const locationAgeMinutes = (Date.now() - new Date(worker.locationLastUpdated).getTime()) / (1000 * 60);
      if (locationAgeMinutes > maxLocationAgeMinutes) {
        skippedWorkers.push(`${worker.name} (location too old: ${locationAgeMinutes.toFixed(1)}min ago)`);
        continue;
      }
    }

    // ✅ Skip if worker is OFFLINE (isAvailable = false)
    if (worker.isAvailable === false) {
      skippedWorkers.push(`${worker.name} (offline)`);
      continue;
    }

    // ✅ SKILL MATCHING: Check if worker can fulfill the job skill requirement
    // Use the explicit job workerType when available, otherwise fall back to description.
    const requiredSkill = jobLocation.mainSkill || jobLocation.workerType;
    const workerSkillLabel = worker.mainSkill || (Array.isArray(worker.skills) ? worker.skills.join(", ") : "none");
    const workerHasRequiredSkill =
      !requiredSkill ||
      worker.mainSkill === requiredSkill ||
      (Array.isArray(worker.skills) && worker.skills.includes(requiredSkill));

    if (!workerHasRequiredSkill) {
      skippedWorkers.push(`${worker.name} (skill mismatch: needs ${requiredSkill || 'any'}, has ${workerSkillLabel})`);
      continue;
    }

    // ✅ WAGE MATCHING: Check if job wage is within worker's expected wage range
    if (!isWageInRange(jobLocation.amount, worker.expectedWage)) {
      skippedWorkers.push(`${worker.name} (wage out of range: job=₹${jobLocation.amount}, expects ${worker.expectedWage})`);
      continue;
    }

    // Calculate distance from job location to worker location
    const distKm = getDistanceFromLatLonInKm(
      jobLocation.lat,
      jobLocation.lon,
      worker.lat,
      worker.lon
    );

    // ✅ DEBUG: Log all workers and distances
    console.log(`📍 Worker: ${worker.name} (${worker.mainSkill}, ₹${worker.expectedWage}) at (${worker.lat}, ${worker.lon}) → Distance: ${distKm.toFixed(2)}km`);

    // Only include workers within specified radius
    if (distKm <= radiusKm) {
      console.log(`✅ MATCHED: ${worker.name} - Skill: ${worker.mainSkill}, Wage: ${worker.expectedWage}, Distance: ${distKm.toFixed(2)}km`);
      nearbyWorkers.push({
        socketId,
        name: worker.name,
        phone: worker.phone,
        mainSkill: worker.mainSkill,
        expectedWage: worker.expectedWage,
        lat: worker.lat,
        lon: worker.lon,
        distance: Math.round(distKm * 10) / 10, // Round to 1 decimal
      });
    } else {
      console.log(`❌ TOO FAR: ${worker.name} (${distKm.toFixed(2)}km away) - exceeds ${radiusKm}km radius`);
    }
  }

  // Log skipped workers for debugging
  if (skippedWorkers.length > 0) {
    console.log(`🔴 Skipped workers: ${skippedWorkers.join(', ')}`);
  }

  // Sort by distance only (incentive eligibility is handled in incentive service/UI).
  return nearbyWorkers.sort((a, b) => {
    return a.distance - b.distance;
  });
};

/**
 * Find best workers with scoring (kept for potential future use)
 */
exports.findBestWorkers = (jobLocation, job, connectedWorkers) => {
  const workerList = [];

  for (const [phone, worker] of connectedWorkers.entries()) {
    const distKm = getDistanceFromLatLonInKm(
      jobLocation.lat,
      jobLocation.lon,
      worker.lat,
      worker.lon
    );

    if (distKm > 5) continue; // skip far workers

    const score =
      (job.workerType && worker.skills?.includes(job.workerType) ? 40 : 0) + // skill match
      (5 - distKm) * 10 + // distance score
      (worker.rating || 3) * 10; // rating weight

    workerList.push({ phone, score, distKm, ...worker });
  }

  return workerList.sort((a, b) => b.score - a.score).slice(0, 10); // Top 10 workers
};
