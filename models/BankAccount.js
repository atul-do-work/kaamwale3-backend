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

// ✅ Mask account number before saving
bankAccountSchema.pre('save', async function(next) {
  try {
    if (this.accountNumber) {
      const last4 = this.accountNumber.slice(-4);
      this.maskedAccount = '*'.repeat(this.accountNumber.length - 4) + last4;
    }
    
    // Validate account numbers match
    if (this.accountNumber !== this.accountNumberConfirm) {
      throw new Error('Account numbers do not match');
    }
    
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('BankAccount', bankAccountSchema);
