async function sendOpsAlert(title, details = {}) {
  try {
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

