const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  accountHolderName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  accountNumberConfirm: { type: String, required: true },
  ifscCode: { type: String, required: true },
  bankName: { type: String, required: true },
  accountType: { type: String, enum: ['savings', 'current'], default: 'savings' },

  isVerified: { type: Boolean, default: false },
  verificationStatus: {
    type: String,
    enum: ['pending', 'verified', 'rejected'],
    default: 'pending'
  },
  verificationTime: Date,
  rejectionReason: String,

  maskedAccount: String
}, { timestamps: true });

/**
 * ✅ Pre-save hook (Mongoose v7+ safe)
 * - No next()
 * - Throw errors to block save
 */
bankAccountSchema.pre('save', function () {
  console.log('💳 BankAccount pre-save hook triggered');

  // Mask account number
  if (this.accountNumber) {
    const last4 = this.accountNumber.slice(-4);
    this.maskedAccount = '*'.repeat(this.accountNumber.length - 4) + last4;
    console.log(`✅ Account masked: ${this.maskedAccount}`);
  }

  // Validate match
  if (this.accountNumber !== this.accountNumberConfirm) {
    console.error('❌ Account numbers do not match');
    throw new Error('Account numbers do not match');
  }

  console.log(`✅ All validations passed for account: ${this.maskedAccount}`);
});

module.exports = mongoose.model('BankAccount', bankAccountSchema);
