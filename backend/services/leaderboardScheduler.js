/**
 * Leaderboard Scheduler
 * Runs periodically to recalculate city leaderboards
 * Uses simple setInterval approach (production would use node-cron or Bull queue)
 */

const CityLeaderboard = require('../models/CityLeaderboard');
const User = require('../models/User');
const { calculateCityLeaderboard } = require('./leaderboardService');

// Store active timers to prevent multiple instances
let leaderboardSchedulerRunning = false;
const RECALCULATION_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours in milliseconds

/**
 * Recalculate all city leaderboards
 * This function:
 * 1. Gets all unique cities
 * 2. Calculates fresh leaderboard for each
 * 3. Updates cache
 */
async function recalculateAllLeaderboards() {
  try {
    console.log('[Leaderboard] Starting recalculation...');
    const startTime = Date.now();

    // Get all unique cities with contractors
    const citiesData = await User.aggregate([
      {
        $match: { role: 'contractor', city: { $ne: '', $exists: true } },
      },
      {
        $group: {
          _id: { city: '$city', state: '$state' },
          count: { $sum: 1 },
        },
      },
    ]);

    console.log(`[Leaderboard] Found ${citiesData.length} cities with contractors`);

    let successCount = 0;
    let errorCount = 0;

    // Process each city
    for (const cityData of citiesData) {
      try {
        const { city, state } = cityData._id;

        // Calculate fresh leaderboard
        const leaderboardData = await calculateCityLeaderboard(city, state);

        if (leaderboardData.length > 0) {
          // Update cache
          await CityLeaderboard.findOneAndUpdate(
            { city, state },
            {
              city,
              state,
              leaderboard: leaderboardData,
              totalContractors: leaderboardData.length,
              calculatedAt: new Date(),
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
            { upsert: true }
          );

          successCount++;
          console.log(`[Leaderboard] ✅ Updated ${city}, ${state} (${leaderboardData.length} contractors)`);
        }
      } catch (err) {
        errorCount++;
        console.error(`[Leaderboard] ❌ Error calculating leaderboard for ${cityData._id.city}:`, err.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[Leaderboard] ✅ Recalculation complete in ${duration}s (${successCount} success, ${errorCount} errors)`
    );
  } catch (err) {
    console.error('[Leaderboard] Fatal error during recalculation:', err);
  } finally {
    leaderboardSchedulerRunning = false;
  }
}

/**
 * Start the leaderboard scheduler
 * Runs immediately on startup, then every 6 hours
 */
function startLeaderboardScheduler() {
  if (leaderboardSchedulerRunning) {
    console.log('[Leaderboard] Scheduler already running');
    return;
  }

  console.log('[Leaderboard] 🚀 Starting scheduler (interval: 6 hours)...');

  // Run immediately on startup
  recalculateAllLeaderboards();

  // Schedule recurring updates
  setInterval(() => {
    if (!leaderboardSchedulerRunning) {
      recalculateAllLeaderboards();
    }
  }, RECALCULATION_INTERVAL);
}

module.exports = {
  startLeaderboardScheduler,
  recalculateAllLeaderboards,
};
