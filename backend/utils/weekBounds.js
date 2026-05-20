const PAYOUT_CYCLE_ANCHOR_ISO = process.env.PAYOUT_CYCLE_ANCHOR_ISO || "2025-02-25T00:00:00+05:30";
const PAYOUT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

function getWeekBounds(now = new Date()) {
  const anchor = new Date(PAYOUT_CYCLE_ANCHOR_ISO);
  if (Number.isNaN(anchor.getTime())) {
    const fallbackStart = new Date(now);
    const day = fallbackStart.getDay(); // 0=Sun
    const diff = day === 0 ? -6 : 1 - day; // Monday-start week fallback
    fallbackStart.setDate(fallbackStart.getDate() + diff);
    fallbackStart.setHours(0, 0, 0, 0);
    const fallbackEnd = new Date(fallbackStart);
    fallbackEnd.setDate(fallbackEnd.getDate() + 7);
    return { start: fallbackStart, endExclusive: fallbackEnd };
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  const cycleIndex = Math.floor(elapsedMs / PAYOUT_CYCLE_MS);
  const cycleStartMs = anchor.getTime() + cycleIndex * PAYOUT_CYCLE_MS;
  const start = new Date(cycleStartMs);
  const endExclusive = new Date(cycleStartMs + PAYOUT_CYCLE_MS);
  return { start, endExclusive };
}

function getIsoWeekNumber(date = new Date()) {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function getPayoutWeekInfo(date = new Date()) {
  const { start, endExclusive } = getWeekBounds(date);
  return {
    year: start.getUTCFullYear(),
    week: getIsoWeekNumber(start),
    startDate: start,
    endDate: new Date(endExclusive.getTime() - 1),
  };
}

module.exports = {
  PAYOUT_CYCLE_ANCHOR_ISO,
  PAYOUT_CYCLE_MS,
  getWeekBounds,
  getIsoWeekNumber,
  getPayoutWeekInfo,
};
