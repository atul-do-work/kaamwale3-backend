// ✅ Twilio Verify API - OTP Delivery Service
const twilio = require('twilio');

async function sendOtp(phone) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const serviceId = process.env.TWILIO_VERIFY_SERVICE_ID;
    
    if (!accountSid || !authToken || !serviceId) {
      console.warn('⚠️ Twilio credentials not configured in .env');
      return { success: false, message: 'SMS service not configured' };
    }

    const client = twilio(accountSid, authToken);

    // Format phone number to international format if needed
    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;

    // Send OTP via Twilio Verify
    const verification = await client.verify.v2
      .services(serviceId)
      .verifications
      .create({ to: formattedPhone, channel: 'sms' });

    console.log(`✅ OTP sent to ${formattedPhone}. SID: ${verification.sid}`);
    return { success: true, message: 'OTP sent to your phone' };
  } catch (err) {
    console.error('❌ Twilio Error:', err.message);
    return { success: false, message: 'Failed to send OTP: ' + err.message };
  }
}

// Verify OTP via Twilio
async function verifyOtp(phone, otp) {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const serviceId = process.env.TWILIO_VERIFY_SERVICE_ID;
    
    if (!accountSid || !authToken || !serviceId) {
      return { success: false, message: 'SMS service not configured' };
    }

    const client = twilio(accountSid, authToken);
    const formattedPhone = phone.startsWith('+') ? phone : `+91${phone}`;

    // Verify OTP via Twilio
    const verificationCheck = await client.verify.v2
      .services(serviceId)
      .verificationChecks
      .create({ to: formattedPhone, code: otp });

    if (verificationCheck.status === 'approved') {
      console.log(`✅ OTP verified for ${formattedPhone}`);
      return { success: true, message: 'OTP verified' };
    } else {
      return { success: false, message: 'Invalid OTP' };
    }
  } catch (err) {
    console.error('❌ Twilio Verification Error:', err.message);
    return { success: false, message: 'Failed to verify OTP' };
  }
}

module.exports = { sendOtp, verifyOtp };
