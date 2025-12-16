const mongoose = require('mongoose');

const contractorStatsSchema = new mongoose.Schema(
  {
    phone: {
      type: String,
      required: true,
      index: true, // Index for faster queries by phone
    },
    date: {
      type: Date,
      default: () => {
        const d = new Date();
        d.setHours(0, 0, 0, 0); // Reset to start of day for consistency
        return d;
      },
      index: true, // Index for date range queries
    },
    jobsPosted: {
      type: Number,
      default: 0,
    },
    jobsCompleted: {
      type: Number,
      default: 0,
    },
    workersEngaged: {
      type: Number,
      default: 0,
    },
    totalSpending: {
      type: Number,
      default: 0,
    },
    totalEarnings: {
      type: Number,
      default: 0,
    },
    averageRating: {
      type: Number,
      default: 0,
    },
    jobDetails: [
      {
        jobId: String,
        title: String,
        workerName: String,
        amount: Number,
        status: String, // 'completed', 'pending', 'cancelled'
        paymentStatus: String, // 'paid', 'pending'
        timestamp: Date,
      },
    ],
    workersList: [String], // List of unique workers who worked that day
    notes: String, // Additional notes or remarks
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

// Compound index for faster phone + date queries
contractorStatsSchema.index({ phone: 1, date: -1 });

const ContractorStats = mongoose.model('ContractorStats', contractorStatsSchema);

module.exports = ContractorStats;
