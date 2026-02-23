const GigHistory = require("../models/GigHistory");

const toWorkDate = (date) => {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return d.toISOString().slice(0, 10);
};

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

    if (!workerPhone || !jobId || !eventType) return null;

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
      hoursWorked: Number(hoursWorked) || 0,
      timeSpentMinutes: Number(timeSpentMinutes) || 0,
      eventTime,
      workDate: toWorkDate(eventTime),
      metadata,
    });
  } catch (err) {
    console.error("Gig history create error:", err.message);
    return null;
  }
}

module.exports = {
  createGigHistoryEvent,
  toWorkDate,
};

