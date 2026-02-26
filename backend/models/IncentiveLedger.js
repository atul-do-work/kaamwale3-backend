const mongoose = require('mongoose');

/**
 * IncentiveLedger - Tracks claimed milestone rewards atomically
 * 
 * Purpose:
 * - Prevent duplicate reward claims (user can't claim ₹50 twice for 5-day milestone)
 * - Audit trail (who claimed what, when, for how much)
 * - Atomic wallet credit with idempotency (same as payment processing)
 * 
 * Architecture:
 * - Unique compound index (phone, milestoneId): ensures one reward per milestone per user
 * - Only backend calculates eligibility (frontend trusts this)
 * - Wallet credit happens ONLY after claim is recorded here
 * - Full audit trail for fraud detection
 */
const incentiveLedgerSchema = new mongoose.Schema({
  // ✅ Worker identification
  phone: { type: String, required: true, index: true },
  workerName: String,

  // ✅ Milestone identification
  milestoneId: { 
    type: String, 
    required: true, 
    enum: ['5days', '10days', '20days'],
    index: true
  },

  // ✅ Reward details
  rewardAmount: {
    type: Number,
    required: true,
    enum: [50, 150, 300],
    validate: {
      validator: function() {
        // Map milestoneId to expected reward amount
        const rewardMap = {
          '5days': 50,
          '10days': 150,
          '20days': 300
        };
        return this.rewardAmount === rewardMap[this.milestoneId];
      },
      message: 'Reward amount must match milestone: 5days=50, 10days=150, 20days=300'
    }
  },

  // ✅ Eligibility snapshot (what qualified the user at claim time)
  eligibilityData: {
    consecutiveDays: { type: Number, required: true },
    totalHours: { type: Number, required: true },
    cancellationsInWindow: { type: Number, required: true, default: 0 },
    requiredDailyHours: { type: Number, default: 8 },
    requiredDaysFor5: { type: Number, default: 5 },
    fiveDayWindow: {
      daysMetMinimumHours: { type: Number, default: 0 },
      allDaysHaveMinHours: { type: Boolean, default: false },
      startDate: { type: String, default: null },
      endDate: { type: String, default: null },
      failedDates: { type: [String], default: [] },
      failureReason: { type: String, default: null },
    },
    dailyQualificationTrail: [{
      date: { type: String, default: null },
      jobsCompleted: { type: Number, default: 0 },
      hoursWorked: { type: Number, default: 0 },
      declinesCount: { type: Number, default: 0 },
      hasCompletedJob: { type: Boolean, default: false },
      meetsMinimumHours: { type: Boolean, default: false },
      meetsNoDeclines: { type: Boolean, default: true },
      qualified: { type: Boolean, default: false },
    }],
    lastWorkDate: String, // YYYY-MM-DD format
    verifiedAt: Date
  },

  // ✅ Wallet credit status (atomic operation tracking)
  walletCredit: {
    status: { 
      type: String, 
      enum: ['pending', 'processing', 'credited', 'failed'],
      default: 'pending'
    },
    walletTransactionId: String, // Link to wallet transaction for audit
    creditedAt: Date,
    error: String, // If failed, store error message for retry logic
    retryCount: { type: Number, default: 0 } // Retry attempts
  },

  // ✅ Fraud detection fields
  claimedBy: String, // User agent / app version
  ipAddress: String, // For fraud/analytics
  deviceId: String, // Optional: mobile device identifier
  appVersion: String, // Optional: app version at claim time

}, { timestamps: true }); // Auto-manages createdAt and updatedAt

// ✅ Unique compound index: one milestone per user per phone
incentiveLedgerSchema.index(
  { phone: 1, milestoneId: 1 },
  { unique: true, sparse: false }
);

// ✅ Secondary indexes for queries
incentiveLedgerSchema.index({ claimedAt: -1 }); // For audit trail queries
incentiveLedgerSchema.index({ 'walletCredit.status': 1 }); // For retry queries

module.exports = mongoose.model('IncentiveLedger', incentiveLedgerSchema);

