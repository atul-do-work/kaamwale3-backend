const express = require('express');
const axios = require('axios');
const { authenticateToken } = require('../utils/auth');
const User = require('../models/User');
const CityLeaderboard = require('../models/CityLeaderboard');
const { calculateCityLeaderboard } = require('../services/leaderboardService');
// ✅ cityHierarchy no longer needed - district-based leaderboard uses pure geospatial queries

const router = express.Router();

// Reverse geocoding using OpenStreetMap Nominatim API (free, no key needed)
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

    // Extract city and state from response
    let city =
      data.address?.city ||
      data.address?.town ||
      data.address?.village ||
      data.address?.county ||
      'Unknown';

    let state = data.address?.state || 'Unknown';

    // ✅ No normalization needed for district-based system
    // Districts are matched via geospatial queries, not city names
    return {
      city: city,
      state: state,
      success: true,
    };
  } catch (err) {
    console.error('Reverse geocoding error:', err.message);
    return {
      city: 'Unknown',
      state: 'Unknown',
      success: false,
    };
  }
}

/**
 * GET /leaderboard/my-city
 * Get leaderboard for the current user's city
 * This is the main endpoint contractors should use
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

    console.log(`📍 Fetching leaderboard for user's city: ${userCity}, ${userState}`);

    // Try to get from cache first
    let leaderboard = await CityLeaderboard.findOne({
      city: new RegExp(`^${userCity}$`, 'i'),
      state: new RegExp(`^${userState}$`, 'i'),
    });

    // If not in cache or expired, calculate fresh
    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      console.log(`🔄 Recalculating leaderboard for ${userCity}, ${userState}`);
      const leaderboardData = await calculateCityLeaderboard(userCity, userState);

      // Save to cache
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
    console.error('Error fetching my city leaderboard:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
      error: err.message,
    });
  }
});

/**
 * GET /leaderboard/city
 * Get leaderboard for contractor's city (auto-detect from lat/lon)
 * Query: latitude, longitude
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
        message: 'Could not determine city from coordinates. Please try again or provide a valid location.',
      });
    }

    // ✅ NEW: Reject "Unknown" locations - user must be in a mapped city
    if (geoData.city === 'unknown' || geoData.state === 'unknown') {
      return res.status(400).json({
        success: false,
        message: 'Your location is outside mapped regions. Please move to a city within our service areas.',
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

      // Save to cache
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
    console.error('Error fetching city leaderboard:', err);
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
 * Query: state (optional, but recommended for uniqueness)
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
      // Try to find any city with this name
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
    console.error('Error fetching city leaderboard:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
      error: err.message,
    });
  }
});

/**
 * PUT /leaderboard/update-location
 * Update contractor's location (city will be auto-detected)
 * Body: { latitude, longitude }
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
    console.error('Error updating location:', err);
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
    console.error('Error fetching contractor stats:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching contractor stats',
      error: err.message,
    });
  }
});

// ✅ NEW: GET /leaderboard/contractors/by-district - Contractor leaderboard by district polygon + GPS location
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

    // ✅ Find district polygon containing the contractor's GPS point
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

    // ✅ FALLBACK: If no exact district match, find nearest district by centroid
    if (!district) {
      console.warn(`⚠️ No district polygon found for [${longitude}, ${latitude}], trying nearest centroid...`);
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
        console.log(`✅ Found nearest district by centroid: ${district.name}, ${district.state} (fallback match)`);
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

    console.log(`📍 Found district: ${district.name}, ${district.state} for location (${latitude}, ${longitude})`);

    // ✅ Aggregate contractors within the district polygon
    // Score by: avgRating * totalSpent * activeDays * hireCount
    const Job = require('../models/Jobs');
    const User = require('../models/User');

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
                  { $max: [1, { $divide: ['$totalSpent', 100] }] }, // Normalized spend
                  { $max: [1, { $add: [1, { $ln: { $max: [2, '$jobCount'] } }] }] }, // log boost
                  { $max: [1, { $add: [1, { $ln: { $max: [2, '$activeDays'] } }] }] }, // activity boost
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
      // Stage 6: Project final shape (rank will be added manually after this aggregation)
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

    // ✅ Add rank to each result
    const rankedLeaderboard = leaderboard.map((contractor, index) => ({
      ...contractor,
      rank: index + 1,
    }));

    // ✅ NEW: Save leaderboard snapshot to CityLeaderboard model for caching/historical tracking
    try {
      const leaderboardEntry = await CityLeaderboard.findOneAndUpdate(
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
      console.log(`✅ Saved leaderboard for district: ${district.name}, ${district.state}`);
    } catch (err) {
      console.error(`⚠️ Error saving leaderboard to database: ${err.message}`);
      // Don't fail response even if save fails
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
    console.error('❌ Error fetching contractor leaderboard:', err);
    res.status(500).json({
      success: false,
      message: 'Error fetching leaderboard',
      error: err.message,
    });
  }
});

module.exports = router;
