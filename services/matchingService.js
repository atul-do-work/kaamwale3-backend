const { getDistanceFromLatLonInKm } = require("../utils/distance");

/**
 * Find nearby workers within 5km radius of the job location
 * @param {Object} jobLocation - { lat, lon, workerType }
 * @param {Map} connectedWorkers - Map of connected workers with their locations
 * @returns {Array} Array of nearby workers sorted by distance
 */
exports.findNearbyWorkers = (jobLocation, connectedWorkers) => {
  const RADIUS_KM = 5; // 5km radius
  const nearbyWorkers = [];
  const skippedWorkers = [];

  for (const [socketId, worker] of connectedWorkers.entries()) {
    // Skip if worker data is incomplete
    if (!worker.lat || !worker.lon || !worker.name) continue;

    // ✅ Skip if worker is OFFLINE (isAvailable = false)
    if (worker.isAvailable === false) {
      skippedWorkers.push(`${worker.name} (offline)`);
      continue;
    }

    // Calculate distance from job location to worker location
    const distKm = getDistanceFromLatLonInKm(
      jobLocation.lat,
      jobLocation.lon,
      worker.lat,
      worker.lon
    );

    // Only include workers within 5km radius
    if (distKm <= RADIUS_KM) {
      nearbyWorkers.push({
        socketId,
        name: worker.name,
        phone: worker.phone,
        workerType: worker.workerType,
        lat: worker.lat,
        lon: worker.lon,
        distance: Math.round(distKm * 10) / 10, // Round to 1 decimal
      });
    }
  }

  // Log skipped workers for debugging
  if (skippedWorkers.length > 0) {
    console.log(`🔴 Skipped offline workers: ${skippedWorkers.join(', ')}`);
  }

  // Sort by distance (nearest first)
  return nearbyWorkers.sort((a, b) => a.distance - b.distance);
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
