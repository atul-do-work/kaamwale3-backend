const User = require('../models/User');
const Job = require('../models/Jobs');

/**
 * Calculate leaderboard score for a contractor
 * 
 * Formula:
 * TOTAL_SCORE = (W1 × Jobs_Posted) + (W2 × Avg_Rating) + 
 *               (W3 × Days_Active) + (W4 × Completion_Rate) + 
 *               (W5 × Response_Time_Score)
 * 
 * Weights:
 * - W1 = 0.30 (Jobs Posted)
 * - W2 = 0.25 (Contractor Rating)
 * - W3 = 0.15 (Days Active)
 * - W4 = 0.20 (Completion Rate)
 * - W5 = 0.10 (Response Time)
 */

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
 * Get user stats aggregated from all their jobs
 */
async function getContractorStats(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) return null;

    // ✅ FIXED: Query jobs by contractorPhone (not contractorId) since Job model uses contractorPhone
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
    // In production, you'd track this when workers accept jobs
    const avgResponseTime = 24; // Placeholder - track in job acceptance

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
    console.error('Error getting contractor stats:', err);
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

    return Math.round(finalScore * 10) / 10; // Round to 1 decimal place
  } catch (err) {
    console.error('Error calculating score:', err);
    return 0;
  }
}

/**
 * Calculate city leaderboard - returns sorted array of contractors
 */
async function calculateCityLeaderboard(city, state) {
  try {
    // Get all contractors in this city
    const contractors = await User.find({
      city: city.toLowerCase(),
      state: state.toLowerCase(),
      role: 'contractor', // Only contractors
    });

    if (contractors.length === 0) {
      console.log(`ℹ️ No contractors found in ${city}, ${state}`);
      return [];
    }

    console.log(`📊 Calculating leaderboard for ${contractors.length} contractors in ${city}, ${state}`);

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
          console.warn(`⚠️ Error calculating score for contractor ${contractor.name}:`, contractorErr.message);
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

    console.log(`✅ Leaderboard calculated: ${leaderboardData.length} contractors ranked`);
    return leaderboardData;
  } catch (err) {
    console.error('❌ Error calculating city leaderboard:', err.message);
    console.error(err.stack);
    return [];
  }
}

module.exports = {
  calculateContractorScore,
  calculateCityLeaderboard,
  getTierByScore,
  WEIGHTS,
  TIER_THRESHOLDS,
};
