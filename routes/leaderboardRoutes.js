const express = require('express');
const axios = require('axios');
const { authenticateToken } = require('../utils/auth');
const User = require('../models/User');
const CityLeaderboard = require('../models/CityLeaderboard');
const { calculateCityLeaderboard } = require('../services/leaderboardService');
const { normalizeLocation } = require('../utils/cityHierarchy');

const router = express.Router();

// Reverse geocoding using OpenStreetMap Nominatim API (free, no key needed)
async function reverseGeocode(latitude, longitude) {
  try {
    const response = await axios.get(
      `https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}`,
      {
        headers: {
          'User-Agent': 'KaamwaleApp/1.0', // Required by Nominatim
        },
        timeout: 5000,
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

    // ✅ NEW: Normalize location to parent city
    const normalized = normalizeLocation(city, state);

    return {
      city: normalized.city,
      state: normalized.state,
      region: normalized.region,
      originalLocation: normalized.originalLocation,
      isMapped: normalized.isMapped,
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

    if (!geoData.success) {
      return res.status(400).json({
        success: false,
        message: 'Could not determine city from coordinates',
      });
    }

    // Try to get from cache first
    let leaderboard = await CityLeaderboard.findOne({
      city: geoData.city,
      state: geoData.state,
    });

    // If not in cache or expired, calculate fresh
    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      const leaderboardData = await calculateCityLeaderboard(geoData.city, geoData.state);

      // Save to cache
      leaderboard = await CityLeaderboard.findOneAndUpdate(
        { city: geoData.city, state: geoData.state },
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
        city: cityName.toLowerCase(),
        state: state.toLowerCase(),
      });
    } else {
      // Try to find any city with this name
      leaderboard = await CityLeaderboard.findOne({
        city: cityName.toLowerCase(),
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
          ? { city: cityName.toLowerCase(), state: state.toLowerCase() }
          : { city: cityName.toLowerCase() },
        {
          city: cityName.toLowerCase(),
          state: (state || 'Unknown').toLowerCase(),
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
      city: geoData.city,
      state: geoData.state,
    });

    if (!leaderboard || new Date() > leaderboard.expiresAt) {
      const leaderboardData = await calculateCityLeaderboard(geoData.city, geoData.state);

      leaderboard = await CityLeaderboard.findOneAndUpdate(
        { city: geoData.city, state: geoData.state },
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

module.exports = router;
