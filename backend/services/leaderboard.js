/**
 * Comprehensive Leaderboard Service
 * Consolidates all leaderboard logic: calculation, caching, scheduling, and API routes
 * 
 * Features:
 * - Contractor score calculation with weighted metrics
 * - City-based and district-based leaderboards
 * - Automatic periodic recalculation (6 hours)
 * - Geospatial district queries
 * - Caching with 24-hour TTL
 * - All API endpoints in one file
 */

const express = require('express');
const { authenticateToken } = require('../utils/auth');
const { isPremiumEntitled } = require('../utils/premiumEntitlement');
const User = require('../models/User');
const Job = require('../models/Jobs');
const CityLeaderboard = require('../models/CityLeaderboard');

// ========================================
// CONFIGURATION & CONSTANTS
// ========================================

const WEIGHTS = {
  rating: 0.50,          // 50% - Average rating
  jobsPosted: 0.1667,    // 16.67% - Total jobs posted
  daysActive: 0.1667,    // 16.67% - Days active
  completionRate: 0.1667, // 16.67% - Completion rate
};

const TIER_THRESHOLDS = {
  gold: 80,
  silver: 60,
  bronze: 40,
  'rising-star': 20,
  new: 0,
};

const RECALCULATION_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours in milliseconds
let leaderboardSchedulerRunning = false;

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Get district by GPS coordinates using MongoDB geospatial query
 * Returns district name, state, and geometry
 */
async function getDistrictByCoordinates(latitude, longitude) {
  try {
    const District = require('../models/City');
    const point = {
      type: 'Point',
      coordinates: [longitude, latitude],
    };

    // Try exact polygon match first
    let district = await District.findOne({
      geometry: {
        $geoIntersects: {
          $geometry: point,
        },
      },
    }).lean();

    // Fallback: nearest centroid (50km)
    if (!district) {
      console.warn(`⚠️ No exact district match for [${longitude}, ${latitude}], using nearest centroid`);
      district = await District.findOne(
        {
          centroid: {
            $nearSphere: {
              $geometry: point,
              $maxDistance: 50000,
            },
          },
        },
        null,
        { lean: true }
      );
    }

    return district;
  } catch (err) {
    console.error('❌ Error getting district by coordinates:', err.message);
    return null;
  }
}

/**
 * Get tier based on score
 */
function getTierByScore(score) {
  if (score >= TIER_THRESHOLDS.gold) return 'gold';
  if (score >= TIER_THRESHOLDS.silver) return 'silver';
  if (score >= TIER_THRESHOLDS.bronze) return 'bronze';
  if (score >= TIER_THRESHOLDS['rising-star']) return 'rising-star';
  return 'new';
}

/**
 * Calculate response time score
 * Avg response in hours - convert to 0-50 scale
 * <2 hours = 50 points, decreases as time increases
 */
function getResponseTimeScore(avgResponseTimeHours) {
  if (!avgResponseTimeHours || avgResponseTimeHours <= 0) return 0;
  if (avgResponseTimeHours <= 2) return 50;
  return Math.max(0, 50 - (avgResponseTimeHours - 2) * 5);
}

/**
 * Calculate days active since user creation
 */
function getDaysActive(createdAtDate) {
  const now = new Date();
  const created = new Date(createdAtDate);
  const diffTime = Math.abs(now - created);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return Math.min(diffDays, 365); // Cap at 365 days for fair comparison
}

// ========================================
// SCORING & CALCULATION FUNCTIONS
// ========================================

/**
 * Get user stats aggregated from all their jobs
 */
async function getContractorStats(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) return null;

    // Query jobs by contractorPhone (not contractorId since Job model uses contractorPhone)
    const jobs = await Job.find({ contractorPhone: user.phone });

    const totalJobsPosted = jobs.length;
    const completedJobs = jobs.filter((j) => j.status === 'completed').length;
    const cancelledJobs = jobs.filter((j) => j.status === 'cancelled').length;

    const completionRate = totalJobsPosted > 0 ? (completedJobs / totalJobsPosted) * 100 : 0;

    // Contractor rating is maintained on User.avgRating from worker->contractor reviews.
    const avgRating = Number(user.avgRating) || 0;

    // Estimate average response time (default to 24 hours if not tracked)
    const avgResponseTime = 24;

    const daysActive = getDaysActive(user.createdAt);

    return {
      totalJobsPosted,
      completedJobs,
      cancelledJobs,
      completionRate,
      avgRating,
      avgResponseTime,
      daysActive,
    };
  } catch (err) {
    console.error('❌ Error getting contractor stats:', err);
    return null;
  }
}

/**
 * Calculate final leaderboard score for a contractor
 */
async function calculateContractorScore(userId) {
  try {
    const stats = await getContractorStats(userId);
    if (!stats) return 0;

    // Normalize values to 0-100 scale
    const normalizedRating = (stats.avgRating / 5) * 100;           // 0-100 based on 5-star rating
    const normalizedJobsPosted = Math.min(stats.totalJobsPosted, 100); // 0-100 (cap at 100 jobs)
    const normalizedDaysActive = Math.min(stats.daysActive, 365);    // 0-365 days (normalize to percentage)
    const normalizedCompletionRate = stats.completionRate;           // Already 0-100

    // Convert daysActive to percentage (assume 1 year = 100%)
    const daysActivePercent = (normalizedDaysActive / 365) * 100;

    // Apply weights and calculate final score (0-100)
    const finalScore =
      WEIGHTS.rating * normalizedRating +
      WEIGHTS.jobsPosted * normalizedJobsPosted +
      WEIGHTS.daysActive * daysActivePercent +
      WEIGHTS.completionRate * normalizedCompletionRate;

    return Math.round(finalScore * 10) / 10;
  } catch (err) {
    console.error('❌ Error calculating score:', err);
    return 0;
  }
}

/**
 * Calculate city leaderboard - returns sorted array of contractors
 */
async function calculateCityLeaderboard(city, state) {
  try {
    const normalizedCity = (city || '').toLowerCase().trim();
    const normalizedState = (state || '').toLowerCase().trim();

    console.log(`🔍 [Leaderboard] Searching contractors in: ${normalizedCity}, ${normalizedState}`);

    // Get all contractors in this city with case-insensitive query
    const contractors = await User.find({
      city: new RegExp(`^${normalizedCity}$`, 'i'),
      state: new RegExp(`^${normalizedState}$`, 'i'),
      role: 'contractor',
    });

    if (contractors.length === 0) {
      console.log(`ℹ️ [Leaderboard] No contractors found in ${city}, ${state}`);
      return [];
    }

    console.log(`📊 [Leaderboard] Calculating leaderboard for ${contractors.length} contractors`);

    // Calculate score for each contractor with error handling
    const leaderboardData = await Promise.all(
      contractors.map(async (contractor) => {
        try {
          const stats = await getContractorStats(contractor._id);
          const score = await calculateContractorScore(contractor._id);

          return {
            contractorId: contractor._id,
            phone: contractor.phone,
            name: contractor.name,
            score: Math.round(score * 10) / 10,
            points: Math.round(score),
            avgRating: stats?.avgRating || 0,
            totalJobsPosted: stats?.totalJobsPosted || 0,
            completedJobs: stats?.completedJobs || 0,
            daysActive: stats?.daysActive || 0,
            completionRate: stats?.completionRate || 0,
            avgResponseTime: stats?.avgResponseTime || 0,
            profilePhoto: contractor.profilePhoto || "",
            tier: getTierByScore(score),
          };
        } catch (contractorErr) {
          console.warn(`⚠️ [Leaderboard] Error calculating score for ${contractor.name}:`, contractorErr.message);
          return {
            contractorId: contractor._id,
            phone: contractor.phone,
            name: contractor.name,
            score: 0,
            points: 0,
            avgRating: 0,
            totalJobsPosted: 0,
            completedJobs: 0,
            daysActive: 0,
            completionRate: 0,
            avgResponseTime: 0,
            profilePhoto: contractor.profilePhoto || "",
            tier: 'new',
          };
        }
      })
    );

    // Sort by points descending and add rank
    leaderboardData.sort((a, b) => b.points - a.points);
    leaderboardData.forEach((item, index) => {
      item.rank = index + 1;
    });

    console.log(`✅ [Leaderboard] Calculated: ${leaderboardData.length} contractors ranked`);
    return leaderboardData;
  } catch (err) {
    console.error('❌ [Leaderboard] Error calculating city leaderboard:', err.message);
    return [];
  }
}

// ========================================
// SCHEDULER FUNCTIONS
// ========================================

/**
 * Recalculate all city leaderboards periodically
 */
async function recalculateAllLeaderboards() {
  try {
    console.log('[Leaderboard Scheduler] 🔄 Starting recalculation...');
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

    console.log(`[Leaderboard Scheduler] Found ${citiesData.length} cities with contractors`);

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
          console.log(`[Leaderboard Scheduler] ✅ Updated ${city}, ${state} (${leaderboardData.length} contractors)`);
        }
      } catch (err) {
        errorCount++;
        console.error(`[Leaderboard Scheduler] ❌ Error for ${cityData._id.city}:`, err.message);
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(
      `[Leaderboard Scheduler] ✅ Complete in ${duration}s (${successCount} success, ${errorCount} errors)`
    );
  } catch (err) {
    console.error('[Leaderboard Scheduler] Fatal error:', err);
  } finally {
    leaderboardSchedulerRunning = false;
  }
}

/**
 * Start the leaderboard scheduler
 */
function startLeaderboardScheduler() {
  if (leaderboardSchedulerRunning) {
    console.log('[Leaderboard Scheduler] Already running');
    return;
  }

  console.log('[Leaderboard Scheduler] 🚀 Starting (interval: 6 hours)...');

  // Run immediately on startup
  recalculateAllLeaderboards();

  // Schedule recurring updates
  setInterval(() => {
    if (!leaderboardSchedulerRunning) {
      recalculateAllLeaderboards();
    }
  }, RECALCULATION_INTERVAL);
}

// ========================================
// EXPRESS ROUTES
// ========================================

const router = express.Router();

/**
 * GET /leaderboard/my-city
 * Get leaderboard for the current user's city (PREMIUM ONLY)
 */
router.get('/my-city', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    // ✅ Check premium status
    if (!isPremiumEntitled(user)) {
      return res.status(403).json({
        success: false,
        message: 'Leaderboard feature requires an active premium plan',
        upgradePlanUrl: '/premium/plans',
      });
    }

    if (!user || !user.city) {
      return res.status(400).json({
        success: false,
        message: 'User location not found. Please update your location first.',
      });
    }

    const userCity = user.city.toLowerCase().trim();
    const userState = (user.state || 'Unknown').toLowerCase().trim();

    console.log(`[Leaderboard] Fetching for user: ${userCity}, ${userState}`);

    // Try to get from cache first
    let leaderboard = await CityLeaderboard.findOne({
      city: new RegExp(`^${userCity}$`, 'i'),
      state: new RegExp(`^${userState}$`, 'i'),
    });

    // If not in cache or expired, calculate fresh
    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      console.log(`[Leaderboard] 🔄 Recalculating for ${userCity}, ${userState}`);
      const leaderboardData = await calculateCityLeaderboard(userCity, userState);

      leaderboard = await CityLeaderboard.findOneAndUpdate(
        { city: userCity, state: userState },
        {
          city: userCity,
          state: userState,
          leaderboard: leaderboardData,
          totalContractors: leaderboardData.length,
          calculatedAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        { upsert: true, new: true }
      );
    }

    // Find current user's rank
    const currentUserRank = leaderboard.leaderboard.find(
      (item) => item.contractorId.toString() === req.user.id
    );

    res.json({
      success: true,
      city: leaderboard.city,
      state: leaderboard.state,
      totalContractors: leaderboard.totalContractors,
      leaderboard: leaderboard.leaderboard,
      myRank: currentUserRank?.rank || null,
      myPoints: currentUserRank?.points || 0,
      myTier: currentUserRank?.tier || 'new',
    });
  } catch (err) {
    console.error('[Leaderboard] Error fetching my-city:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
      error: err.message,
    });
  }
});

/**
 * GET /leaderboard/city
 * Get leaderboard for a city (auto-detect from lat/lon) - PREMIUM ONLY
 */
router.get('/city', authenticateToken, async (req, res) => {
  try {
    // ✅ Check premium status
    const user = await User.findById(req.user.id);
    if (!isPremiumEntitled(user)) {
      return res.status(403).json({
        success: false,
        message: 'Leaderboard feature requires an active premium plan',
        upgradePlanUrl: '/premium/plans',
      });
    }

    const { latitude, longitude } = req.query;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude required',
      });
    }

    // Get district using geospatial query instead of Nominatim API
    const district = await getDistrictByCoordinates(parseFloat(latitude), parseFloat(longitude));

    if (!district) {
      return res.json({
        success: true,
        city: null,
        state: null,
        leaderboard: [],
        message: 'Location outside mapped districts',
      });
    }

    // Try to get from cache first
    let leaderboard = await CityLeaderboard.findOne({
      city: new RegExp(`^${district.name}$`, 'i'),
      state: new RegExp(`^${district.state}$`, 'i'),
    });

    // If not in cache or expired, calculate fresh
    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      const leaderboardData = await calculateCityLeaderboard(district.name, district.state);

      leaderboard = await CityLeaderboard.findOneAndUpdate(
        { 
          city: district.name,
          state: district.state
        },
        {
          city: district.name,
          state: district.state,
          leaderboard: leaderboardData,
          totalContractors: leaderboardData.length,
          calculatedAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        { upsert: true, new: true }
      );
    }

    // Find current user's rank
    const currentUserRank = leaderboard.leaderboard.find(
      (item) => item.contractorId.toString() === req.user.id
    );

    res.json({
      success: true,
      city: district.name,
      state: district.state,
      totalContractors: leaderboard.totalContractors,
      leaderboard: leaderboard.leaderboard,
      myRank: currentUserRank?.rank || null,
      myPoints: currentUserRank?.points || 0,
      myTier: currentUserRank?.tier || 'new',
    });
  } catch (err) {
    console.error('[Leaderboard] Error fetching city:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
      error: err.message,
    });
  }
});

/**
 * GET /leaderboard/city/:cityName
 * Get leaderboard for a specific city by name
 */
router.get('/city/:cityName', authenticateToken, async (req, res) => {
  try {
    const { cityName } = req.params;
    const { state } = req.query;
    const user = await User.findById(req.user.id).select('premiumPlan');
    if (!isPremiumEntitled(user)) {
      return res.status(403).json({
        success: false,
        message: 'Leaderboard feature requires an active premium plan',
        upgradePlanUrl: '/premium/plans',
      });
    }

    let leaderboard;

    if (state) {
      leaderboard = await CityLeaderboard.findOne({
        city: new RegExp(`^${cityName}$`, 'i'),
        state: new RegExp(`^${state}$`, 'i'),
      });
    } else {
      leaderboard = await CityLeaderboard.findOne({
        city: new RegExp(`^${cityName}$`, 'i'),
      });
    }

    // If not in cache or expired, calculate fresh
    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      const leaderboardData = await calculateCityLeaderboard(
        cityName,
        state || 'Unknown'
      );

      leaderboard = await CityLeaderboard.findOneAndUpdate(
        state
          ? { 
              city: new RegExp(`^${cityName}$`, 'i'),
              state: new RegExp(`^${state}$`, 'i')
            }
          : { city: new RegExp(`^${cityName}$`, 'i') },
        {
          city: cityName.toLowerCase().trim(),
          state: (state || 'Unknown').toLowerCase().trim(),
          leaderboard: leaderboardData,
          totalContractors: leaderboardData.length,
          calculatedAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        { upsert: true, new: true }
      );
    }

    // Find current user's rank
    const currentUserRank = leaderboard.leaderboard.find(
      (item) => item.contractorId.toString() === req.user.id
    );

    res.json({
      success: true,
      city: leaderboard.city,
      state: leaderboard.state,
      totalContractors: leaderboard.totalContractors,
      leaderboard: leaderboard.leaderboard,
      myRank: currentUserRank?.rank || null,
      myPoints: currentUserRank?.points || 0,
      myTier: currentUserRank?.tier || 'new',
    });
  } catch (err) {
    console.error('[Leaderboard] Error fetching city by name:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
      error: err.message,
    });
  }
});

/**
 * PUT /leaderboard/update-location
 * Update contractor's location + return leaderboard if premium
 */
router.put('/update-location', authenticateToken, async (req, res) => {
  try {
    const { latitude, longitude } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude required',
      });
    }

    // Get district using geospatial query
    const district = await getDistrictByCoordinates(parseFloat(latitude), parseFloat(longitude));

    if (!district) {
      return res.status(400).json({
        success: false,
        message: 'Location outside mapped districts',
      });
    }

    // Update user's location
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        city: district.name,
        state: district.state,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        locationLastUpdated: new Date(),
      },
      { new: true }
    );

    // ✅ Return leaderboard only if user has premium
    const hasPremium = isPremiumEntitled(user);

    if (!hasPremium) {
      return res.json({
        success: true,
        message: 'Location updated. Premium required to view leaderboard.',
        user: {
          city: user.city,
          state: user.state,
          latitude: user.latitude,
          longitude: user.longitude,
        },
        requiresPremium: true,
      });
    }

    // Get new city leaderboard (only for premium users)
    let leaderboard = await CityLeaderboard.findOne({
      city: new RegExp(`^${district.name}$`, 'i'),
      state: new RegExp(`^${district.state}$`, 'i'),
    });

    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      const leaderboardData = await calculateCityLeaderboard(district.name, district.state);

      leaderboard = await CityLeaderboard.findOneAndUpdate(
        { 
          city: district.name,
          state: district.state
        },
        {
          city: district.name,
          state: district.state,
          leaderboard: leaderboardData,
          totalContractors: leaderboardData.length,
          calculatedAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        { upsert: true, new: true }
      );
    }

    const currentUserRank = leaderboard.leaderboard.find(
      (item) => item.contractorId.toString() === req.user.id
    );

    res.json({
      success: true,
      message: 'Location updated successfully',
      user: {
        city: user.city,
        state: user.state,
        latitude: user.latitude,
        longitude: user.longitude,
      },
      leaderboard: leaderboard.leaderboard,
      myRank: currentUserRank?.rank || null,
      myPoints: currentUserRank?.points || 0,
      myTier: currentUserRank?.tier || 'new',
    });
  } catch (err) {
    console.error('[Leaderboard] Error updating location:', err);
    res.status(500).json({
      success: false,
      message: 'Error updating location',
      error: err.message,
    });
  }
});

/**
 * GET /leaderboard/stats/:contractorId
 * Get detailed stats for a specific contractor
 */
router.get('/stats/:contractorId', authenticateToken, async (req, res) => {
  try {
    const { contractorId } = req.params;

    const contractor = await User.findById(contractorId);
    if (!contractor) {
      return res.status(404).json({
        success: false,
        message: 'Contractor not found',
      });
    }

    // Get leaderboard data for this contractor's city
    const leaderboard = await CityLeaderboard.findOne({
      city: contractor.city,
      state: contractor.state,
    });

    const contractorData = leaderboard?.leaderboard.find(
      (item) => item.contractorId.toString() === contractorId
    );

    if (!contractorData) {
      return res.status(404).json({
        success: false,
        message: 'Contractor not found in leaderboard',
      });
    }

    res.json({
      success: true,
      contractor: {
        name: contractor.name,
        city: contractor.city,
        state: contractor.state,
        profilePhoto: contractor.profilePhoto,
        ...contractorData,
      },
    });
  } catch (err) {
    console.error('[Leaderboard] Error fetching contractor stats:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching contractor stats',
      error: err.message,
    });
  }
});

/**
 * GET /leaderboard/contractors/by-district
 * Contractor leaderboard by district polygon + GPS location (PREMIUM ONLY)
 */
router.get('/contractors/by-district', authenticateToken, async (req, res) => {
  try {
    // ✅ Check premium status
    const user = await User.findById(req.user.id);
    if (!isPremiumEntitled(user)) {
      return res.status(403).json({
        success: false,
        message: 'Leaderboard feature requires an active premium plan',
        upgradePlanUrl: '/premium/plans',
      });
    }

    const { lat, lon } = req.query;

    if (!lat || !lon) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude required',
      });
    }

    const latitude = parseFloat(lat);
    const longitude = parseFloat(lon);

    if (isNaN(latitude) || isNaN(longitude)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid latitude or longitude',
      });
    }

    console.log(`[Leaderboard] Finding district for: [${longitude}, ${latitude}]`);

    // Find district polygon containing the contractor's GPS point
    const District = require('../models/City'); // File is City.js, exports as "District" model
    const point = {
      type: 'Point',
      coordinates: [longitude, latitude],
    };

    let district = await District.findOne({
      geometry: {
        $geoIntersects: {
          $geometry: point,
        },
      },
    }).lean();

    // FALLBACK: If no exact district match, find nearest district by centroid
    if (!district) {
      console.warn(`⚠️ [Leaderboard] No exact polygon match for [${longitude}, ${latitude}], trying nearest centroid...`);
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
        console.log(`✅ [Leaderboard] Found nearest district: ${district.name}, ${district.state} (fallback)`);
      }
    }

    if (!district) {
      return res.json({
        success: true,
        district: null,
        state: null,
        leaderboard: [],
        message: 'No district found for this location',
      });
    }

    console.log(`🏆 [Leaderboard] Building leaderboard for district: ${district.name}, ${district.state}`);

    // Aggregate contractors within the district polygon
    const leaderboard = await User.aggregate([
      // Stage 1: Match contractors whose location is within the district polygon
      {
        $match: {
          role: 'contractor',
          location: {
            $geoWithin: {
              $geometry: district.geometry,
            },
          },
        },
      },
      // Stage 2: Lookup jobs posted by this contractor
      {
        $lookup: {
          from: 'jobs',
          localField: 'phone',
          foreignField: 'contractorPhone',
          as: 'jobs',
        },
      },
      // Stage 3: Compute contractor metrics using standardized WEIGHTS formula
      {
        $addFields: {
          jobCount: { $size: '$jobs' },
          // Rating normalized to 0-100 scale
          normalizedRating: {
            $cond: [{ $gt: ['$avgRating', 0] }, { $multiply: [{ $divide: ['$avgRating', 5] }, 100] }, 0],
          },
          // Jobs posted (cap at 100, normalized)
          normalizedJobsPosted: {
            $cond: [{ $gt: [{ $size: '$jobs' }, 0] }, { $min: [{ $size: '$jobs' }, 100] }, 0],
          },
          // Days active since account creation
          activeDays: {
            $cond: [
              { $gt: ['$createdAt', null] },
              {
                $ceil: {
                  $divide: [{ $subtract: [new Date(), '$createdAt'] }, 86400000],
                },
              },
              0,
            ],
          },
          completedJobs: {
            $size: {
              $filter: {
                input: '$jobs',
                as: 'job',
                cond: { $eq: ['$$job.status', 'completed'] },
              },
            },
          },
          completionRate: {
            $cond: [
              { $gt: [{ $size: '$jobs' }, 0] },
              {
                $multiply: [
                  { $divide: ['$completedJobs', { $size: '$jobs' }] },
                  100,
                ],
              },
              0,
            ],
          },
        },
      },
      // Stage 3.5: Calculate normalized days active percentage
      {
        $addFields: {
          daysActivePercent: {
            $min: [{ $multiply: [{ $divide: ['$activeDays', 365] }, 100] }, 100],
          },
        },
      },
      // Stage 3.6: Calculate final score using WEIGHTS formula (0-100 scale)
      {
        $addFields: {
          score: {
            $round: [
              {
                $add: [
                  { $multiply: [0.5, '$normalizedRating'] },           // 50% rating weight
                  { $multiply: [0.1667, '$normalizedJobsPosted'] },    // 16.67% jobs weight
                  { $multiply: [0.1667, '$daysActivePercent'] },       // 16.67% days active weight
                  { $multiply: [0.1667, '$completionRate'] },          // 16.67% completion weight
                ],
              },
              1,
            ],
          },
        },
      },
      // Stage 4: Sort by score descending
      {
        $sort: { score: -1 },
      },
      // Stage 5: Limit results
      {
        $limit: 100,
      },
      // Stage 6: Project final shape (standardized format matching city leaderboard)
      {
        $project: {
          _id: 0,
          contractorId: '$_id',
          phone: '$phone',
          name: 1,
          points: '$score',
          totalJobsPosted: '$jobCount',
          completedJobs: '$completedJobs',
          completionRate: { $round: ['$completionRate', 2] },
          tier: {
            $cond: [
              { $gte: ['$score', 80] },
              'gold',
              {
                $cond: [
                  { $gte: ['$score', 60] },
                  'silver',
                  {
                    $cond: [
                      { $gte: ['$score', 40] },
                      'bronze',
                      { $cond: [{ $gte: ['$score', 20] }, 'rising-star', 'new'] },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    ]);

    // Add rank to each contractor
    const rankedLeaderboard = leaderboard.map((item, index) => ({
      ...item,
      rank: index + 1,
    }));

    // Add current user's rank if they're in the leaderboard
    const currentUserRank = rankedLeaderboard.find((item) => item.phone === req.user.phone);

    // Return leaderboard with standardized format
    res.json({
      success: true,
      city: district.name,
      state: district.state,
      totalContractors: rankedLeaderboard.length,
      leaderboard: rankedLeaderboard,
      myRank: currentUserRank?.rank || null,
      myPoints: currentUserRank?.points || 0,
      myTier: currentUserRank?.tier || 'new',
    });

    // Save leaderboard snapshot to database for caching (async, non-blocking)
    setImmediate(async () => {
      try {
        await CityLeaderboard.findOneAndUpdate(
          { city: district.name, state: district.state },
          {
            city: district.name,
            state: district.state,
            totalContractors: rankedLeaderboard.length,
            leaderboard: rankedLeaderboard.map(c => ({
              contractorId: c.contractorId,
              phone: c.phone,
              rank: c.rank,
              name: c.name,
              points: c.points,
              totalJobsPosted: c.totalJobsPosted,
              completedJobs: c.completedJobs,
              completionRate: c.completionRate,
              tier: c.tier,
            })),
            calculatedAt: new Date(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          },
          { upsert: true, new: true }
        );
        console.log(`✅ [Leaderboard] Cached leaderboard for: ${district.name}, ${district.state}`);
      } catch (err) {
        console.error(`⚠️ [Leaderboard] Error caching leaderboard:`, err.message);
      }
    });
  } catch (err) {
    console.error('❌ [Leaderboard] Error fetching by-district:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
      error: err.message,
    });
  }
});

// ========================================
// EXPORTS
// ========================================

module.exports = {
  // Router for use in server.js
  router,
  
  // Functions for external use
  calculateContractorScore,
  calculateCityLeaderboard,
  getContractorStats,
  getTierByScore,
  
  // Scheduler functions
  startLeaderboardScheduler,
  recalculateAllLeaderboards,
  
  // Constants
  WEIGHTS,
  TIER_THRESHOLDS,
};

