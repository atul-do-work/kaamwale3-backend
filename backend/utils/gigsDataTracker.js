/**
 * Gigs Data Tracker Utility
 * Manages worker gig operational stats (recent gigs, totals, performance).
 * Incentive eligibility is computed from GigHistory elsewhere.
 */

const Worker = require("../models/Worker");

/**
 * Update worker gigs data when a job is completed (ATOMIC)
 * 🔧 FIX: Use atomic $inc to prevent race conditions
 * 🔧 FIX: Call incentive recalculation after update
 */
exports.updateGigDataOnCompletion = async (workerPhone, jobData) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const hours = jobData.hoursWorked || 8;
    const amount = jobData.amount || 0;

    // ✅ ATOMIC UPDATE - prevents race conditions
    const updated = await Worker.findOneAndUpdate(
      { phone: workerPhone },
      {
        $inc: {
          'gigsData.totalGigsCompleted': 1,
          // decrement active accepted (in-flight) count, do NOT decrement lifetime totalGigsAccepted
          'gigsData.activeAcceptedCount': -1,
          'gigsData.totalEarnings': amount,
          'gigsData.totalHours': hours,
        },
        $set: {
          'gigsData.lastUpdated': new Date(),
          'gigsData.lastWorkDate': new Date(),
        },
        $push: {
          recentGigs: {
            $each: [{
              jobId: jobData._id,
              title: jobData.title,
              amount: amount,
              date: new Date(),
              status: 'completed',
              paymentStatus: 'paid',
              contractorName: jobData.contractorName,
              completedAt: new Date(),
              hoursWorked: hours,
            }],
            $slice: -10, // Keep only last 10 gigs
          }
        }
      },
      { new: true }
    );

    if (!updated) {
      console.warn(`Worker not found for gig completion: ${workerPhone}, attempting creation`);
      try {
        await Worker.create({
          phone: workerPhone,
          gigsData: {
            consecutiveDays: 0,
            lastWorkDate: null,
            streakStartDate: null,
            totalHours: 0,
            hoursPerDay: new Map(),
            totalCancellations: 0,
            cancellationDates: [],
            totalGigsAccepted: 0,
            totalGigsCompleted: 0,
            totalGigsCancelled: 0,
            totalGigsPending: 0,
            activeAcceptedCount: 0,
            totalEarnings: 0,
            earningsPerDay: new Map(),
            milestonesUnlocked: {
              fiveDaysMilestone: { unlocked: false, unlockedDate: null },
              tenDaysMilestone: { unlocked: false, unlockedDate: null },
              twentyDaysMilestone: { unlocked: false, unlockedDate: null },
            },
            eligibleFor5Days: false,
            eligibleFor10Days: false,
            eligibleFor20Days: false,
            lastUpdated: new Date(),
          },
        });
        updated = await Worker.findOne({ phone: workerPhone });
      } catch (createErr) {
        console.error('Failed to create worker:', createErr);
        return null;
      }
    }

    // 🔧 FIX: Recalculate incentive eligibility after gig update
    try {
      const { updateIncentiveEligibility } = require('../services/incentiveEligibilityService');
      await updateIncentiveEligibility(workerPhone);
    } catch (eligibilityErr) {
      console.error('Error recalculating incentive eligibility on completion:', eligibilityErr);
      // Don't fail the whole operation - incentive is secondary
    }

    return updated;
  } catch (err) {
    console.error('Error updating gig data on completion:', err);
    return null;
  }
};

/**
 * Update worker gigs data when a job is cancelled (ATOMIC)
 * 🔧 FIX: Use atomic $inc to prevent race conditions
 * 🔧 FIX: Call incentive recalculation after update
 */
exports.updateGigDataOnCancellation = async (workerPhone, jobData) => {
  try {
    const today = new Date().toISOString().split('T')[0];

    // ✅ ATOMIC UPDATE - prevents race conditions
    const updated = await Worker.findOneAndUpdate(
      { phone: workerPhone },
      {
        $inc: {
          'gigsData.totalGigsCancelled': 1,
          // decrement active accepted (in-flight) count, do NOT decrement lifetime totalGigsAccepted
          'gigsData.activeAcceptedCount': -1,
          'gigsData.totalCancellations': 1,
        },
        $set: {
          'gigsData.lastUpdated': new Date(),
        },
        $push: {
          'gigsData.cancellationDates': new Date(),
          recentGigs: {
            $each: [{
              jobId: jobData._id,
              title: jobData.title,
              amount: jobData.amount,
              date: new Date(),
              status: 'cancelled',
              contractorName: jobData.contractorName,
              cancelledAt: new Date(),
            }],
            $slice: -10, // Keep only last 10 gigs
          }
        }
      },
      { new: true }
    );

    if (!updated) {
      console.warn(`Worker not found for gig cancellation: ${workerPhone}`);
      return null;
    }

    // 🔧 FIX: Recalculate incentive eligibility after cancellation (affects decline count)
    try {
      const { updateIncentiveEligibility } = require('../services/incentiveEligibilityService');
      await updateIncentiveEligibility(workerPhone);
    } catch (eligibilityErr) {
      console.error('Error recalculating incentive eligibility on cancellation:', eligibilityErr);
      // Don't fail the whole operation - incentive is secondary
    }

    return updated;
  } catch (err) {
    console.error('Error updating gig data on cancellation:', err);
    return null;
  }
};

/**
 * Update worker gigs data when a job is accepted (ATOMIC)
 * 🔧 FIX: Use atomic $inc to prevent race conditions
 * 🔧 FIX: Call incentive recalculation after update (BUG #1)
 */
exports.updateGigDataOnAcceptance = async (workerPhone, jobData) => {
  try {
    // ✅ ATOMIC UPDATE - prevents race conditions
    const updated = await Worker.findOneAndUpdate(
      { phone: workerPhone },
      {
        $inc: {
          // increment lifetime total and active accepted counter
          'gigsData.totalGigsAccepted': 1,
          'gigsData.activeAcceptedCount': 1,
        },
        $set: {
          'gigsData.lastUpdated': new Date(),
        },
        $push: {
          recentGigs: {
            $each: [{
              jobId: jobData._id,
              title: jobData.title,
              amount: jobData.amount,
              date: new Date(),
              status: 'accepted',
              contractorName: jobData.contractorName,
              acceptedAt: new Date(),
            }],
            $slice: -10, // Keep only last 10 gigs
          }
        }
      },
      { new: true }
    );

    if (!updated) {
      console.warn(`Worker not found for gig acceptance: ${workerPhone}`);
      return null;
    }

    // 🔧 FIX BUG #1: Recalculate incentive eligibility after acceptance (was missing)
    try {
      const { updateIncentiveEligibility } = require('../services/incentiveEligibilityService');
      await updateIncentiveEligibility(workerPhone);
    } catch (eligibilityErr) {
      console.error('Error recalculating incentive eligibility on acceptance:', eligibilityErr);
      // Don't fail the whole operation - incentive is secondary
    }

    return updated;
  } catch (err) {
    console.error('Error updating gig data on acceptance:', err);
    return null;
  }
};

/**
 * Check and update incentive eligibility
 * Requirements:
 * - 5/10/20 consecutive days
 * - Minimum 7 hours per day (35/70/140 total)
 * - Max 1 cancellation
 */
async function updateIncentiveEligibility(worker) {
  try {
    const consecutiveDays = worker.gigsData.consecutiveDays;
    const totalHours = worker.gigsData.totalHours;
    const cancellations = worker.gigsData.totalCancellations;

    // Calculate average hours per day
    const avgHoursPerDay = consecutiveDays > 0 ? totalHours / consecutiveDays : 0;

    // Check 5-day milestone
    const eligibleFor5 =
      consecutiveDays >= 5 &&
      totalHours >= 35 && // 7 hours/day * 5 days
      cancellations <= 1 &&
      avgHoursPerDay >= 7;

    // Check 10-day milestone
    const eligibleFor10 =
      consecutiveDays >= 10 &&
      totalHours >= 70 && // 7 hours/day * 10 days
      cancellations <= 1 &&
      avgHoursPerDay >= 7 &&
      eligibleFor5;

    // Check 20-day milestone
    const eligibleFor20 =
      consecutiveDays >= 20 &&
      totalHours >= 140 && // 7 hours/day * 20 days
      cancellations <= 1 &&
      avgHoursPerDay >= 7 &&
      eligibleFor10;

    // Update eligibility
    worker.gigsData.eligibleFor5Days = eligibleFor5;
    worker.gigsData.eligibleFor10Days = eligibleFor10;
    worker.gigsData.eligibleFor20Days = eligibleFor20;

    // Track when milestones were unlocked
    // Bug #6 Fix: Store milestone as object with unlock date (not boolean)
    if (eligibleFor5 && !(worker.gigsData.milestonesUnlocked?.fiveDaysMilestone?.unlocked)) {
      worker.gigsData.milestonesUnlocked = worker.gigsData.milestonesUnlocked || {};
      worker.gigsData.milestonesUnlocked.fiveDaysMilestone = {
        unlocked: true,
        unlockedDate: new Date(),
      };
      console.log(`✅ 5-day milestone unlocked for ${worker.phone}`);
    }

    if (eligibleFor10 && !(worker.gigsData.milestonesUnlocked?.tenDaysMilestone?.unlocked)) {
      worker.gigsData.milestonesUnlocked = worker.gigsData.milestonesUnlocked || {};
      worker.gigsData.milestonesUnlocked.tenDaysMilestone = {
        unlocked: true,
        unlockedDate: new Date(),
      };
      console.log(`✅ 10-day milestone unlocked for ${worker.phone}`);
    }

    if (eligibleFor20 && !(worker.gigsData.milestonesUnlocked?.twentyDaysMilestone?.unlocked)) {
      worker.gigsData.milestonesUnlocked = worker.gigsData.milestonesUnlocked || {};
      worker.gigsData.milestonesUnlocked.twentyDaysMilestone = {
        unlocked: true,
        unlockedDate: new Date(),
      };
      console.log(`✅ 20-day milestone unlocked for ${worker.phone}`);
    }
  } catch (err) {
    console.error('Error updating incentive eligibility:', err);
  }
}

/**
 * Update worker performance metrics
 */
async function updatePerformanceMetrics(worker) {
  try {
    const completed = worker.gigsData.totalGigsCompleted || 0;
    const accepted = worker.gigsData.totalGigsAccepted || 0;
    const cancelled = worker.gigsData.totalGigsCancelled || 0;
    const total = completed + cancelled + accepted;

    // Calculate completion rate
    worker.performanceMetrics.completionRate = total > 0 ? (completed / total) * 100 : 0;

    // Calculate cancellation rate
    worker.performanceMetrics.cancellationRate = total > 0 ? (cancelled / total) * 100 : 0;

    // Calculate average hours per gig
    const gigsWithHours = (worker.recentGigs || []).filter(g => g.hoursWorked > 0).length;
    if (gigsWithHours > 0) {
      const totalHours = (worker.recentGigs || []).reduce((sum, g) => sum + (g.hoursWorked || 0), 0);
      worker.performanceMetrics.averageHoursPerGig = totalHours / gigsWithHours;
    }

    // Calculate average earnings per gig
    if (completed > 0) {
      worker.performanceMetrics.averageEarningsPerGig = worker.gigsData.totalEarnings / completed;
    }

    // Rating info (if available)
    if (worker.rating) {
      worker.performanceMetrics.averageRating = worker.rating;
    }
  } catch (err) {
    console.error('Error updating performance metrics:', err);
  }
}

/**
 * Get worker gigs summary for display
 */
exports.getWorkerGigsSummary = async (workerPhone) => {
  try {
    const worker = await Worker.findOne({ phone: workerPhone });
    if (!worker) return null;

    return {
      consecutiveDays: worker.gigsData.consecutiveDays,
      totalHours: worker.gigsData.totalHours,
      totalCancellations: worker.gigsData.totalCancellations,
      totalEarnings: worker.gigsData.totalEarnings,
      completionRate: worker.performanceMetrics.completionRate,
      averageRating: worker.performanceMetrics.averageRating,
      milestonesUnlocked: worker.gigsData.milestonesUnlocked,
      recentGigs: worker.recentGigs || [],
    };
  } catch (err) {
    console.error('Error getting gigs summary:', err);
    return null;
  }
};

/**
 * Reset worker gigs data (for testing or manual reset)
 */
exports.resetWorkerGigsData = async (workerPhone) => {
  try {
    const worker = await Worker.findOne({ phone: workerPhone });
    if (!worker) return;

    worker.gigsData = {
      consecutiveDays: 0,
      lastWorkDate: null,
      streakStartDate: null,
      totalHours: 0,
      hoursPerDay: new Map(),
      totalCancellations: 0,
      cancellationDates: [],
      totalGigsAccepted: 0,
      totalGigsCompleted: 0,
      totalGigsCancelled: 0,
      totalGigsPending: 0,
      // activeAcceptedCount tracks in-flight accepted jobs (not lifetime)
      activeAcceptedCount: 0,
      totalEarnings: 0,
      earningsPerDay: new Map(),
      milestonesUnlocked: {
        fiveDaysMilestone: { unlocked: false, unlockedDate: null },
        tenDaysMilestone: { unlocked: false, unlockedDate: null },
        twentyDaysMilestone: { unlocked: false, unlockedDate: null },
      },
      eligibleFor5Days: false,
      eligibleFor10Days: false,
      eligibleFor20Days: false,
      lastUpdated: new Date(),
    };

    worker.recentGigs = [];
    await worker.save();

    return worker;
  } catch (err) {
    console.error('Error resetting gigs data:', err);
  }
};
