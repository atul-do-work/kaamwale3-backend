const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  balance: { type: Number, default: 0 },
  
  // Bank account reference
  bankAccountId: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
  
  transactions: [
    {
      type: { type: String, enum: ['deposit', 'withdraw', 'payment', 'job_post_fee', 'refund', 'premium_subscription'] },
      amount: Number,
      date: { type: Date, default: Date.now },
      description: String,
      orderId: String, // For deposit/withdraw tracking
      paymentId: { type: String}, // 🔐 Unique index prevents duplicate payments globally
      status: { type: String, default: 'completed' }, // completed, pending, failed
      // Immutable audit fields for forensic accounting
      openingBalance: { type: Number, immutable: true },
      closingBalance: { type: Number, immutable: true },
      source: { type: String, immutable: true }, // app, webhook, admin, reconciliation
      provider: { type: String, immutable: true }, // razorpay, internal
      providerEventId: { type: String, immutable: true }, // webhook/payment/payout id
      metadata: { type: mongoose.Schema.Types.Mixed, default: null }
    }
  ],
  
  // MetadatapaymentId: { type: String, index: true }

  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 }
}, { timestamps: true });

// 🔐 Fintech Security Indexes
// This index prevents duplicate payments globally (unique + sparse = safe for null values)
// Works in conjunction with atomic MongoDB $ne condition in deposit/verify endpoint
walletSchema.index({ 'transactions.paymentId': 1 }, { unique: true, sparse: true });

// Auto-calculate totals
walletSchema.methods.updateTotals = function() {
  this.totalDeposited = this.transactions
    .filter(t => t.type === 'deposit' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
  
  this.totalWithdrawn = this.transactions
    .filter(t => t.type === 'withdraw' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
    
  this.totalEarned = this.transactions
    .filter(t => t.type === 'payment' && t.status === 'completed')
    .reduce((sum, t) => sum + t.amount, 0);
};

module.exports = mongoose.model('Wallet', walletSchema);
