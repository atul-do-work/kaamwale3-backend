const mongoose = require('mongoose');

// User model - keep schema minimal but useful for auth + profile
const userSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  phone: { type: String, unique: true, required: true, index: true },
  password: { type: String, default: '' },
  role: { type: String, default: 'worker', index: true },
  profilePhoto: { type: String, default: '' },
  profilePhotoPublicId: { type: String, default: '' },
  isAvailable: { type: Boolean, default: false },
  isBlocked: { type: Boolean, default: false },
  blockedReason: { type: String, default: '' },
  // Refresh tokens stored for session management - keep as array
  refreshTokens: {
    type: [
      new mongoose.Schema({
        token: String,
        issuedAt: Date,
        expiresAt: Date,
        deviceInfo: String,
      }, { _id: false })
    ],
    default: [],
  },
  // OTP flow (dev-mode)
  otpCode: { type: String, default: null },
  otpExpiry: { type: Date, default: null },
  phoneVerified: { type: Boolean, default: false },
  phoneVerifiedAt: { type: Date, default: null },
  // Security: OTP attempt tracking (brute force protection)
  otpAttempts: { type: Number, default: 0 },
  otpAttemptLockoutUntil: { type: Date, default: null },
  // Security: OTP request rate limiting
  otpRequestCount: { type: Number, default: 0 },
  otpRequestResetAt: { type: Date, default: null },
  // Device tokens for push notifications
  fcmToken: { type: String, default: null }, // ✅ Firebase Cloud Messaging token for OTP
  deviceTokens: { type: [String], default: [] },
  // Geolocation as GeoJSON
  location: {
    type: { type: String, default: "Point" },
    coordinates: { type: [Number], default: [0, 0] },
  },
  // ✅ NEW: City-wise leaderboard fields
  city: { type: String, default: '', index: true },
  state: { type: String, default: '' },
  latitude: { type: Number, default: 0 },
  longitude: { type: Number, default: 0 },
  locationLastUpdated: { type: Date, default: null },
  locationEnabled: { type: Boolean, default: false }, // ✅ Track if user has explicitly enabled location
  // Premium Plan (old format - keep as is)
  premiumPlan: {
    type: { type: String, default: 'free' },
    price: { type: Number, default: 0 },
    startDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    renewalAt: { type: Date, default: null },
    autoRenew: { type: Boolean, default: false },
    subscriptionId: { type: String, default: null },
    provider: { type: String, default: 'internal' },
    providerSubId: { type: String, default: null },
    invoiceId: { type: String, default: null },
    currency: { type: String, default: 'INR' },
    tax: { type: Number, default: 0 },
    coupon: { type: String, default: null },
    status: { type: String, default: 'inactive' },
    cancelAt: { type: Date, default: null },
    graceUntil: { type: Date, default: null },
    failureReason: { type: String, default: null },
    entitlements: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  // Leaderboard points for premium users
  points: { type: Number, default: 0 },
  // ✅ Average rating from completed jobs
  avgRating: { type: Number, default: 0, min: 0, max: 5 },
  // ✅ Worker Profile - Main Skill & Expected Wages
  mainSkill: { type: String, default: '' }, // Labour, Mason, Engineer, ITI/Technician
  expectedWage: { type: String, default: '' }, // 0-400, 400-550, 550-700, 700-max
  // ✅ User preferences for app settings
  preferences: {
    notifications: { type: Boolean, default: true },
    emailAlerts: { type: Boolean, default: true },
    language: { type: String, default: 'en' }, // 'en', 'hi', 'mr'
  },
  // ✅ Terms and Conditions
  agreedToTerms: { type: Boolean, default: false }, // User agreement to T&C during registration
  agreedToTermsAt: { type: Date, default: null }, // When user agreed to T&C
}, { timestamps: true });

// create 2dsphere index for location queries
// add 2dsphere index for geospatial queries
userSchema.index({ location: '2dsphere' });
userSchema.index({ role: 1 });
userSchema.index({ 'refreshTokens.token': 1 });
userSchema.index({ fcmToken: 1 });
userSchema.index({ deviceTokens: 1 });

module.exports = mongoose.model('User', userSchema);
