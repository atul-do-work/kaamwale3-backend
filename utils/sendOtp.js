// ✅ Firebase Cloud Messaging - OTP via Push Notifications
const admin = require('firebase-admin');

// Initialize Firebase Admin SDK
function initializeFirebase() {
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

      console.log('✅ Firebase initialized successfully');
    }
    return true;
  } catch (err) {
    console.error('❌ Firebase initialization error:', err.message);
    return false;
  }
}

// Generate OTP
function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP via Firebase Push Notification
async function sendOtpViaPush(phone, fcmToken) {
  try {
    if (!initializeFirebase()) {
      return { success: false, message: 'Firebase not configured' };
    }

    const otp = generateOtp();

    const message = {
      notification: {
        title: '🔐 Your Kaamwale OTP',
        body: `Your OTP is: ${otp}`,
      },
      data: {
        otp: otp,
        type: 'otp_verification',
      },
      android: {
        priority: 'high',
      },
      apns: {
        headers: {
          'apns-priority': '10',
        },
      },
    };

    const response = await admin.messaging().send({
      ...message,
      token: fcmToken,
    });

    console.log(`✅ OTP sent via Firebase Push to ${phone}. Message ID: ${response}`);
    return { success: true, otp: otp };
  } catch (err) {
    console.error('❌ Firebase Push Error:', err.message);
    return { success: false, message: 'Failed to send OTP: ' + err.message };
  }
}

// Send OTP via Console Fallback (for testing without FCM token)
function sendOtpViaConsole(phone) {
  try {
    const otp = generateOtp();
    console.log(`\n🔐 OTP for ${phone}: ${otp} (expires in 5 minutes)\n`);
    return { success: true, otp: otp };
  } catch (err) {
    console.error('❌ OTP Generation Error:', err.message);
    return { success: false, message: 'Failed to generate OTP' };
  }
}

// Main function - tries Firebase first, falls back to console
async function sendOtp(phone, fcmToken) {
  // If FCM token is provided, try Firebase
  if (fcmToken) {
    const result = await sendOtpViaPush(phone, fcmToken);
    if (result.success) {
      return { success: true, otp: result.otp, method: 'firebase' };
    }
  }

  // Fallback to console OTP (for testing)
  console.warn(`⚠️ No FCM token for ${phone}, using console OTP instead`);
  const result = sendOtpViaConsole(phone);
  return { success: result.success, otp: result.otp, method: 'console' };
}

module.exports = { sendOtp, generateOtp, sendOtpViaPush, sendOtpViaConsole, initializeFirebase };
