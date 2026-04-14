const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const User = require("../models/User");
const { sendOtp } = require("../utils/sendOtp");
const { authenticateToken } = require("../utils/auth");

// ✅ SECURITY: Generic response for failed password reset attempts
const GENERIC_ERROR = "Invalid phone or password reset failed";

// ✅ SECURITY: Phone validation - exactly 10 digits, numeric only
function isValidPhoneNumber(phone) {
  if (!phone || typeof phone !== 'string') return false;
  // Must be exactly 10 digits
  return /^\d{10}$/.test(phone);
}

function createAuthSupportRouter({ JWT_SECRET, sendNotificationToUserPhone, sessionStore }) {
  const router = express.Router();

  router.post("/auth/forgot-password-request", async (req, res) => {
    try {
      const { phone } = req.body;

      // ✅ SECURITY: Validate phone format (exactly 10 digits, numeric only)
      if (!isValidPhoneNumber(phone)) {
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      const user = await User.findOne({ phone });
      if (!user) {
        // ✅ SECURITY: Generic error to prevent phone enumeration
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      // ✅ SECURITY: Rate limiting - max 3 OTP requests per hour
      const now = new Date();
      const oneHourAgo = new Date(now - 60 * 60 * 1000);

      if (user.otpRequestResetAt && user.otpRequestResetAt > oneHourAgo) {
        // Still in the same hour
        if (user.otpRequestCount >= 3) {
          return res.status(429).json({ 
            success: false, 
            message: "Too many OTP requests. Please try again later." 
          });
        }
        user.otpRequestCount += 1;
      } else {
        // New hour
        user.otpRequestCount = 1;
        user.otpRequestResetAt = now;
      }

      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      const otpExpiry = new Date(Date.now() + 10 * 60 * 1000);
      user.otpCode = otp;
      user.otpExpiry = otpExpiry;
      user.otpAttempts = 0; // Reset attempt counter on new OTP request
      user.otpAttemptLockoutUntil = null;
      await user.save();

      try {
        if (user.fcmToken) {
          await sendNotificationToUserPhone(phone, {
            type: "forgot_password_otp",
            title: "Password Reset OTP",
            body: `Your OTP is: ${otp}. Valid for 10 minutes.`,
            data: { type: "forgot_password", actionRequired: true },
          });
        }
      } catch (pushErr) {
        console.error("Failed to send forgot-password OTP push:", pushErr.message);
      }

      return res.json({ success: true, message: "OTP sent to your phone number" });
    } catch (err) {
      console.error("Forgot password request error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/auth/forgot-password-verify-otp", async (req, res) => {
    try {
      const { phone, otp } = req.body;
      
      // ✅ SECURITY: Validate phone format
      if (!isValidPhoneNumber(phone) || !otp) {
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      const user = await User.findOne({ phone });
      if (!user) {
        // ✅ SECURITY: Generic error to prevent phone enumeration
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      // ✅ SECURITY: Brute force protection - check if locked out
      const now = new Date();
      if (user.otpAttemptLockoutUntil && now < user.otpAttemptLockoutUntil) {
        const remainingMinutes = Math.ceil((user.otpAttemptLockoutUntil - now) / (60 * 1000));
        return res.status(429).json({ 
          success: false, 
          message: `Too many failed attempts. Try again in ${remainingMinutes} minutes.` 
        });
      }

      if (user.otpCode !== otp) {
        // ✅ SECURITY: Increment attempt counter
        user.otpAttempts = (user.otpAttempts || 0) + 1;
        
        // Lock account after 5 failed attempts for 30 minutes
        if (user.otpAttempts >= 5) {
          user.otpAttemptLockoutUntil = new Date(Date.now() + 30 * 60 * 1000);
          await user.save();
          return res.status(429).json({ 
            success: false, 
            message: "Too many failed attempts. Please try again later." 
          });
        }

        await user.save();
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      if (!user.otpExpiry || new Date() > user.otpExpiry) {
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      // ✅ SECURITY: Reset failed-attempt counters but keep the OTP available
      // for the password reset endpoint, which still requires the same OTP.
      user.otpAttempts = 0;
      user.otpAttemptLockoutUntil = null;
      await user.save();

      return res.json({ success: true, message: "OTP verified successfully" });
    } catch (err) {
      console.error("OTP verification error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/auth/forgot-password-reset", async (req, res) => {
    try {
      const { phone, otp, newPassword, confirmPassword } = req.body;

      // ✅ SECURITY: Validate phone format and all required fields
      if (!isValidPhoneNumber(phone) || !otp || !newPassword || !confirmPassword) {
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      // ✅ SECURITY: Validate password requirements
      if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ success: false, message: "Password must be at least 8 characters long" });
      }
      if (!/\d/.test(newPassword)) {
        return res.status(400).json({ success: false, message: "Password must contain at least one number" });
      }
      if (!/[A-Z]/.test(newPassword)) {
        return res.status(400).json({ success: false, message: "Password must contain at least one uppercase letter" });
      }
      if (!/[a-z]/.test(newPassword)) {
        return res.status(400).json({ success: false, message: "Password must contain at least one lowercase letter" });
      }

      // ✅ SECURITY: Validate password confirmation matches
      if (newPassword !== confirmPassword) {
        return res.status(400).json({ success: false, message: "Passwords do not match" });
      }

      const user = await User.findOne({ phone });
      if (!user) {
        // ✅ SECURITY: Generic error to prevent phone enumeration
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      if (user.otpCode !== otp) {
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }
      if (!user.otpExpiry || new Date() > user.otpExpiry) {
        return res.status(400).json({ success: false, message: GENERIC_ERROR });
      }

      // ✅ SECURITY: Hash password and clear OTP BEFORE saving to prevent race conditions
      const hashedPassword = await bcrypt.hash(newPassword, 10);
      user.password = hashedPassword;
      // Clear OTP IMMEDIATELY to invalidate it
      user.otpCode = null;
      user.otpExpiry = null;
      user.otpAttempts = 0;
      user.otpAttemptLockoutUntil = null;
      // Strong security: revoke all existing refresh tokens after password change
      user.refreshTokens = [];

      // Invalidate all server-side sessions (if using express-session)
      if (sessionStore && typeof sessionStore.all === 'function') {
        sessionStore.all((err, sessions) => {
          if (!err && sessions) {
            Object.entries(sessions).forEach(([sid, sess]) => {
              try {
                const s = typeof sess === 'string' ? JSON.parse(sess) : sess;
                if (s?.userId && s.userId.toString() === user._id.toString()) {
                  sessionStore.destroy(sid, (destroyErr) => {
                    if (destroyErr) console.error('Failed to destroy session', sid, destroyErr);
                  });
                }
              } catch (parseErr) {
                console.warn('Could not parse session content', parseErr);
              }
            });
          }
        });
      }

      await user.save();

      try {
        if (user.fcmToken) {
          await sendNotificationToUserPhone(phone, {
            type: "password_reset_success",
            title: "Password Changed",
            body: "Your password has been successfully reset. You can now login with your new password.",
            data: { type: "password_reset_success", actionRequired: false },
          });
        }
      } catch (pushErr) {
        console.error("Failed to send password-reset confirmation push:", pushErr.message);
      }

      return res.json({
        success: true,
        message: "Password reset successfully. Please login with your new password.",
      });
    } catch (err) {
      console.error("Password reset error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/auth/request-otp", async (req, res) => {
    try {
      const { phone, name, role, fcmToken } = req.body;
      
      // ✅ SECURITY: Validate phone format (exactly 10 digits, numeric only)
      if (!isValidPhoneNumber(phone)) {
        return res.status(400).json({ success: false, message: "Invalid phone number format" });
      }

      let user = await User.findOne({ phone });
      if (!user) {
        user = new User({ phone, name: name || "Unknown", role: role || "worker" });
      }

      if (fcmToken) {
        user.fcmToken = fcmToken;
      }
      await user.save();

      const tokenToUse = fcmToken || user.fcmToken || null;
      const otpResult = await sendOtp(phone, tokenToUse);

      if (!otpResult.success) {
        return res.status(400).json({ success: false, message: otpResult.message });
      }

      user.otpCode = otpResult.otp;
      user.otpExpiry = new Date(Date.now() + 1000 * 60 * 5);
      await user.save();

      const method = fcmToken ? "push notification" : "console (dev-mode)";
      return res.json({ success: true, message: `OTP sent via ${method}`, method: otpResult.method });
    } catch (err) {
      console.error("Request OTP error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/auth/verify-otp", async (req, res) => {
    try {
      const { phone, otp } = req.body;
      
      // ✅ SECURITY: Validate phone format
      if (!isValidPhoneNumber(phone) || !otp) {
        return res.status(400).json({ success: false, message: "Invalid phone or OTP" });
      }

      const user = await User.findOne({ phone });
      if (!user) {
        return res.status(400).json({ success: false, message: "Invalid phone or OTP" });
      }

      // ✅ SECURITY: Check for brute force lockout
      const now = new Date();
      if (user.otpAttemptLockoutUntil && now < user.otpAttemptLockoutUntil) {
        const remainingMinutes = Math.ceil((user.otpAttemptLockoutUntil - now) / (60 * 1000));
        return res.status(429).json({ 
          success: false, 
          message: `Too many failed attempts. Try again in ${remainingMinutes} minutes.` 
        });
      }

      if (!user.otpCode || !user.otpExpiry || new Date() > user.otpExpiry || user.otpCode !== otp) {
        // ✅ SECURITY: Increment attempt counter and lock after 5 failures
        user.otpAttempts = (user.otpAttempts || 0) + 1;
        if (user.otpAttempts >= 5) {
          user.otpAttemptLockoutUntil = new Date(Date.now() + 30 * 60 * 1000);
          await user.save();
          return res.status(429).json({ 
            success: false, 
            message: "Too many failed attempts. Please try again later." 
          });
        }
        await user.save();
        return res.status(400).json({ success: false, message: "Invalid phone or OTP" });
      }

      user.phoneVerified = true;
      user.phoneVerifiedAt = new Date();
      user.otpCode = null;
      user.otpExpiry = null;
      user.otpAttempts = 0;
      user.otpAttemptLockoutUntil = null;

      const accessToken = jwt.sign(
        { name: user.name, phone: user.phone, role: user.role },
        JWT_SECRET,
        { expiresIn: "1h" }
      );
      const refreshToken = crypto.randomBytes(40).toString("hex");
      const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30);
      user.refreshTokens.push({
        token: refreshToken,
        issuedAt: new Date(),
        expiresAt,
        deviceInfo: req.headers["user-agent"] || "unknown",
      });

      await user.save();
      return res.json({
        success: true,
        user: { name: user.name, phone: user.phone, role: user.role },
        accessToken,
        refreshToken,
      });
    } catch (err) {
      console.error("Verify OTP error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/auth/refresh", async (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ success: false, message: "refreshToken required" });

      const user = await User.findOne({ "refreshTokens.token": refreshToken });
      if (!user) return res.status(401).json({ success: false, message: "Invalid refresh token" });

      const entry = user.refreshTokens.find((r) => r.token === refreshToken);
      if (!entry || new Date() > new Date(entry.expiresAt)) {
        return res.status(401).json({ success: false, message: "Refresh token expired" });
      }

      const accessToken = jwt.sign(
        { name: user.name, phone: user.phone, role: user.role },
        JWT_SECRET,
        { expiresIn: "1h" }
      );
      return res.json({ success: true, accessToken });
    } catch (err) {
      console.error("Refresh token error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/auth/logout", async (req, res) => {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(400).json({ success: false, message: "refreshToken required" });

      const user = await User.findOne({ "refreshTokens.token": refreshToken });
      if (!user) return res.json({ success: true });

      user.refreshTokens = user.refreshTokens.filter((r) => r.token !== refreshToken);
      await user.save();
      return res.json({ success: true });
    } catch (err) {
      console.error("Logout error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/auth/refresh-fcm-token", authenticateToken, async (req, res) => {
    try {
      const { fcmToken } = req.body;
      if (!fcmToken) {
        return res.status(400).json({ success: false, message: "FCM token required" });
      }

      const user = await User.findOne({ phone: req.user.phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      user.fcmToken = fcmToken;
      await user.save();
      return res.json({ success: true, message: "FCM token updated" });
    } catch (err) {
      console.error("Error refreshing FCM token:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createAuthSupportRouter };
