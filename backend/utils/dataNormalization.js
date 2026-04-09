// utils/dataNormalization.js

/**
 * Normalizes phone numbers to a consistent format
 * @param {string|number} phone - Phone number to normalize
 * @returns {string} Normalized phone number (10 digits only)
 */
function normalizePhoneNumber(phone) {
  if (!phone) return '';

  // Convert to string and remove all non-digits
  const cleaned = String(phone).replace(/\D/g, '');

  // Return last 10 digits (handles international formats)
  return cleaned.slice(-10);
}

/**
 * Validates if a phone number is in correct format
 * @param {string|number} phone - Phone number to validate
 * @returns {boolean} True if valid
 */
function isValidPhoneNumber(phone) {
  const normalized = normalizePhoneNumber(phone);
  return normalized.length === 10 && /^\d{10}$/.test(normalized);
}

/**
 * Normalizes monetary amounts to 2 decimal places
 * @param {number|string} amount - Amount to normalize
 * @returns {number} Normalized amount
 */
function normalizeAmount(amount) {
  const num = Number(amount) || 0;
  return Math.round(num * 100) / 100; // Round to 2 decimal places
}

/**
 * Normalizes coordinates to valid lat/lng format
 * @param {number} lat - Latitude
 * @param {number} lng - Longitude
 * @returns {Object} Normalized coordinates or null if invalid
 */
function normalizeCoordinates(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);

  if (isNaN(latNum) || isNaN(lngNum)) return null;
  if (latNum < -90 || latNum > 90) return null;
  if (lngNum < -180 || lngNum > 180) return null;

  return { lat: latNum, lng: lngNum };
}

/**
 * Sanitizes string input for database storage
 * @param {string} input - Input string
 * @param {number} maxLength - Maximum length
 * @returns {string} Sanitized string
 */
function sanitizeString(input, maxLength = 1000) {
  if (!input) return '';

  return String(input)
    .trim()
    .replace(/[<>\"'&]/g, '') // Remove potentially dangerous characters
    .substring(0, maxLength);
}

module.exports = {
  normalizePhoneNumber,
  isValidPhoneNumber,
  normalizeAmount,
  normalizeCoordinates,
  sanitizeString,
};