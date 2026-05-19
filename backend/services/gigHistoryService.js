const GigHistory = require("../models/GigHistory");

/**
 * 🔧 FIX BUG #10: Convert date to IST (Asia/Kolkata) instead of UTC
 * This ensures consecutive day calculations use the worker's local timezone
 * Previously used UTC which could cause dates to shift for IST workers
 */
const toWorkDate = (date) => {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  try {
    // Use IST timezone for consistent date calculations
    const TZ = 'Asia/Kolkata';
    const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
    return dateFormatter.format(d); // IST date string
  } catch (err) {
    console.warn('Timezone formatting error, falling back to UTC:', err);
    return d.toISOString().slice(0, 10);
  }
};

/**
 * 🔧 FIX BUG #2: Add validation and warning logs for missing fields
 * 🔧 FIX BUG #6: Add type validation for hoursWorked to prevent silent NaN->0 conversion
 */
async function createGigHistoryEvent(payload) {
  try {
    const {
      workerPhone,
      workerName,
      jobId,
      jobTitle,
      contractorPhone,
      contractorName,
      eventType,
      status,
      paymentStatus,
      hoursWorked = 0,
      timeSpentMinutes = 0,
      eventTime = new Date(),
      metadata = {},
    } = payload || {};

    // 🔧 FIX BUG #2: Warn instead of silently returning null
    if (!workerPhone || !jobId || !eventType) {
      console.warn('GigHistory event discarded: missing required fields', { workerPhone, jobId, eventType });
      return null;
    }

    // 🔧 FIX BUG #6: Validate hoursWorked type and warn about bad data
    let validatedHours = 0;
    let validatedMinutes = 0;
    
    const hours = Number(hoursWorked);
    if (isNaN(hours) || hours < 0) {
      console.warn(`Invalid hoursWorked: ${hoursWorked}`);
      validatedHours = 0;
    } else {
      validatedHours = hours;
    }

    const minutes = Number(timeSpentMinutes);
    if (isNaN(minutes)) {
      console.warn(`[GigHistory] Invalid timeSpentMinutes value: ${timeSpentMinutes} (non-numeric), defaulting to 0`);
      validatedMinutes = 0;
    } else if (minutes < 0) {
      console.warn(`[GigHistory] Negative timeSpentMinutes value: ${minutes}, clamping to 0`);
      validatedMinutes = 0;
    } else {
      validatedMinutes = minutes;
    }

    return await GigHistory.create({
      workerPhone,
      workerName: workerName || "",
      jobId,
      jobTitle: jobTitle || "",
      contractorPhone: contractorPhone || "",
      contractorName: contractorName || "",
      eventType,
      status: status || "",
      paymentStatus: paymentStatus || "",
      hoursWorked: validatedHours,
      timeSpentMinutes: validatedMinutes,
      eventTime,
      workDate: toWorkDate(eventTime),
      metadata,
    });
  } catch (err) {
    console.error("[GigHistory] Error creating gig history event:", err.message, { payload });
    return null;
  }
}

module.exports = {
  createGigHistoryEvent,
  toWorkDate,
};

