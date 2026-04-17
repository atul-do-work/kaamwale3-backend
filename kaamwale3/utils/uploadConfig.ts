/**
 * Upload Configuration & Constants
 * Production-ready upload settings for Cloudinary
 */

// File size limits (in bytes)
export const UPLOAD_LIMITS = {
  PROFILE_PHOTO: 5 * 1024 * 1024, // 5 MB
  VERIFICATION_DOCUMENT: 2 * 1024 * 1024, // 2 MB
  DEFAULT: 5 * 1024 * 1024, // 5 MB
};

// Allowed MIME types
export const ALLOWED_MIME_TYPES = {
  IMAGES: ['image/jpeg', 'image/png', 'image/webp', 'image/jpg'],
  DOCUMENTS: [
    'image/jpeg',
    'image/png',
    'application/pdf',
    'image/jpg',
    'image/webp',
  ],
};

// Upload retry configuration
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  INITIAL_DELAY: 1000, // 1 second
  MAX_DELAY: 10000, // 10 seconds
  BACKOFF_MULTIPLIER: 2, // Exponential backoff
};

// Upload timeout (in milliseconds)
export const UPLOAD_TIMEOUT = 30000; // 30 seconds

// Signature expiry buffer (in seconds)
// Refresh signature if it expires within this buffer
export const SIGNATURE_EXPIRY_BUFFER = 60; // 1 minute before expiry

// Rate limiting configuration
export const RATE_LIMIT_CONFIG = {
  MAX_UPLOADS_PER_MINUTE: 5,
  MAX_UPLOADS_PER_HOUR: 50,
  WINDOW_MINUTE: 60000, // 1 minute in milliseconds
  WINDOW_HOUR: 3600000, // 1 hour in milliseconds
};

// Error codes for better error handling
export const UPLOAD_ERROR_CODES = {
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  INVALID_FILE_TYPE: 'INVALID_FILE_TYPE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  TIMEOUT: 'TIMEOUT',
  SIGNATURE_EXPIRED: 'SIGNATURE_EXPIRED',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  INVALID_DIMENSIONS: 'INVALID_DIMENSIONS',
  USER_CANCELLED: 'USER_CANCELLED',
};

// User-friendly error messages
export const ERROR_MESSAGES: Record<string, string> = {
  FILE_TOO_LARGE: 'File is too large. Please choose a smaller image.',
  INVALID_FILE_TYPE: 'Invalid file type. Only JPEG, PNG, and WebP are allowed.',
  NETWORK_ERROR: 'Network error. Check your connection and try again.',
  TIMEOUT: 'Upload took too long. Please check your connection.',
  SIGNATURE_EXPIRED: 'Security token expired. Please try again.',
  RATE_LIMIT_EXCEEDED: 'Too many uploads. Please wait a moment before trying again.',
  UPLOAD_FAILED: 'Upload failed. Please try again.',
  INVALID_DIMENSIONS: 'Image dimensions are invalid. Please choose another image.',
  USER_CANCELLED: 'Upload cancelled.',
};

// Log levels for telemetry
export enum LogLevel {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
}

// Image validation constraints
export const IMAGE_CONSTRAINTS = {
  MIN_WIDTH: 100,
  MIN_HEIGHT: 100,
  MAX_WIDTH: 4000,
  MAX_HEIGHT: 4000,
};
