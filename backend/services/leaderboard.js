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
const axios = require('axios');
const { authenticateToken } = require('../utils/auth');
const User = require('../models/User');
const Job = require('../models/Jobs');
const CityLeaderboard = require('../models/CityLeaderboard');

// ========================================
// CONFIGURATION & CONSTANTS
// ========================================

const WEIGHTS = {
  jobsPosted: 0.30,
  rating: 0.25,
  daysActive: 0.15,
  completionRate: 0.20,
  responseTime: 0.10,
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

/**
 * Reverse geocoding using OpenStreetMap Nominatim API
 */
async function reverseGeocode(latitude, longitude) {
  try {
    // Add delay to respect Nominatim rate limiting (1 request per second)
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    const response = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=10&addressdetails=1`,
      {
        headers: {
          'User-Agent': 'KaamwaleApp/1.0 (contact@kaamwale.com)',
          'Accept': 'application/json'
        },
        timeout: 8000,
      }
    );

    const data = response.data;

    let city =
      data.address?.city ||
      data.address?.town ||
      data.address?.village ||
      data.address?.county ||
      'Unknown';

    let state = data.address?.state || 'Unknown';

    return {
      city: city,
      state: state,
      success: true,
    };
  } catch (err) {
    console.error('❌ Reverse geocoding error:', err.message);
    return {
      city: 'Unknown',
      state: 'Unknown',
      success: false,
    };
  }
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

    // Calculate average rating from completed jobs with reviews
    const jobsWithRatings = jobs.filter((j) => j.rating && j.rating.stars && j.rating.stars > 0);
    const avgRating = jobsWithRatings.length > 0
      ? jobsWithRatings.reduce((sum, j) => sum + j.rating.stars, 0) / jobsWithRatings.length
      : 0;

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
    const normalizedJobsPosted = Math.min(stats.totalJobsPosted, 100);
    const normalizedRating = (stats.avgRating / 5) * 100;
    const normalizedDaysActive = Math.min(stats.daysActive, 100);
    const normalizedCompletionRate = stats.completionRate;
    const normalizedResponseTime = getResponseTimeScore(stats.avgResponseTime);

    // Apply weights and calculate final score
    const finalScore =
      WEIGHTS.jobsPosted * normalizedJobsPosted +
      WEIGHTS.rating * normalizedRating +
      WEIGHTS.daysActive * normalizedDaysActive +
      WEIGHTS.completionRate * normalizedCompletionRate +
      WEIGHTS.responseTime * normalizedResponseTime;

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
            score,
            avgRating: stats?.avgRating || 0,
            totalJobsPosted: stats?.totalJobsPosted || 0,
            completedJobs: stats?.completedJobs || 0,
            daysActive: stats?.daysActive || 0,
            completionRate: stats?.completionRate || 0,
            avgResponseTime: stats?.avgResponseTime || 0,
            profilePhoto: contractor.profilePhoto,
            tier: getTierByScore(score),
          };
        } catch (contractorErr) {
          console.warn(`⚠️ [Leaderboard] Error calculating score for ${contractor.name}:`, contractorErr.message);
          return {
            contractorId: contractor._id,
            phone: contractor.phone,
            name: contractor.name,
            score: 0,
            avgRating: 0,
            totalJobsPosted: 0,
            completedJobs: 0,
            daysActive: 0,
            completionRate: 0,
            avgResponseTime: 0,
            profilePhoto: contractor.profilePhoto,
            tier: 'new',
          };
        }
      })
    );

    // Sort by score descending and add rank
    leaderboardData.sort((a, b) => b.score - a.score);
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
 * Get leaderboard for the current user's city
 */
router.get('/my-city', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

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
      myScore: currentUserRank?.score || 0,
      myTier: currentUserRank?.tier || 'new',
      calculatedAt: leaderboard.calculatedAt,
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
 * Get leaderboard for a city (auto-detect from lat/lon)
 */
router.get('/city', authenticateToken, async (req, res) => {
  try {
    const { latitude, longitude } = req.query;

    if (!latitude || !longitude) {
      return res.status(400).json({
        success: false,
        message: 'Latitude and longitude required',
      });
    }

    // Reverse geocode to get city
    const geoData = await reverseGeocode(parseFloat(latitude), parseFloat(longitude));

    if (!geoData.success || !geoData.city) {
      return res.status(400).json({
        success: false,
        message: 'Could not determine city from coordinates',
      });
    }

    if (geoData.city === 'unknown' || geoData.state === 'unknown') {
      return res.status(400).json({
        success: false,
        message: 'Location outside mapped regions',
      });
    }

    // Try to get from cache first
    let leaderboard = await CityLeaderboard.findOne({
      city: new RegExp(`^${geoData.city}$`, 'i'),
      state: new RegExp(`^${geoData.state}$`, 'i'),
    });

    // If not in cache or expired, calculate fresh
    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      const leaderboardData = await calculateCityLeaderboard(geoData.city, geoData.state);

      leaderboard = await CityLeaderboard.findOneAndUpdate(
        { 
          city: new RegExp(`^${geoData.city}$`, 'i'),
          state: new RegExp(`^${geoData.state}$`, 'i')
        },
        {
          city: geoData.city,
          state: geoData.state,
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
      city: geoData.city,
      state: geoData.state,
      totalContractors: leaderboard.totalContractors,
      leaderboard: leaderboard.leaderboard,
      myRank: currentUserRank?.rank || null,
      myScore: currentUserRank?.score || 0,
      calculatedAt: leaderboard.calculatedAt,
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
      myScore: currentUserRank?.score || 0,
      calculatedAt: leaderboard.calculatedAt,
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
 * Update contractor's location
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

    // Reverse geocode
    const geoData = await reverseGeocode(parseFloat(latitude), parseFloat(longitude));

    // Update user's location
    const user = await User.findByIdAndUpdate(
      req.user.id,
      {
        city: geoData.city,
        state: geoData.state,
        latitude: parseFloat(latitude),
        longitude: parseFloat(longitude),
        locationLastUpdated: new Date(),
      },
      { new: true }
    );

    // Get new city leaderboard
    let leaderboard = await CityLeaderboard.findOne({
      city: new RegExp(`^${geoData.city}$`, 'i'),
      state: new RegExp(`^${geoData.state}$`, 'i'),
    });

    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      const leaderboardData = await calculateCityLeaderboard(geoData.city, geoData.state);

      leaderboard = await CityLeaderboard.findOneAndUpdate(
        { 
          city: new RegExp(`^${geoData.city}$`, 'i'),
          state: new RegExp(`^${geoData.state}$`, 'i')
        },
        {
          city: geoData.city,
          state: geoData.state,
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
      myScore: currentUserRank?.score || 0,
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
 * Contractor leaderboard by district polygon + GPS location
 */
router.get('/contractors/by-district', authenticateToken, async (req, res) => {
  try {
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
      // Stage 3: Compute contractor metrics
      {
        $addFields: {
          totalSpent: {
            $sum: '$jobs.amount',
          },
          jobCount: {
            $size: '$jobs',
          },
          avgRating: {
            $cond: [
              { $gt: ['$rating', 0] },
              { $round: ['$rating', 1] },
              0,
            ],
          },
          activeDays: {
            $cond: [
              { $gt: ['$createdAt', null] },
              {
                $ceil: {
                  $divide: [
                    {
                      $subtract: [new Date(), '$createdAt'],
                    },
                    86400000, // 1 day in ms
                  ],
                },
              },
              0,
            ],
          },
          // Composite score: rating * totalSpent * (1 + log(jobCount)) * (1 + log(activeDays))
          score: {
            $cond: [
              { $and: [{ $gt: ['$rating', 0] }, { $gt: ['$jobs', []] }] },
              {
                $multiply: [
                  '$rating',
                  { $max: [1, { $divide: ['$totalSpent', 100] }] },
                  { $max: [1, { $add: [1, { $ln: { $max: [2, '$jobCount'] } }] }] },
                  { $max: [1, { $add: [1, { $ln: { $max: [2, '$activeDays'] } }] }] },
                ],
              },
              0,
            ],
          },
        },
      },
      // Stage 4: Sort by score descending
      {
        $sort: {
          score: -1,
        },
      },
      // Stage 5: Limit results
      {
        $limit: 50,
      },
      // Stage 6: Project final shape
      {
        $project: {
          _id: 0,
          phone: 1,
          name: 1,
          profilePhoto: 1,
          rating: '$avgRating',
          totalSpent: 1,
          jobCount: 1,
          activeDays: 1,
          score: { $round: ['$score', 2] },
        },
      },
    ]);

    // Add rank to each result
    const rankedLeaderboard = leaderboard.map((contractor, index) => ({
      ...contractor,
      rank: index + 1,
    }));

    // Save leaderboard snapshot to database for caching
    try {
      await CityLeaderboard.findOneAndUpdate(
        { city: district.name, state: district.state },
        {
          city: district.name,
          state: district.state,
          totalContractors: rankedLeaderboard.length,
          leaderboard: rankedLeaderboard.map(c => ({
            phone: c.phone,
            name: c.name,
            rank: c.rank,
            score: c.score,
            avgRating: c.rating,
            totalJobsPosted: c.jobCount,
            daysActive: c.activeDays,
            totalSpent: c.totalSpent,
          })),
          updatedAt: new Date(),
        },
        { upsert: true, new: true }
      );
      console.log(`✅ [Leaderboard] Saved leaderboard snapshot for: ${district.name}, ${district.state}`);
    } catch (err) {
      console.error(`⚠️ [Leaderboard] Error saving to database:`, err.message);
    }

    return res.json({
      success: true,
      district: district.name,
      state: district.state,
      leaderboard: rankedLeaderboard,
      count: rankedLeaderboard.length,
      timestamp: new Date().toISOString(),
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
