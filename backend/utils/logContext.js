function buildLogContext(req, extra = {}) {
  const body = req?.body || {};
  const query = req?.query || {};
  const params = req?.params || {};
  const headers = req?.headers || {};
  const notes = body?.notes || body?.payload?.payment?.entity?.notes || {};

  const inferred = {
    requestId: req?.requestId || null,
    route: req?.originalUrl || req?.url || null,
    method: req?.method || null,
    jobId:
      extra?.jobId ||
      body?.jobId ||
      params?.jobId ||
      query?.jobId ||
      notes?.jobId ||
      null,
    orderId:
      extra?.orderId ||
      body?.orderId ||
      query?.orderId ||
      body?.payload?.payment?.entity?.order_id ||
      null,
    paymentId:
      extra?.paymentId ||
      body?.paymentId ||
      query?.paymentId ||
      body?.payload?.payment?.entity?.id ||
      null,
    workerPhone:
      extra?.workerPhone ||
      body?.workerPhone ||
      query?.workerPhone ||
      notes?.workerPhone ||
      notes?.phone ||
      null,
    idempotencyKey:
      extra?.idempotencyKey ||
      body?.idempotencyKey ||
      headers['x-idempotency-key'] ||
      null,
  };
  return {
    ...inferred,
    ...extra,
  };
}

function info(message, context = {}) {
  console.log(message, context);
}

function warn(message, context = {}) {
  console.warn(message, context);
}

function error(message, context = {}) {
  console.error(message, context);
}

function createCriticalRouteLogger({
  prefixes = ["/jobs", "/wallet", "/api/payment", "/api/payouts"],
} = {}) {
  return function criticalRouteLogger(req, res, next) {
    const route = req?.originalUrl || req?.url || "";
    const isCritical = prefixes.some((prefix) => route.startsWith(prefix));
    if (!isCritical) return next();

    const startedAt = Date.now();
    info("critical.route.request", buildLogContext(req));
    res.on("finish", () => {
      info("critical.route.response", buildLogContext(req, {
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
      }));
    });
    next();
  };
}

module.exports = {
  buildLogContext,
  info,
  warn,
  error,
  createCriticalRouteLogger,
};
