const mongoose = require('mongoose');

const workerEarningsSchema = new mongoose.Schema({
  workerPhone: { type: String, required: true, index: true },
  jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true },
  amount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ['pending', 'earned', 'payout_requested', 'payout_completed', 'cancelled'],
    default: 'pending'
  },
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
    bankDetails: {
      accountName: String,
      accountNumber: String,
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
  notes: String
}, { timestamps: true });

// Index for efficient queries
workerEarningsSchema.index({ workerPhone: 1, status: 1 });
workerEarningsSchema.index({ 'payoutWeek.year': 1, 'payoutWeek.week': 1 });

module.exports = mongoose.model('WorkerEarnings', workerEarningsSchema);
