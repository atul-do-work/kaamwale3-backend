/**
 * Gigs Data Tracker Utility
 * Manages worker gig operational stats (recent gigs, totals, performance).
 * Incentive eligibility is computed from GigHistory elsewhere.
 */

const Worker = require("../models/Worker");

/**
 * Update worker gigs data when a job is completed
 */
exports.updateGigDataOnCompletion = async (workerPhone, jobData) => {
  try {
    const worker = await Worker.findOne({ phone: workerPhone });
    if (!worker) return;

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

    // Update gigs data
    worker.gigsData.totalGigsCompleted += 1;
    worker.gigsData.totalGigsAccepted -= 1; // Reduce from pending

    // Update earnings
    const amount = jobData.amount || 0;
    worker.gigsData.totalEarnings += amount;
    worker.gigsData.earningsPerDay.set(today, (worker.gigsData.earningsPerDay.get(today) || 0) + amount);

    // Update hours (assuming 8 hours per gig if not specified)
    const hours = jobData.hoursWorked || 8;
    worker.gigsData.totalHours += hours;
    worker.gigsData.hoursPerDay.set(today, (worker.gigsData.hoursPerDay.get(today) || 0) + hours);

    // Update consecutive days
    const lastWorkDate = worker.gigsData.lastWorkDate ? new Date(worker.gigsData.lastWorkDate).toISOString().split('T')[0] : null;
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    if (lastWorkDate === yesterday) {
      // Streak continues
      worker.gigsData.consecutiveDays += 1;
    } else if (lastWorkDate !== today) {
      // Streak broken or first day
      worker.gigsData.consecutiveDays = 1;
      worker.gigsData.streakStartDate = new Date();
    }

    worker.gigsData.lastWorkDate = new Date();

    // Add to recent gigs
    if (!worker.recentGigs) worker.recentGigs = [];
    worker.recentGigs.unshift({
      jobId: jobData._id,
      title: jobData.title,
      amount: jobData.amount,
      date: new Date(),
      status: 'completed',
      paymentStatus: 'Paid',
      contractorName: jobData.contractorName,
      completedAt: new Date(),
      hoursWorked: hours,
    });
    // Keep only last 10 gigs
    if (worker.recentGigs.length > 10) {
      worker.recentGigs.pop();
    }

    // Update performance metrics
    await updatePerformanceMetrics(worker);

    worker.gigsData.lastUpdated = new Date();
    await worker.save();

    return worker;
  } catch (err) {
    console.error('Error updating gig data on completion:', err);
  }
};

/**
 * Update worker gigs data when a job is cancelled
 */
exports.updateGigDataOnCancellation = async (workerPhone, jobData) => {
  try {
    const worker = await Worker.findOne({ phone: workerPhone });
    if (!worker) return;

    const today = new Date().toISOString().split('T')[0];

    worker.gigsData.totalGigsCancelled += 1;
    worker.gigsData.totalGigsAccepted -= 1;
    worker.gigsData.totalCancellations += 1;
    worker.gigsData.cancellationDates.push(new Date());

    // Add to recent gigs
    if (!worker.recentGigs) worker.recentGigs = [];
    worker.recentGigs.unshift({
      jobId: jobData._id,
      title: jobData.title,
      amount: jobData.amount,
      date: new Date(),
      status: 'cancelled',
      contractorName: jobData.contractorName,
      cancelledAt: new Date(),
    });
    if (worker.recentGigs.length > 10) {
      worker.recentGigs.pop();
    }

    // Update performance metrics
    await updatePerformanceMetrics(worker);

    worker.gigsData.lastUpdated = new Date();
    await worker.save();

    return worker;
  } catch (err) {
    console.error('Error updating gig data on cancellation:', err);
  }
};

/**
 * Update worker gigs data when a job is accepted
 */
exports.updateGigDataOnAcceptance = async (workerPhone, jobData) => {
  try {
    const worker = await Worker.findOne({ phone: workerPhone });
    if (!worker) return;

    worker.gigsData.totalGigsAccepted += 1;

    // Add to recent gigs
    if (!worker.recentGigs) worker.recentGigs = [];
    worker.recentGigs.unshift({
      jobId: jobData._id,
      title: jobData.title,
      amount: jobData.amount,
      date: new Date(),
      status: 'accepted',
      contractorName: jobData.contractorName,
      acceptedAt: new Date(),
    });
    if (worker.recentGigs.length > 10) {
      worker.recentGigs.pop();
    }

    worker.gigsData.lastUpdated = new Date();
    await worker.save();

    return worker;
  } catch (err) {
    console.error('Error updating gig data on acceptance:', err);
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
    if (eligibleFor5 && !worker.gigsData.milestonesUnlocked.fiveDaysMilestone) {
      worker.gigsData.milestonesUnlocked.fiveDaysMilestone = true;
      worker.gigsData.milestonesUnlocked.fiveDaysMilestone.unlockedDate = new Date();
      console.log(`✅ 5-day milestone unlocked for ${worker.phone}`);
    }

    if (eligibleFor10 && !worker.gigsData.milestonesUnlocked.tenDaysMilestone) {
      worker.gigsData.milestonesUnlocked.tenDaysMilestone = true;
      worker.gigsData.milestonesUnlocked.tenDaysMilestone.unlockedDate = new Date();
      console.log(`✅ 10-day milestone unlocked for ${worker.phone}`);
    }

    if (eligibleFor20 && !worker.gigsData.milestonesUnlocked.twentyDaysMilestone) {
      worker.gigsData.milestonesUnlocked.twentyDaysMilestone = true;
      worker.gigsData.milestonesUnlocked.twentyDaysMilestone.unlockedDate = new Date();
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
      totalEarnings: 0,
      earningsPerDay: new Map(),
      milestonesUnlocked: {
        fiveDaysMilestone: false,
        tenDaysMilestone: false,
        twentyDaysMilestone: false,
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
