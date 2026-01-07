const NotificationHistory = require('../models/NotificationHistory');
const User = require('../models/User');
const { sendPushToToken } = require('./push');

async function retryPendingPushes(limit = 100) {
  try {
    const pending = await NotificationHistory.find({ pushNotificationSent: false }).sort({ createdAt: 1 }).limit(limit);
    if (!pending || pending.length === 0) return { success: true, count: 0 };

    for (const rec of pending) {
      const phone = rec.recipientPhone;
      try {
        const user = await User.findOne({ phone });
        if (!user || !user.fcmToken) continue;

        const r = await sendPushToToken(user.fcmToken, rec.title, rec.body, rec.metadata || {});
        if (r && r.success) {
          rec.pushNotificationSent = true;
          rec.pushNotificationSentAt = new Date();
          await rec.save();
          console.log('Retry: push sent for', phone);
        } else {
          const errInfo = r && (r.error || r.message) || '';
          const msg = (errInfo && (errInfo.code || errInfo.message || String(errInfo))) || '';
          // If token is invalid, clear it to avoid repeated failures
          if (typeof msg === 'string' && (msg.includes('registration-token-not-registered') || msg.includes('invalid-registration-token') || msg.includes('not-registered'))) {
            try {
              await User.findOneAndUpdate({ phone }, { $unset: { fcmToken: "" } });
              console.log('Retry: cleared invalid fcmToken for', phone);
            } catch (e) {
              console.error('Retry: failed clearing fcmToken for', phone, e && e.message);
            }
          }
          console.warn('Retry: push failed for', phone, msg);
        }
      } catch (inner) {
        console.error('Retry inner error for', rec.recipientPhone, inner && inner.message);
      }
    }

    return { success: true, count: pending.length };
  } catch (err) {
    console.error('Error in retryPendingPushes:', err && err.message);
    return { success: false, error: err };
  }
}

module.exports = { retryPendingPushes };
