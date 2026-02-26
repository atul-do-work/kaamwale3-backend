function buildLogContext(req, extra = {}) {
  return {
    requestId: req?.requestId || null,
    route: req?.originalUrl || req?.url || null,
    method: req?.method || null,
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

module.exports = {
  buildLogContext,
  info,
  warn,
  error,
};
