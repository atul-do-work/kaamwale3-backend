const mongoose = require('mongoose');

const reconciliationRunSchema = new mongoose.Schema(
  {
    runType: {
      type: String,
      enum: ['daily', 'manual', 'hourly'],
      default: 'daily',
      index: true,
    },
    provider: { type: String, default: 'razorpay', index: true },
    runDate: { type: Date, required: true, index: true },
    startedAt: { type: Date, default: Date.now, index: true },
    completedAt: { type: Date, default: null },
    status: {
      type: String,
      enum: ['initiated', 'processing', 'completed', 'failed'],
      default: 'initiated',
      index: true,
    },
    summary: {
      ordersChecked: { type: Number, default: 0 },
      paymentsChecked: { type: Number, default: 0 },
      payoutsChecked: { type: Number, default: 0 },
      mismatchesFound: { type: Number, default: 0 },
      repairedCount: { type: Number, default: 0 },
    },
    mismatches: [
      {
        entityType: { type: String, enum: ['order', 'payment', 'payout', 'wallet_tx', 'withdrawal'] },
        localId: String,
        providerId: String,
        issue: String,
        resolved: { type: Boolean, default: false },
        resolutionAction: String,
        resolvedAt: Date,
      },
    ],
    notes: String,
    triggeredBy: { type: String, default: 'system' },
  },
  { timestamps: true }
);

reconciliationRunSchema.index({ provider: 1, runDate: -1 });
reconciliationRunSchema.index({ status: 1, startedAt: -1 });

module.exports = mongoose.model('ReconciliationRun', reconciliationRunSchema);
