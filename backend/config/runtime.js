const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET ;
const SERVER_PUBLIC_URL = process.env.SERVER_PUBLIC_URL || "";

function getPublicBaseUrl(req) {
  if (SERVER_PUBLIC_URL) return SERVER_PUBLIC_URL.replace(/\/$/, "");

  const forwardedProto = req.headers["x-forwarded-proto"];
  const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : (forwardedProto || req.protocol || "https"))
    .toString()
    .split(",")[0]
    .trim();

  const host = process.env.SERVER_URL_DOMAIN || req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

module.exports = {
  PORT,
  JWT_SECRET,
  SERVER_PUBLIC_URL,
  getPublicBaseUrl,
};

