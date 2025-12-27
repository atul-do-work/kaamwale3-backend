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
      paymentId: String,
      status: { type: String, default: 'completed' } // completed, pending, failed
    }
  ],
  
  // Metadata
  totalDeposited: { type: Number, default: 0 },
  totalWithdrawn: { type: Number, default: 0 },
  totalEarned: { type: Number, default: 0 }
}, { timestamps: true });

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
