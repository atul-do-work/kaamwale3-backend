function createJobEventLogger({ JobEventLog }) {
  return async function logJobEvent({
    jobId,
    eventType,
    actorType = "system",
    actorPhone = null,
    source = "system",
    oldState = null,
    newState = null,
    idempotencyKey = null,
    provider = null,
    providerEventId = null,
    reasonCode = null,
    reasonText = null,
    metadata = null,
  }) {
    try {
      if (!jobId || !eventType) return;
      await JobEventLog.create({
        jobId,
        eventType,
        actorType,
        actorPhone,
        source,
        oldState,
        newState,
        idempotencyKey,
        provider,
        providerEventId,
        reasonCode,
        reasonText,
        metadata,
        timestamp: new Date(),
      });
    } catch (e) {
      console.error("[job-event] failed:", e && e.message);
    }
  };
}

module.exports = {
  createJobEventLogger,
};

