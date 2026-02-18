const crypto = require('crypto');
const TermsAuditLog = require('../models/TermsAuditLog');

/**
 * ✅ SECURITY UTILITY: Cryptographically log terms agreement
 * 
 * Called during registration when user submits terms agreement.
 * Creates immutable audit record for compliance.
 */

/**
 * Compute SHA256 hash of terms content
 * Frontend and backend should compute the same hash to verify version
 */
function computeTermsHash(termsContent) {
  return crypto
    .createHash('sha256')
    .update(termsContent)
    .digest('hex');
}

/**
 * Extract user's IP address from request
 * Handles proxies via X-Forwarded-For header
 */
function extractUserIp(req) {
  // Check X-Forwarded-For first (handles proxies, load balancers)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // X-Forwarded-For can contain multiple IPs, take the first one
    return forwarded.split(',')[0].trim();
  }
  // Fall back to direct connection IP
  return req.socket.remoteAddress || req.connection.remoteAddress || 'unknown';
}

/**
 * Log terms agreement cryptographically
 * 
 * @param {Object} req - Express request object
 * @param {Object} userData - { phone, termsVersion, role, appVersion, deviceId, termsHash }
 * @returns {Promise<Object>} - Logged audit record
 */
async function logTermsAgreement(req, userData) {
  const {
    phone,
    termsVersion = '1.0',
    role = 'worker',
    appVersion = 'unknown',
    deviceId = '',
    termsHash = '',
  } = userData;

  if (!phone || !role) {
    throw new Error('❌ [Terms Audit] Missing phone or role');
  }

  try {
    // Extract request context
    const userIpAddress = extractUserIp(req);
    const userAgent = req.headers['user-agent'] || '';

    // ✅ Create immutable audit record
    const auditLog = new TermsAuditLog({
      phone,
      termsVersion,
      agreedAt: new Date(),
      userIpAddress,
      userAgent,
      deviceId,
      appVersion,
      role,
      termsHash,
      acceptedOn: 'registration',
    });

    await auditLog.save();

    console.log(`✅ [Terms Audit] Terms v${termsVersion} agreement logged for ${phone}`);
    console.log(`   IP: ${userIpAddress}`);
    console.log(`   Device: ${deviceId}`);
    console.log(`   App: ${appVersion}`);

    return {
      success: true,
      auditId: auditLog._id,
      message: `Terms agreement recorded at ${auditLog.createdAt}`,
    };
  } catch (err) {
    // ✅ HANDLE: Duplicate terms agreement
    if (err.code === 11000) {
      console.warn(`⚠️ [Terms Audit] User ${phone} already agreed to v${userData.termsVersion}`);
      return {
        success: false,
        message: `You have already agreed to Terms & Conditions v${userData.termsVersion}`,
        isDuplicate: true,
      };
    }

    console.error(`❌ [Terms Audit] Error logging terms agreement:`, err.message);
    throw err;
  }
}

/**
 * Retrieve terms agreement history for a user
 * Used for compliance audits and disputes
 */
async function getTermsHistory(phone) {
  try {
    const history = await TermsAuditLog.find({ phone })
      .sort({ agreedAt: -1 })
      .lean();

    return {
      success: true,
      phone,
      agreementCount: history.length,
      history,
    };
  } catch (err) {
    console.error('❌ [Terms Audit] Error retrieving history:', err.message);
    throw err;
  }
}

/**
 * Verify terms agreement was logged correctly
 * Returns audit trail for legal disputes
 */
async function verifyTermsAgreement(phone, termsVersion) {
  try {
    const record = await TermsAuditLog.findOne({
      phone,
      termsVersion,
    }).lean();

    if (!record) {
      return {
        success: false,
        message: `No agreement found for ${phone} on v${termsVersion}`,
      };
    }

    return {
      success: true,
      phone,
      termsVersion,
      agreedAt: record.agreedAt,
      userIpAddress: record.userIpAddress,
      deviceId: record.deviceId,
      appVersion: record.appVersion,
      role: record.role,
      message: `User agreed on ${record.agreedAt}`,
    };
  } catch (err) {
    console.error('❌ [Terms Audit] Error verifying agreement:', err.message);
    throw err;
  }
}

module.exports = {
  logTermsAgreement,
  getTermsHistory,
  verifyTermsAgreement,
  computeTermsHash,
  extractUserIp,
};
