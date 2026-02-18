const mongoose = require('mongoose');

/**
 * ✅ SECURITY: Terms & Conditions Audit Trail
 * 
 * Stores immutable cryptographic records of when users agreed to terms.
 * Used for legal compliance and dispute resolution.
 * 
 * Fields:
 * - phone: User's phone number (unique per terms version)
 * - termsVersion: Version of T&C the user agreed to (e.g., "1.0")
 * - agreeAt: ISO timestamp when user clicked "agree"
 * - userIpAddress: User's IP address (from X-Forwarded-For or remoteAddress)
 * - userAgent: User's browser/device info (from request headers)
 * - deviceId: Unique device identifier (from frontend)
 * - appVersion: App version when user agreed (from frontend)
 * - termsHash: SHA256 hash of terms content (frontend computes, backend verifies)
 * - role: User's role when agreeing (worker or contractor)
 * 
 * Indexes:
 * - compound unique (phone, termsVersion) - prevent resubmission of same terms
 * - phone for lookup
 * - agreeAt for audit trail
 */

const termsAuditLogSchema = new mongoose.Schema({
  // Immutable user identity
  phone: { 
    type: String, 
    required: true,
    index: true,
  },
  
  // Terms version (e.g., "1.0", "1.1", "2.0")
  termsVersion: { 
    type: String, 
    required: true,
  },
  
  // Timestamp when user agreed
  agreedAt: { 
    type: Date, 
    required: true,
    default: () => new Date(),
    index: true,
  },
  
  // Network & Device Information
  userIpAddress: { 
    type: String, 
    required: true,  // Backend extracts from X-Forwarded-For or socket.remoteAddress
  },
  userAgent: { 
    type: String, 
    default: '',  // Full HTTP User-Agent string
  },
  deviceId: { 
    type: String, 
    default: '',  // Frontend-generated unique device identifier
  },
  
  // App Context
  appVersion: { 
    type: String, 
    default: '',  // e.g., "1.0.5", "1.1.0"
  },
  role: {
    type: String,
    enum: ['worker', 'contractor'],
    required: true,
  },
  
  // Cryptographic Verification
  termsHash: { 
    type: String, 
    default: '',  // SHA256 hash of terms content (for version verification)
  },
  
  // Additional context
  acceptedOn: {
    type: String,
    default: '',  // e.g., "registration", "terms-update"
  },
  
}, {
  timestamps: true,  // Add createdAt, updatedAt
  strict: true,      // Reject unknown fields
});

// ✅ COMPOUND UNIQUE INDEX: Prevent duplicate terms agreement for same version
// Allows same user to agree to NEW versions (e.g., 1.0 → 1.1)
// But prevents re-submission of same version
termsAuditLogSchema.index(
  { phone: 1, termsVersion: 1 },
  { 
    unique: true,
    sparse: false,
  }
);

// ✅ QUERY INDEX: Fast audit trail lookup
termsAuditLogSchema.index({ phone: 1, agreedAt: -1 });

module.exports = mongoose.model('TermsAuditLog', termsAuditLogSchema);
