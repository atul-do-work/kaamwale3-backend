const OpsAlert = require("../models/OpsAlert");

const recentAlertCache = new Map();
const ALERT_DEDUPE_TTL_MS = 2 * 60 * 1000;

function inferSeverity(title = "", details = {}) {
  const text = `${title} ${JSON.stringify(details || {})}`.toLowerCase();
  if (text.includes("critical") || text.includes("failed") || text.includes("mismatch") || text.includes("retry")) {
    return "critical";
  }
  if (text.includes("warning") || text.includes("stuck") || text.includes("duplicate")) {
    return "warning";
  }
  return "info";
}

function inferType(title = "") {
  const t = String(title || "").toLowerCase();
  if (t.includes("payment")) return "payment_mismatch";
  if (t.includes("stuck")) return "stuck_jobs";
  if (t.includes("duplicate")) return "duplicate_offers";
  if (t.includes("webhook")) return "webhook_retry";
  if (t.includes("reconciliation")) return "reconciliation";
  return "general";
}

async function sendOpsAlert(title, details = {}) {
  try {
    const dedupeKey = `${String(title || "")}:${JSON.stringify(details || {})}`;
    const now = Date.now();
    for (const [k, ts] of recentAlertCache.entries()) {
      if (now - ts > ALERT_DEDUPE_TTL_MS) recentAlertCache.delete(k);
    }
    if (!recentAlertCache.has(dedupeKey)) {
      recentAlertCache.set(dedupeKey, now);
      await OpsAlert.create({
        alertType: inferType(title),
        severity: inferSeverity(title, details),
        title: String(title || "Ops Alert"),
        message: details?.message ? String(details.message) : "",
        details,
        source: "backend",
        audiences: Array.isArray(details?.audiences) && details.audiences.length
          ? details.audiences.map((a) => String(a))
          : ["admin"],
        targetPhones: Array.isArray(details?.targetPhones)
          ? details.targetPhones.map((p) => String(p))
          : [],
      });
    }

    const webhookUrl = process.env.OPS_ALERT_WEBHOOK_URL;
    if (!webhookUrl) {
      console.error(`[ops-alert] ${title}`, details);
      return;
    }

    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title,
        details,
        service: 'backend',
        timestamp: new Date().toISOString(),
      }),
    });
  } catch (err) {
    console.error('[ops-alert] failed:', err && err.message);
  }
}

module.exports = { sendOpsAlert };
