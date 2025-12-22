const mongoose = require('mongoose');

// User model - keep schema minimal but useful for auth + profile
const userSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  phone: { type: String, unique: true, required: true },
  password: { type: String, default: '' },
  role: { type: String, default: 'worker' },
  profilePhoto: { type: String, default: '' },
  isAvailable: { type: Boolean, default: false },
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
  // Premium Plan (old format - keep as is)
  premiumPlan: {
    type: { type: String, default: 'free' },
    price: { type: Number, default: 0 },
    startDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null },
    autoRenew: { type: Boolean, default: false },
  },
  // Leaderboard points for premium users
  points: { type: Number, default: 0 },
}, { timestamps: true });

// create 2dsphere index for location queries
// add 2dsphere index for geospatial queries
userSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('User', userSchema);
