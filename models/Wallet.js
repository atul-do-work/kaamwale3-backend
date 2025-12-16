const mongoose = require('mongoose');

const walletSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  balance: { type: Number, default: 0 },
  transactions: [
    {
      type: { type: String, enum: ['deposit', 'withdraw', 'payment', 'job_post_fee', 'refund', 'premium_subscription'] }, // ✅ All transaction types
      amount: Number,
      date: { type: Date, default: Date.now },
    }
  ],
}, { timestamps: true });

module.exports = mongoose.model('Wallet', walletSchema);
