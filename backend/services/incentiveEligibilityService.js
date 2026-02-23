function emptyEligibility() {
  return {
    consecutiveDays: 0,
    totalHours: 0,
    cancellationsInWindow: 0,
    lastWorkDate: null,
    eligibleFor5Days: false,
    eligibleFor10Days: false,
    eligibleFor20Days: false,
  };
}

function calculateEligibility(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return emptyEligibility();
  }

  try {
    const completedByDay = new Map();
    const cancellationEvents = [];

    for (const e of events) {
      const d = new Date(e.eventTime || e.createdAt || Date.now());
      const day = d.toISOString().slice(0, 10);

      if (e.eventType === "job_completed") {
        const h = Number(e.hoursWorked || 0);
        completedByDay.set(day, (completedByDay.get(day) || 0) + h);
      }

      if (e.eventType === "job_declined_offer" || e.eventType === "job_cancelled_by_worker") {
        cancellationEvents.push(day);
      }
    }

    const workDays = Array.from(completedByDay.entries())
      .filter(([, hours]) => hours >= 8)
      .map(([day, hours]) => ({
        dateObj: new Date(`${day}T00:00:00.000Z`),
        dateStr: day,
        hours,
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

    return {
      consecutiveDays,
      totalHours: streakHours,
      cancellationsInWindow,
      lastWorkDate: workDays[0]?.dateStr || null,
      eligibleFor5Days: consecutiveDays >= 5 && cancellationsInWindow === 0,
      eligibleFor10Days: consecutiveDays >= 10 && cancellationsInWindow === 0,
      eligibleFor20Days: consecutiveDays >= 20 && cancellationsInWindow === 0,
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

