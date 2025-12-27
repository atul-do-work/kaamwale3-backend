const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  accountHolderName: { type: String, required: true },
  accountNumber: { type: String, required: true },
  accountNumberConfirm: { type: String, required: true }, // User re-enters for verification
  ifscCode: { type: String, required: true },
  bankName: { type: String, required: true },
  accountType: { type: String, enum: ['savings', 'current'], default: 'savings' },
  
  // Verification status
  isVerified: { type: Boolean, default: false },
  verificationStatus: {
    type: String,
    enum: ['pending', 'verified', 'rejected'],
    default: 'pending'
  },
  verificationTime: Date,
  rejectionReason: String,
  
  // For security - masked view
  maskedAccount: String, // e.g., "****5678"
  
  // Metadata
  addedAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { timestamps: true });

// Mask account number before saving
bankAccountSchema.pre('save', function(next) {
  if (this.accountNumber) {
    const last4 = this.accountNumber.slice(-4);
    this.maskedAccount = '*'.repeat(this.accountNumber.length - 4) + last4;
  }
  next();
});

// Validate account number matches confirm
bankAccountSchema.pre('save', function(next) {
  if (this.accountNumber !== this.accountNumberConfirm) {
    throw new Error('Account numbers do not match');
  }
  next();
});

module.exports = mongoose.model('BankAccount', bankAccountSchema);
