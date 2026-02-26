const mongoose = require('mongoose');

const workerEarningsSchema = new mongoose.Schema({
  workerPhone: { type: String, required: true, index: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'INR' },
  status: { 
    type: String, 
    enum: ['pending', 'earned', 'payout_requested', 'payout_completed', 'cancelled'],
    default: 'pending'
  },
  source: { type: String, enum: ['app', 'webhook', 'admin', 'reconciliation'], default: 'app', index: true },
  provider: { type: String, default: 'razorpay' },
  orderId: { type: String, default: null },
  paymentId: { type: String, default: null },
  payoutId: { type: String, default: null },
  providerEventId: { type: String, default: null },
  idempotencyKey: { type: String, default: null },
  earnedAt: { type: Date, default: Date.now }, // When worker completed the job
  payoutRequestedAt: Date, // When worker requested payout
  payoutCompletedAt: Date, // When payment was sent
  payoutWeek: { // Which week this earning belongs to (for weekly payouts)
    year: Number,
    week: Number,
    startDate: Date,
    endDate: Date
  },
  payoutDetails: { // Track which payout batch this belonged to
    batchId: String,
    transactionId: String,
    bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    bankSnapshot: {
      accountName: String,
      maskedAccountNumber: String,
      ifscCode: String,
      bankName: String
    }
  },
  deductions: [
    {
      type: { type: String, enum: ['platform_fee', 'tax', 'penalty', 'adjustment'] },
      amount: Number,
      reason: String,
      appliedAt: Date
    }
  ],
  contractorName: String,
  contractorPhone: String,
  jobTitle: String,
  notes: String,
  metadata: { type: mongoose.Schema.Types.Mixed, default: null }
}, { timestamps: true });

// Index for efficient queries
workerEarningsSchema.index({ workerPhone: 1, status: 1 });
workerEarningsSchema.index({ 'payoutWeek.year': 1, 'payoutWeek.week': 1 });
workerEarningsSchema.index({ workerPhone: 1, earnedAt: -1 });
workerEarningsSchema.index({ status: 1, payoutRequestedAt: 1 });
workerEarningsSchema.index({ workerPhone: 1, jobId: 1 }, { unique: true });
workerEarningsSchema.index({ paymentId: 1 }, { unique: true, sparse: true });
workerEarningsSchema.index(
  { workerPhone: 1, jobId: 1, paymentId: 1 },
  {
    unique: true,
    partialFilterExpression: { paymentId: { $type: "string" } },
  }
);
workerEarningsSchema.index({ idempotencyKey: 1 }, { sparse: true });
workerEarningsSchema.index({ providerEventId: 1 }, { sparse: true });

module.exports = mongoose.model('WorkerEarnings', workerEarningsSchema);
