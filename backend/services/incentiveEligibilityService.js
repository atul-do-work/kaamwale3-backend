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
    const completedByDay = new Map();
    const cancellationEvents = [];
    const REQUIRED_DAILY_HOURS = 8;
    const REQUIRED_DAYS_FOR_5 = 5;

    for (const e of events) {
      const d = new Date(e.eventTime || e.createdAt || Date.now());
      const day = d.toISOString().slice(0, 10);

      if (e.eventType === "job_completed") {
        const h = Number(e.hoursWorked || 0);
        const prior = completedByDay.get(day) || { hours: 0, jobs: 0 };
        completedByDay.set(day, {
          hours: prior.hours + h,
          jobs: prior.jobs + 1,
        });
      }

      if (e.eventType === "job_declined_offer" || e.eventType === "job_cancelled_by_worker") {
        cancellationEvents.push(day);
      }
    }

    const workDays = Array.from(completedByDay.entries())
      .filter(([, info]) => Number(info?.hours || 0) >= REQUIRED_DAILY_HOURS && Number(info?.jobs || 0) > 0)
      .map(([day, info]) => ({
        dateObj: new Date(`${day}T00:00:00.000Z`),
        dateStr: day,
        hours: Number(info?.hours || 0),
      }))
      .sort((a, b) => b.dateObj - a.dateObj);

    if (workDays.length === 0) {
      return emptyEligibility();
    }

    let consecutiveDays = 0;
    let streakHours = 0;
    for (let i = 0; i < workDays.length; i++) {
      if (i === 0) {
        consecutiveDays = 1;
        streakHours += workDays[i].hours;
        continue;
      }

      const prevDay = workDays[i - 1].dateObj;
      const currDay = workDays[i].dateObj;
      const dayDiff = Math.floor((prevDay - currDay) / (1000 * 60 * 60 * 24));

      if (dayDiff === 1) {
        consecutiveDays++;
        streakHours += workDays[i].hours;
      } else {
        break;
      }
    }

    const latest = workDays[0].dateObj;
    const streakStart = new Date(latest);
    streakStart.setUTCDate(streakStart.getUTCDate() - (consecutiveDays - 1));

    const cancellationsInWindow = cancellationEvents.filter((day) => {
      const d = new Date(`${day}T00:00:00.000Z`);
      return d >= streakStart && d <= latest;
    }).length;

    // Build strict 5-day requirement window ending on latest qualifying day.
    const fiveDayDailyStatus = [];
    for (let i = REQUIRED_DAYS_FOR_5 - 1; i >= 0; i--) {
      const dayDate = new Date(latest);
      dayDate.setUTCDate(dayDate.getUTCDate() - i);
      const day = dayDate.toISOString().slice(0, 10);
      const info = completedByDay.get(day) || { hours: 0, jobs: 0 };
      const hoursWorked = Number(info.hours || 0);
      const jobsCompleted = Number(info.jobs || 0);
      const meetsMinimumHours = jobsCompleted > 0 && hoursWorked >= REQUIRED_DAILY_HOURS;
      fiveDayDailyStatus.push({
        date: day,
        jobsCompleted,
        hoursWorked,
        hasCompletedJob: jobsCompleted > 0,
        meetsMinimumHours,
      });
    }
    const daysMetMinimumHours = fiveDayDailyStatus.filter((d) => d.meetsMinimumHours).length;
    const failedDates = fiveDayDailyStatus.filter((d) => !d.meetsMinimumHours).map((d) => d.date);
    const allDaysHaveMinHours = daysMetMinimumHours === REQUIRED_DAYS_FOR_5;

    let failureReason = null;
    if (!allDaysHaveMinHours) {
      failureReason = failedDates.length
        ? `Daily minimum ${REQUIRED_DAILY_HOURS}h not met on: ${failedDates.join(", ")}`
        : `Need ${REQUIRED_DAYS_FOR_5} consecutive days with at least ${REQUIRED_DAILY_HOURS} hours`;
    } else if (cancellationsInWindow > 0) {
      failureReason = `Declines/cancellations found in streak window (${cancellationsInWindow})`;
    }

    const baseEligible = allDaysHaveMinHours && cancellationsInWindow === 0;

    return {
      consecutiveDays,
      totalHours: streakHours,
      cancellationsInWindow,
      lastWorkDate: workDays[0]?.dateStr || null,
      eligibleFor5Days: consecutiveDays >= 5 && baseEligible,
      eligibleFor10Days: consecutiveDays >= 10 && cancellationsInWindow === 0,
      eligibleFor20Days: consecutiveDays >= 20 && cancellationsInWindow === 0,
      requiredDailyHours: REQUIRED_DAILY_HOURS,
      requiredDaysFor5: REQUIRED_DAYS_FOR_5,
      fiveDayWindow: {
        requiredDays: REQUIRED_DAYS_FOR_5,
        requiredDailyHours: REQUIRED_DAILY_HOURS,
        daysMetMinimumHours,
        allDaysHaveMinHours,
        startDate: fiveDayDailyStatus[0]?.date || null,
        endDate: fiveDayDailyStatus[fiveDayDailyStatus.length - 1]?.date || null,
        dailyStatus: fiveDayDailyStatus,
        failedDates,
        failureReason,
      },
    };
  } catch (err) {
    console.error("Error calculating eligibility:", err);
    return emptyEligibility();
  }
}

module.exports = {
  calculateEligibility,
  emptyEligibility,
};
