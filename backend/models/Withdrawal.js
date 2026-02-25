const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, index: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ['initiated', 'processing', 'success', 'failed', 'reversed'],
      default: 'initiated',
      index: true,
    },
    walletTransactionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    provider: { type: String, default: 'razorpay' },
    providerPayoutId: { type: String, index: true, sparse: true },
    providerReferenceId: { type: String, default: null },
    providerEventId: { type: String, default: null },
    retryCount: { type: Number, default: 0 },
    failureReason: { type: String, default: null },
    reconciledAt: { type: Date, default: null },
    balanceSource: {
      type: String,
      enum: ['available', 'pocket'],
      default: 'available',
    },
    deductedFromAvailable: { type: Number, default: 0 },
    deductedFromPocket: { type: Number, default: 0 },
    bankSnapshot: {
      accountHolderName: String,
      maskedAccount: String,
      ifscCode: String,
      bankName: String,
      accountType: String,
    },
  },
  { timestamps: true }
);

withdrawalSchema.index({ phone: 1, createdAt: -1 });

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
