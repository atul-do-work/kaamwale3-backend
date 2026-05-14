function emptyEligibility() {
  return {
    consecutiveDays: 0,
    totalHours: 0,
    cancellationsInWindow: 0,
    lastWorkDate: null,
    eligibleFor5Days: false,
    eligibleFor10Days: false,
    eligibleFor20Days: false,
    requiredDailyHours: 8,
    requiredDaysFor5: 5,
    dailyQualificationTrail: [],
    fiveDayWindow: {
      requiredDays: 5,
      requiredDailyHours: 8,
      daysMetMinimumHours: 0,
      allDaysHaveMinHours: false,
      startDate: null,
      endDate: null,
      dailyStatus: [],
      failedDates: [],
      failureReason: "No completed paid-job history found",
    },
  };
}

function calculateEligibility(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return emptyEligibility();
  }

  try {
    const TZ = 'Asia/Kolkata';
    const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }); // YYYY-MM-DD
    const toDateKey = (d) => {
      try {
        return dateFormatter.format(d);
      } catch (e) {
        return new Date(d).toISOString().slice(0, 10);
      }
    };

    const byDate = new Map(); // key -> { minutes, jobs, cancellations }
    const REQUIRED_DAILY_HOURS = 8;
    const REQUIRED_DAILY_MINUTES = REQUIRED_DAILY_HOURS * 60;
    const REQUIRED_DAYS_FOR_5 = 5;

    for (const e of events) {
      const d = new Date(e.eventTime || e.createdAt || Date.now());
      const day = toDateKey(d);

      const minutes = Number(e.timeSpentMinutes || 0) || Math.round((Number(e.hoursWorked || 0) || 0) * 60);
      const jobs = (e.eventType === 'job_completed') ? 1 : 0;

      const prior = byDate.get(day) || { minutes: 0, jobs: 0, cancellations: 0 };
      prior.minutes += Number(minutes || 0);
      prior.jobs += jobs;

      // detect cancellations/declines robustly
      const eventType = String(e.eventType || '').toLowerCase();
      const status = String(e.status || '').toLowerCase();
      if (eventType.includes('cancel') || eventType.includes('declin') || status === 'cancelled') {
        prior.cancellations += 1;
      }

      byDate.set(day, prior);
    }

    const allKeys = Array.from(byDate.keys()).sort().reverse(); // newest first
    if (allKeys.length === 0) return emptyEligibility();

    // Build dailyQualificationTrail
    const dailyQualificationTrail = allKeys.map((day) => {
      const info = byDate.get(day) || { minutes: 0, jobs: 0, cancellations: 0 };
      const hoursWorked = Number((info.minutes || 0) / 60);
      const jobsCompleted = Number(info.jobs || 0);
      const declinesCount = Number(info.cancellations || 0);
      const hasCompletedJob = jobsCompleted > 0;
      const meetsMinimumHours = hasCompletedJob && (info.minutes || 0) >= REQUIRED_DAILY_MINUTES;
      const meetsNoDeclines = declinesCount === 0;
      const qualified = hasCompletedJob && meetsMinimumHours && meetsNoDeclines;
      return {
        date: day,
        jobsCompleted,
        hoursWorked: Number(hoursWorked.toFixed(2)),
        declinesCount,
        hasCompletedJob,
        meetsMinimumHours,
        meetsNoDeclines,
        qualified,
      };
    });

    // Determine latest day (newest key)
    const latestKey = allKeys[0];
    const latestDateObj = new Date(`${latestKey}T00:00:00.000+05:30`);

    // Compute consecutive qualified days ending at latestKey
    let consecutiveDays = 0;
    let streakMinutes = 0;
    for (let i = 0; ; i++) {
      const checkDate = new Date(latestDateObj);
      checkDate.setDate(latestDateObj.getDate() - i);
      const key = toDateKey(checkDate);
      const info = byDate.get(key) || { minutes: 0, jobs: 0, cancellations: 0 };
      const meetsMin = (info.minutes || 0) >= REQUIRED_DAILY_MINUTES && (info.jobs || 0) > 0 && (info.cancellations || 0) === 0;
      if (!meetsMin) break;
      consecutiveDays++;
      streakMinutes += Number(info.minutes || 0);
      // stop if we run out of history
      if (i > 365) break;
    }

    // Helper to check strict N-day window ending at latestKey
    const checkWindow = (n) => {
      for (let i = 0; i < n; i++) {
        const checkDate = new Date(latestDateObj);
        checkDate.setDate(latestDateObj.getDate() - i);
        const key = toDateKey(checkDate);
        const info = byDate.get(key) || { minutes: 0, jobs: 0, cancellations: 0 };
        if ((info.jobs || 0) === 0) return false;
        if ((info.minutes || 0) < REQUIRED_DAILY_MINUTES) return false;
        if ((info.cancellations || 0) > 0) return false;
      }
      return true;
    };

    const cancellationsInWindow = (function () {
      // count cancellations within the streak period (consecutiveDays)
      let c = 0;
      for (let i = 0; i < consecutiveDays; i++) {
        const checkDate = new Date(latestDateObj);
        checkDate.setDate(latestDateObj.getDate() - i);
        const key = toDateKey(checkDate);
        const info = byDate.get(key) || { cancellations: 0 };
        c += Number(info.cancellations || 0);
      }
      return c;
    })();

    // Build N-day windows
    const buildWindowStatus = (n) => {
      const arr = [];
      for (let i = n - 1; i >= 0; i--) {
        const d = new Date(latestDateObj);
        d.setDate(latestDateObj.getDate() - i);
        const key = toDateKey(d);
        const info = byDate.get(key) || { minutes: 0, jobs: 0, cancellations: 0 };
        arr.push({
          workDate: key,
          minutes: Math.max(0, Number(info.minutes || 0)),
          jobs: Number(info.jobs || 0),
          isQualified: (info.jobs || 0) > 0 && (info.minutes || 0) >= REQUIRED_DAILY_MINUTES && (info.cancellations || 0) === 0,
          reasons: [ ...(info.cancellations && info.cancellations > 0 ? ['CANCELLED_JOB'] : []), ...(info.minutes < REQUIRED_DAILY_MINUTES ? ['LOW_HOURS'] : []) ],
        });
      }
      return arr;
    };

    const fiveDayDailyStatus = buildWindowStatus(REQUIRED_DAYS_FOR_5);
    const daysWithCompletedJob = fiveDayDailyStatus.filter((d) => d.jobs > 0).length;
    const daysMetMinimumHours = fiveDayDailyStatus.filter((d) => d.minutes >= REQUIRED_DAILY_MINUTES).length;
    const daysQualified = fiveDayDailyStatus.filter((d) => d.isQualified).length;
    const failedDates = fiveDayDailyStatus.filter((d) => d.minutes < REQUIRED_DAILY_MINUTES).map((d) => d.workDate);
    const allDaysHaveMinHours = daysMetMinimumHours === REQUIRED_DAYS_FOR_5;

    let failureReason = null;
    if (daysWithCompletedJob === 0) {
      failureReason = 'No completed paid-job history found';
    } else if (!allDaysHaveMinHours) {
      failureReason = failedDates.length
        ? `Daily minimum ${REQUIRED_DAILY_HOURS}h not met on: ${failedDates.join(', ')}`
        : `Need ${REQUIRED_DAYS_FOR_5} consecutive days with at least ${REQUIRED_DAILY_HOURS} hours`;
    } else if (cancellationsInWindow > 0 || daysQualified < REQUIRED_DAYS_FOR_5) {
      failureReason = `Declines/cancellations found in streak window (${cancellationsInWindow})`;
    }

    const baseEligible = daysQualified === REQUIRED_DAYS_FOR_5;

    return {
      consecutiveDays,
      totalHours: Math.round((streakMinutes / 60) * 10) / 10,
      cancellationsInWindow,
      lastWorkDate: latestKey || null,
      eligibleFor5Days: checkWindow(5),
      eligibleFor10Days: checkWindow(10),
      eligibleFor20Days: checkWindow(20),
      requiredDailyHours: REQUIRED_DAILY_HOURS,
      requiredDaysFor5: REQUIRED_DAYS_FOR_5,
      dailyQualificationTrail,
      fiveDayWindow: {
        requiredDays: REQUIRED_DAYS_FOR_5,
        requiredDailyHours: REQUIRED_DAILY_HOURS,
        daysMetMinimumHours,
        allDaysHaveMinHours,
        startDate: fiveDayDailyStatus[0]?.workDate || null,
        endDate: fiveDayDailyStatus[fiveDayDailyStatus.length - 1]?.workDate || null,
        dailyStatus: fiveDayDailyStatus.map((d) => ({ date: d.workDate, jobsCompleted: d.jobs, hoursWorked: d.minutes / 60, hasCompletedJob: d.jobs > 0, meetsMinimumHours: d.minutes >= REQUIRED_DAILY_MINUTES, meetsNoDeclines: !(d.reasons || []).includes('CANCELLED_JOB'), dayQualified: d.isQualified, reasons: Array.isArray(d.reasons) ? d.reasons : [] })),
        failedDates,
        failureReason,
      },
    };
  } catch (err) {
    console.error('Error calculating eligibility:', err);
    return emptyEligibility();
  }
}

const MILESTONE_REWARDS = {
  '5days': 50,
  '10days': 150,
  '20days': 300,
};
const MILESTONE_IDS = Object.keys(MILESTONE_REWARDS);

const getClaimStatus = (record) => {
  if (!record) return 'locked';
  const status = String(record.walletCredit?.status || 'pending').toLowerCase();
  if (status === 'credited') return 'claimed';
  if (status === 'failed') return 'failed';
  return 'processing';
};

const buildClaimStatusByMilestone = (eligibilityData, ledgerRecords = []) => {
  const recordsByMilestone = ledgerRecords.reduce((acc, record) => {
    if (record?.milestoneId) acc[record.milestoneId] = record;
    return acc;
  }, {});

  return MILESTONE_IDS.reduce((acc, milestoneId) => {
    const record = recordsByMilestone[milestoneId];
    const isEligible = milestoneId === '5days'
      ? eligibilityData.eligibleFor5Days
      : milestoneId === '10days'
      ? eligibilityData.eligibleFor10Days
      : milestoneId === '20days'
      ? eligibilityData.eligibleFor20Days
      : false;
    acc[milestoneId] = record ? getClaimStatus(record) : isEligible ? 'available' : 'locked';
    return acc;
  }, {});
};

const emitIncentiveUpdatedEvent = (phone, payload = {}) => {
  try {
    if (global?.io) {
      const message = {
        phone,
        ...payload,
        timestamp: new Date(),
      };
      global.io.emit('incentiveUpdated', message);
      if (typeof global.io.to === 'function' && phone) {
        global.io.to(phone).emit('incentiveUpdated', message);
      }
    }
  } catch (err) {
    console.error('Failed to emit incentiveUpdated event:', err);
  }
};

/**
 * 🔧 FIX BUG #3: Recalculate incentive eligibility after gig updates
 * Called after:
 * - updateGigDataOnCompletion
 * - updateGigDataOnCancellation
 * 
 * This ensures worker.gigsData stays in sync with GigHistory events
 */
async function updateIncentiveEligibility(workerPhone) {
  try {
    const GigHistory = require('../models/GigHistory');
    const Worker = require('../models/Worker');

    const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '').slice(-10);
    const phoneDigits = normalizePhoneDigits(workerPhone);

    // Fetch recent gig history events
    const events = await GigHistory.find({
      $or: [
        { workerPhone: { $in: [workerPhone, phoneDigits] } },
        { workerPhone: { $regex: `${phoneDigits}$` } }
      ]
    })
      .sort({ eventTime: -1 })
      .limit(365)
      .lean();

    // Calculate eligibility from events
    const eligibilityData = calculateEligibility(events);

    // Update worker with calculated eligibility
    const updateFields = {
      'gigsData.eligibilitySnapshot': {
        consecutiveDays: eligibilityData.consecutiveDays,
        totalHours: eligibilityData.totalHours,
        cancellationsInWindow: eligibilityData.cancellationsInWindow,
        eligibleFor5Days: eligibilityData.eligibleFor5Days,
        eligibleFor10Days: eligibilityData.eligibleFor10Days,
        eligibleFor20Days: eligibilityData.eligibleFor20Days,
        lastWorkDate: eligibilityData.lastWorkDate,
        calculatedAt: new Date(),
        dailyQualificationTrail: eligibilityData.dailyQualificationTrail,
        fiveDayWindow: eligibilityData.fiveDayWindow,
      },
      'gigsData.consecutiveDays': eligibilityData.consecutiveDays,
      'gigsData.totalHours': eligibilityData.totalHours,
      'gigsData.lastWorkDate': eligibilityData.lastWorkDate ? new Date(`${eligibilityData.lastWorkDate}T00:00:00.000Z`) : null,
      'gigsData.eligibleFor5Days': eligibilityData.eligibleFor5Days,
      'gigsData.eligibleFor10Days': eligibilityData.eligibleFor10Days,
      'gigsData.eligibleFor20Days': eligibilityData.eligibleFor20Days,
      'gigsData.lastUpdated': new Date(),
    };

    const updateResult = await Worker.findOneAndUpdate(
      { phone: workerPhone },
      { $set: updateFields },
      { new: true }
    );

    if (!updateResult) {
      console.warn(`Worker not found for incentive update: ${workerPhone}`);
      return null;
    }

    emitIncentiveUpdatedEvent(workerPhone, {
      type: 'eligibility_recalculated',
      eligibleFor5Days: eligibilityData.eligibleFor5Days,
      eligibleFor10Days: eligibilityData.eligibleFor10Days,
      eligibleFor20Days: eligibilityData.eligibleFor20Days,
    });

    return updateResult;
  } catch (err) {
    console.error('Error updating incentive eligibility:', err);
    // Don't throw - this is secondary to main gig update
    return null;
  }
}

module.exports = {
  calculateEligibility,
  emptyEligibility,
  updateIncentiveEligibility, // 🔧 FIX: Export function for post-gig recalculation
  MILESTONE_REWARDS,
  MILESTONE_IDS,
  buildClaimStatusByMilestone,
  emitIncentiveUpdatedEvent,
};
