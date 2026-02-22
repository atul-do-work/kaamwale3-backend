const mongoose = require('mongoose');
const crypto = require('crypto');

function getEncKey() {
  const secret = process.env.BANK_ACCOUNT_ENCRYPTION_KEY || '';
  if (!secret || secret.length < 32) {
    throw new Error('BANK_ACCOUNT_ENCRYPTION_KEY must be set (min 32 chars)');
  }
  // Normalize to 32 bytes for AES-256
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptValue(plainText) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', getEncKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptValue(payload) {
  if (!payload || typeof payload !== 'string' || !payload.includes(':')) return '';
  const [ivHex, encryptedHex] = payload.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', getEncKey(), iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

const bankAccountSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  accountHolderName: { type: String, required: true },
  // Legacy plaintext storage (disabled):
  // accountNumber: { type: String, required: true },
  // accountNumberConfirm: { type: String, required: true },
  accountNumberEncrypted: { type: String, required: true },
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

  // Mask account number from encrypted payload
  const plainAccount = this.accountNumberDecrypted || decryptValue(this.accountNumberEncrypted);
  if (plainAccount) {
    const last4 = plainAccount.slice(-4);
    this.maskedAccount = '*'.repeat(plainAccount.length - 4) + last4;
    console.log(`✅ Account masked: ${this.maskedAccount}`);
  }

  console.log(`✅ All validations passed for account: ${this.maskedAccount}`);
});

// Virtual setter for plaintext account number (only at runtime, never persisted plaintext)
bankAccountSchema.virtual('accountNumberDecrypted')
  .get(function () {
    try {
      return decryptValue(this.accountNumberEncrypted);
    } catch (e) {
      return '';
    }
  })
  .set(function (value) {
    this.accountNumberEncrypted = encryptValue(value);
  });

module.exports = mongoose.model('BankAccount', bankAccountSchema);
