const mongoose = require('mongoose');

const payoutBatchSchema = new mongoose.Schema({
  batchId: { type: String, required: true, unique: true }, // e.g., "PAYOUT_2025_W01"
  payoutWeek: {
    year: Number,
    week: Number,
    startDate: Date,
    endDate: Date
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed', 'cancelled'],
    default: 'pending'
  },
  totalAmount: { type: Number, default: 0 },
  totalWorkers: { type: Number, default: 0 },
  workers: [
    {
      workerPhone: String,
      workerName: String,
      earningsAmount: Number,
      deductions: Number,
      netAmount: Number,
      transactionId: String,
      status: {
        type: String,
        enum: ['pending', 'success', 'failed', 'manual_review'],
        default: 'pending'
      },
      failureReason: String,
      bankDetails: {
        accountName: String,
        accountNumber: String,
        ifscCode: String,
        bankName: String
      }
    }
  ],
  createdAt: { type: Date, default: Date.now },
  processedAt: Date,
  completedAt: Date,
  notes: String,
  adminNotes: String,
  processedBy: String // Admin who initiated the payout
}, { timestamps: true });

payoutBatchSchema.index({ batchId: 1 });
payoutBatchSchema.index({ 'payoutWeek.year': 1, 'payoutWeek.week': 1 });
payoutBatchSchema.index({ status: 1 });

module.exports = mongoose.model('PayoutBatch', payoutBatchSchema);
