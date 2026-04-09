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
    const completedByDay = new Map();
    const cancellationEvents = [];
    const cancellationDays = new Set();
    const cancellationCountByDay = new Map();
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
        cancellationDays.add(day);
        cancellationCountByDay.set(day, Number(cancellationCountByDay.get(day) || 0) + 1);
      }
    }

    const completedWorkDays = Array.from(completedByDay.entries())
      .filter(([, info]) => Number(info?.jobs || 0) > 0)
      .map(([day, info]) => ({
        dateObj: new Date(`${day}T00:00:00.000Z`),
        dateStr: day,
        hours: Number(info?.hours || 0),
      }))
      .sort((a, b) => b.dateObj - a.dateObj);

    if (completedWorkDays.length === 0) {
      return emptyEligibility();
    }

    // Daily audit trail (latest first) used by support/admin to explain eligibility.
    const allDays = new Set([
      ...Array.from(completedByDay.keys()),
      ...Array.from(cancellationCountByDay.keys()),
    ]);
    const dailyQualificationTrail = Array.from(allDays)
      .map((day) => {
        const info = completedByDay.get(day) || { hours: 0, jobs: 0 };
        const hoursWorked = Number(info.hours || 0);
        const jobsCompleted = Number(info.jobs || 0);
        const declinesCount = Number(cancellationCountByDay.get(day) || 0);
        const hasCompletedJob = jobsCompleted > 0;
        const meetsMinimumHours = hasCompletedJob && hoursWorked >= REQUIRED_DAILY_HOURS;
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
      })
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // A day counts toward streak progress only if:
    // 1) at least one completed paid job, 2) >=8 hours total, 3) no decline/cancel on that day.
    const qualifiedDays = completedWorkDays.filter(
      (d) => d.hours >= REQUIRED_DAILY_HOURS && !cancellationDays.has(d.dateStr)
    );

    // Bug #10 Fix: Initialize consecutiveDays to 0 before loop (avoid off-by-one error)
    let consecutiveDays = 0;
    let streakHours = 0;
    for (let i = 0; i < qualifiedDays.length; i++) {
      if (i === 0) {
        consecutiveDays = 1; // First qualified day counts as 1 consecutive day
        streakHours += Number(qualifiedDays[i]?.hours || 0);
        continue;
      }

      const prevDay = qualifiedDays[i - 1].dateObj;
      const currDay = qualifiedDays[i].dateObj;
      const dayDiff = Math.floor((prevDay - currDay) / (1000 * 60 * 60 * 24));

      if (dayDiff === 1) {
        consecutiveDays++;
        streakHours += qualifiedDays[i].hours;
      } else {
        break;
      }
    }

    const latest = (qualifiedDays[0] || completedWorkDays[0]).dateObj;
    const streakStart = new Date(latest);
    streakStart.setUTCDate(streakStart.getUTCDate() - Math.max(0, consecutiveDays - 1));

    const cancellationsInWindow = cancellationEvents.filter((day) => {
      const d = new Date(`${day}T00:00:00.000Z`);
      return d >= streakStart && d <= latest;
    }).length;

    // Build strict 5-day requirement window ending on latest completed-work day.
    const fiveDayDailyStatus = [];
    for (let i = REQUIRED_DAYS_FOR_5 - 1; i >= 0; i--) {
      const dayDate = new Date(latest);
      dayDate.setUTCDate(dayDate.getUTCDate() - i);
      const day = dayDate.toISOString().slice(0, 10);
      const info = completedByDay.get(day) || { hours: 0, jobs: 0 };
      const hoursWorked = Number(info.hours || 0);
      const jobsCompleted = Number(info.jobs || 0);
      const meetsMinimumHours = jobsCompleted > 0 && hoursWorked >= REQUIRED_DAILY_HOURS;
      const declinesCount = Number(cancellationCountByDay.get(day) || 0);
      const meetsNoDeclines = declinesCount === 0;
      const dayQualified = meetsMinimumHours && meetsNoDeclines;
      fiveDayDailyStatus.push({
        date: day,
        jobsCompleted,
        hoursWorked,
        declinesCount,
        hasCompletedJob: jobsCompleted > 0,
        meetsMinimumHours,
        meetsNoDeclines,
        dayQualified,
      });
    }
    const daysWithCompletedJob = fiveDayDailyStatus.filter((d) => d.hasCompletedJob).length;
    const daysMetMinimumHours = fiveDayDailyStatus.filter((d) => d.meetsMinimumHours).length;
    const daysQualified = fiveDayDailyStatus.filter((d) => d.dayQualified).length;
    const failedDates = fiveDayDailyStatus.filter((d) => !d.meetsMinimumHours).map((d) => d.date);
    const allDaysHaveMinHours = daysMetMinimumHours === REQUIRED_DAYS_FOR_5;

    let failureReason = null;
    if (daysWithCompletedJob === 0) {
      failureReason = "No completed paid-job history found";
    } else if (!allDaysHaveMinHours) {
      failureReason = failedDates.length
        ? `Daily minimum ${REQUIRED_DAILY_HOURS}h not met on: ${failedDates.join(", ")}`
        : `Need ${REQUIRED_DAYS_FOR_5} consecutive days with at least ${REQUIRED_DAILY_HOURS} hours`;
    } else if (cancellationsInWindow > 0 || daysQualified < REQUIRED_DAYS_FOR_5) {
      failureReason = `Declines/cancellations found in streak window (${cancellationsInWindow})`;
    }

    const baseEligible = daysQualified === REQUIRED_DAYS_FOR_5;

    return {
      consecutiveDays,
      totalHours: streakHours,
      cancellationsInWindow,
      lastWorkDate: (qualifiedDays[0] || completedWorkDays[0])?.dateStr || null,
      eligibleFor5Days: consecutiveDays >= 5 && baseEligible,
      eligibleFor10Days: consecutiveDays >= 10,
      eligibleFor20Days: consecutiveDays >= 20,
      requiredDailyHours: REQUIRED_DAILY_HOURS,
      requiredDaysFor5: REQUIRED_DAYS_FOR_5,
      dailyQualificationTrail,
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
