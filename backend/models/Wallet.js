const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true, unique: true, index: true },
    balance: { type: Number, default: 0 },
    availableBalance: { type: Number, default: 0 },
    pocketBalance: { type: Number, default: 0 },
    bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
    transactions: [
      {
        type: {
          type: String,
          enum: ['deposit', 'withdraw', 'payment', 'job_post_fee', 'refund', 'premium_subscription', 'pocket_deposit'],
        },
        amount: Number,
        date: { type: Date, default: Date.now },
        description: String,
        orderId: String,
        paymentId: { type: String },
        jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null },
        withdrawalId: { type: mongoose.Schema.Types.ObjectId, ref: 'Withdrawal', default: null },
        payoutId: { type: String, default: null },
        reconciliationId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReconciliationRun', default: null },
        idempotencyKey: { type: String, default: null },
        status: { type: String, default: 'completed' }, // completed, pending, failed
        openingBalance: { type: Number, immutable: true },
        closingBalance: { type: Number, immutable: true },
        source: { type: String, immutable: true }, // app, webhook, admin, reconciliation
        provider: { type: String, immutable: true }, // razorpay, internal
        providerEventId: { type: String, immutable: true }, // webhook/payment/payout id
        metadata: { type: mongoose.Schema.Types.Mixed, default: null },
      },
    ],
    totalDeposited: { type: Number, default: 0 },
    totalWithdrawn: { type: Number, default: 0 },
    totalEarned: { type: Number, default: 0 },
  },
  { timestamps: true }
);

walletSchema.index({ 'transactions.paymentId': 1 }, { unique: true, sparse: true });
walletSchema.index({ 'transactions.payoutId': 1 }, { sparse: true });
walletSchema.index({ 'transactions.idempotencyKey': 1 }, { sparse: true });

walletSchema.pre('save', function syncLegacyBalance(next) {
  // Keep legacy balance aligned with withdrawable balance for older API consumers.
  if (!Number.isFinite(this.availableBalance)) this.availableBalance = Number(this.balance || 0);
  if (!Number.isFinite(this.pocketBalance)) this.pocketBalance = 0;
  this.balance = Number(this.availableBalance || 0);
  next();
});

walletSchema.methods.updateTotals = function updateTotals() {
  this.totalDeposited = this.transactions
    .filter((t) => t.type === 'deposit' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);

  this.totalWithdrawn = this.transactions
    .filter((t) => t.type === 'withdraw' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);

  this.totalEarned = this.transactions
    .filter((t) => t.type === 'payment' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
};

module.exports = mongoose.model('Wallet', walletSchema);
