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
  
  maskedAccount: String,
  
  addedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// ✅ PRODUCTION-READY: Single pre-save hook with proper async/await and error handling
bankAccountSchema.pre('save', function(next) {
  console.log('💳 BankAccount pre-save hook triggered');
  
  try {
    // Mask account number
    if (this.accountNumber) {
      const last4 = this.accountNumber.slice(-4);
      this.maskedAccount = '*'.repeat(this.accountNumber.length - 4) + last4;
      console.log(`✅ Account masked: ${this.maskedAccount}`);
    }
    
    // Validate account numbers match
    if (this.accountNumber !== this.accountNumberConfirm) {
      const err = new Error('Account numbers do not match');
      console.error('❌ Validation error:', err.message);
      return next(err);
    }
    
    console.log(`✅ All validations passed for account: ${this.maskedAccount}`);
    next();
  } catch (error) {
    console.error('❌ Pre-save hook error:', error.message);
    next(error);
  }
});

module.exports = mongoose.model('BankAccount', bankAccountSchema);
