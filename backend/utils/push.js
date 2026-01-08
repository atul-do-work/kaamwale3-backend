const admin = require('firebase-admin');
const User = require('../models/User');
const NotificationHistory = require('../models/NotificationHistory');

function initFirebase() {
  try {
    if (admin.apps.length === 0) {
      const serviceAccount = {
        projectId: process.env.FIREBASE_PROJECT_ID,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      };
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log('✅ Firebase initialized for push');
    }
    return true;
  } catch (err) {
    console.error('❌ Firebase init error in push util:', err && err.message);
    return false;
  }
}

async function sendPushToToken(token, title, body, data = {}) {
  try {
    if (!token) return { success: false, message: 'No token' };
    if (!initFirebase()) return { success: false, message: 'Firebase not initialized' };

    const message = {
      notification: { title, body },
      data: Object.fromEntries(Object.entries(data || {}).map(([k, v]) => [k, String(v)])),
      token,
      android: {
        priority: 'high',
        notification: {
          channelId: 'default',
          sound: 'default'
        }
      },
      apns: {
        headers: { 'apns-priority': '10' },
        payload: { aps: { sound: 'default' } }
      },
    };

    const res = await admin.messaging().send(message);
    return { success: true, id: res };
  } catch (err) {
    return { success: false, error: err };
  }
}

async function sendNotificationToUserPhone(phone, payload) {
  try {
    // create notification history entry
    const record = await NotificationHistory.create(Object.assign({ recipientPhone: phone, pushNotificationSent: false }, payload));

    // try to find user and send push
    const user = await User.findOne({ phone });
    if (user && user.fcmToken) {
      const r = await sendPushToToken(user.fcmToken, payload.title, payload.body, payload.metadata || {});
      if (r.success) {
        record.pushNotificationSent = true;
        record.pushNotificationSentAt = new Date();
        await record.save();
        return { success: true, record };
      } else {
        const errInfo = r.error || r.message || '';
        console.warn('Push send failed for', phone, errInfo);
        // If token is invalid or not registered, clear it to avoid repeated failures
        const msg = (errInfo && (errInfo.code || errInfo.message || String(errInfo))) || '';
        if (typeof msg === 'string' && (msg.includes('registration-token-not-registered') || msg.includes('invalid-registration-token') || msg.includes('not-registered'))) {
          try {
            await User.findOneAndUpdate({ phone }, { $unset: { fcmToken: "" } });
            console.log('Cleared invalid fcmToken for', phone);
          } catch (e) {
            console.error('Failed clearing fcmToken for', phone, e && e.message);
          }
        }
        return { success: false, record, error: errInfo };
      }
    }

    // No token - leave record for retries
    return { success: false, record, message: 'No fcmToken' };
  } catch (err) {
    console.error('Error in sendNotificationToUserPhone:', err && err.message);
    return { success: false, error: err };
  }
}

async function sendJobOfferPushToWorkers(workerPhones, job, metadata = {}) {
  try {
    if (!workerPhones || workerPhones.length === 0) {
      console.log('No workers to send job offer push');
      return { success: true, sent: 0, failed: 0 };
    }

    let sent = 0, failed = 0;

    for (const workerPhone of workerPhones) {
      try {
        const result = await sendNotificationToUserPhone(workerPhone, {
          type: 'job_offer',
          title: `New Job: ${job.title}`,
          body: `₹${job.amount} • ${job.workerType || 'General'} • Nearby`,
          jobId: job._id.toString(),
          metadata: {
            jobTitle: job.title,
            amount: job.amount,
            workerType: job.workerType,
            lat: job.lat,
            lon: job.lon,
            actionRequired: true,
            ...metadata
          },
          deepLink: `worker/jobs/${job._id.toString()}`,
        });

        if (result.success) {
          sent++;
          console.log(`📨 Job offer push sent to ${workerPhone}`);
        } else {
          failed++;
          console.warn(`⚠️ Job offer push failed for ${workerPhone}`);
        }
      } catch (e) {
        failed++;
        console.error(`Error sending job offer to ${workerPhone}:`, e && e.message);
      }
    }

    return { success: true, sent, failed, total: workerPhones.length };
  } catch (err) {
    console.error('Error in sendJobOfferPushToWorkers:', err && err.message);
    return { success: false, error: err };
  }
}

module.exports = { initFirebase, sendPushToToken, sendNotificationToUserPhone, sendJobOfferPushToWorkers };
