/**
 * Production-Ready Cloudinary Direct Upload Utility
 * Features:
 * - File validation (size, type, dimensions)
 * - Progress tracking
 * - Retry logic with exponential backoff
 * - Timeout handling
 * - Better error messages
 * - Telemetry logging
 * - Signature expiry validation
 * - Rate limiting
 */

import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { API_BASE } from '../utils/config';
import {
  UPLOAD_LIMITS,
  ALLOWED_MIME_TYPES,
  RETRY_CONFIG,
  UPLOAD_TIMEOUT,
  SIGNATURE_EXPIRY_BUFFER,
  UPLOAD_ERROR_CODES,
  ERROR_MESSAGES,
  IMAGE_CONSTRAINTS,
  LogLevel,
} from './uploadConfig';
import { uploadTelemetry } from './uploadTelemetry';
import { uploadRateLimiter } from './uploadRateLimiter';

/**
 * @typedef {{ loaded: number; total: number; percent?: number }} CloudinaryUploadProgress
 * @typedef {{
 *   onProgress?: (progress: CloudinaryUploadProgress) => void;
 *   maxRetries?: number;
 *   timeout?: number;
 *   mimeType?: string | null;
 *   authToken?: string | null;
 *   uploadType?: string;
 * }} UploadOptions
 * @typedef {{
 *   success: boolean;
 *   url?: string;
 *   fileUrl?: string;
 *   publicId?: string;
 *   duration?: number;
 *   error?: string;
 *   errorCode?: string;
 * }} UploadResult
 */

/**
 * Get file mime type from URI
 */
async function getMimeType(fileUri) {
  const extension = fileUri.split('.').pop()?.toLowerCase();
  const mimeMap = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    pdf: 'application/pdf',
  };
  return mimeMap[extension] || 'image/jpeg';
}

/**
 * Get file size in bytes
 */
async function getFileSize(fileUri) {
  try {
    const fileInfo = await FileSystem.getInfoAsync(fileUri);
    return fileInfo.size || 0;
  } catch {
    try {
      const base64 = await FileSystem.readAsStringAsync(fileUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return Math.ceil((base64.length * 3) / 4);
    } catch {
      return 0;
    }
  }
}

/**
 * Get image dimensions
 */
async function getImageDimensions(fileUri) {
  try {
    const result = await ImageManipulator.manipulateAsync(fileUri, [], {
      compress: 1,
      format: 'jpeg',
    });
    return { width: result.width, height: result.height };
  } catch (error) {
    uploadTelemetry.log('validation', LogLevel.WARN, 'Failed to get image dimensions', { error });
    return { width: 0, height: 0 };
  }
}

/**
 * Validate file before upload
 */
async function validateFile(fileUri, uploadType = 'other', mimeType = null) {
  try {
    const fileSize = await getFileSize(fileUri);
    let maxSize = UPLOAD_LIMITS.DEFAULT;
    let allowedTypes = ALLOWED_MIME_TYPES.IMAGES;

    if (uploadType === 'profile') {
      maxSize = UPLOAD_LIMITS.PROFILE_PHOTO;
      allowedTypes = ALLOWED_MIME_TYPES.IMAGES;
    } else if (uploadType === 'verification') {
      maxSize = UPLOAD_LIMITS.VERIFICATION_DOCUMENT;
      allowedTypes = ALLOWED_MIME_TYPES.DOCUMENTS;
    }

    if (fileSize > maxSize) {
      return { valid: false, error: ERROR_MESSAGES.FILE_TOO_LARGE, errorCode: UPLOAD_ERROR_CODES.FILE_TOO_LARGE };
    }

    const detectedMimeType = mimeType || (await getMimeType(fileUri));
    if (!allowedTypes.includes(detectedMimeType)) {
      return { valid: false, error: ERROR_MESSAGES.INVALID_FILE_TYPE, errorCode: UPLOAD_ERROR_CODES.INVALID_FILE_TYPE };
    }

    if (detectedMimeType.startsWith('image/')) {
      const { width, height } = await getImageDimensions(fileUri);
      if (width < IMAGE_CONSTRAINTS.MIN_WIDTH || height < IMAGE_CONSTRAINTS.MIN_HEIGHT) {
        return { valid: false, error: ERROR_MESSAGES.INVALID_DIMENSIONS, errorCode: UPLOAD_ERROR_CODES.INVALID_DIMENSIONS };
      }
      if (width > IMAGE_CONSTRAINTS.MAX_WIDTH || height > IMAGE_CONSTRAINTS.MAX_HEIGHT) {
        return { valid: false, error: ERROR_MESSAGES.INVALID_DIMENSIONS, errorCode: UPLOAD_ERROR_CODES.INVALID_DIMENSIONS };
      }
    }

    return { valid: true };
  } catch (error) {
    uploadTelemetry.log('validation', LogLevel.ERROR, 'Validation error', { error });
    return { valid: false, error: 'Validation failed' };
  }
}

/**
 * Get upload signature from backend
 */
/**
 * @param {string | null | undefined} authToken
 * @param {string} folder
 * @param {string} publicId
 */
async function getUploadSignature(authToken, folder, publicId) {
  const response = await fetch(`${API_BASE}/upload/cloudinary-signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ folder, publicId, resourceType: 'image' }),
  });

  if (!response.ok) throw new Error('Failed to get upload signature');
  const data = await response.json();
  if (!data.success) throw new Error(data.message || 'Signature request failed');

  return { signature: data, expiresAt: Date.now() + (data.signatureExpiry || 3600) * 1000 };
}

/**
 * Exponential backoff delay
 */
function getBackoffDelay(attemptNumber) {
  const delay = Math.min(
    RETRY_CONFIG.INITIAL_DELAY * Math.pow(RETRY_CONFIG.BACKOFF_MULTIPLIER, attemptNumber),
    RETRY_CONFIG.MAX_DELAY
  );
  return delay + Math.random() * 1000;
}

/**
 * Main upload function with all production features
 */
/**
 * @param {string} fileUri
 * @param {string} [folder]
 * @param {string | null} [publicId]
 * @param {UploadOptions} [options]
 * @returns {Promise<UploadResult>}
 */
export async function uploadToCloudinaryDirect(fileUri, folder = 'kaamwale/uploads/images', publicId = null, options = {}) {
  const uploadId = `upload-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  uploadTelemetry.recordStart(uploadId);
  uploadTelemetry.log(uploadId, LogLevel.INFO, 'Upload started', { fileUri, folder, publicId });

  const {
    onProgress = null,
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    timeout = UPLOAD_TIMEOUT,
    mimeType = null,
    authToken = null,
    uploadType = 'other',
  } = options;

  const finalPublicId = publicId || `upload-${Date.now()}`;

  try {
    // Step 1: Check rate limit
    uploadTelemetry.log(uploadId, LogLevel.DEBUG, 'Checking rate limit');
    const rateLimitCheck = await uploadRateLimiter.canUpload();
    if (!rateLimitCheck.allowed) {
      uploadTelemetry.log(uploadId, LogLevel.WARN, 'Rate limit exceeded', rateLimitCheck);
      return { success: false, error: rateLimitCheck.reason, errorCode: UPLOAD_ERROR_CODES.RATE_LIMIT_EXCEEDED };
    }

    // Step 2: Validate file
    uploadTelemetry.log(uploadId, LogLevel.DEBUG, 'Validating file');
    const validation = await validateFile(fileUri, uploadType, mimeType);
    if (!validation.valid) {
      uploadTelemetry.log(uploadId, LogLevel.WARN, 'File validation failed', validation);
      return { success: false, error: validation.error, errorCode: validation.errorCode };
    }

    const fileSize = await getFileSize(fileUri);
    const detectedMimeType = mimeType || (await getMimeType(fileUri));
    uploadTelemetry.log(uploadId, LogLevel.INFO, 'File validated', { fileSize, mimeType: detectedMimeType });

    // Step 3: Get signature from backend with retry
    uploadTelemetry.log(uploadId, LogLevel.DEBUG, 'Requesting upload signature');
    let signature;
    let signatureError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        signature = await getUploadSignature(authToken, folder, finalPublicId);
        uploadTelemetry.log(uploadId, LogLevel.INFO, 'Signature obtained', { expiresAt: signature.expiresAt });
        break;
      } catch (error) {
        signatureError = error;
        uploadTelemetry.log(uploadId, LogLevel.WARN, `Signature request failed (attempt ${attempt + 1}/${maxRetries + 1})`, { error: error.message });
        if (attempt < maxRetries) {
          const delay = getBackoffDelay(attempt);
          uploadTelemetry.log(uploadId, LogLevel.DEBUG, `Retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (!signature) {
      uploadTelemetry.log(uploadId, LogLevel.ERROR, 'Failed to get signature after retries');
      return { success: false, error: ERROR_MESSAGES.SIGNATURE_EXPIRED, errorCode: UPLOAD_ERROR_CODES.SIGNATURE_EXPIRED };
    }

    // Step 4: Prepare form data
    const formData = new FormData();
    const file = { uri: fileUri, type: detectedMimeType, name: finalPublicId };
    formData.append('file', file);
    formData.append('api_key', signature.signature.apiKey);
    formData.append('timestamp', signature.signature.timestamp.toString());
    formData.append('signature', signature.signature.signature);
    if (signature.signature.folder) formData.append('folder', signature.signature.folder);
    if (signature.signature.publicId) formData.append('public_id', signature.signature.publicId);

    // Step 5: Upload with retry logic
    uploadTelemetry.log(uploadId, LogLevel.INFO, 'Starting upload to Cloudinary', { totalSize: fileSize });
    let uploadResult;
    let uploadError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        onProgress?.({ loaded: 0, total: fileSize, percent: 0 });

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Upload timeout after ${timeout}ms`)), timeout)
        );

        const uploadPromise = fetch(`https://api.cloudinary.com/v1_1/${signature.signature.cloudName}/image/upload`, {
          method: 'POST',
          body: formData,
        }).then((r) => r.json());

        uploadResult = await Promise.race([uploadPromise, timeoutPromise]);

        if (!uploadResult.secure_url) throw new Error(uploadResult.error?.message || 'Upload failed');

        onProgress?.({ loaded: fileSize, total: fileSize, percent: 100 });
        uploadTelemetry.log(uploadId, LogLevel.INFO, 'Upload successful', { url: uploadResult.secure_url, publicId: uploadResult.public_id });
        break;
      } catch (error) {
        uploadError = error;
        uploadTelemetry.log(uploadId, LogLevel.WARN, `Upload failed (attempt ${attempt + 1}/${maxRetries + 1})`, { error: error.message });
        if (attempt < maxRetries) {
          const delay = getBackoffDelay(attempt);
          uploadTelemetry.log(uploadId, LogLevel.DEBUG, `Retrying in ${delay}ms`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    if (!uploadResult) {
      const errorMessage = uploadError?.message || 'Upload failed';
      let errorCode = UPLOAD_ERROR_CODES.UPLOAD_FAILED;
      if (errorMessage.includes('timeout')) errorCode = UPLOAD_ERROR_CODES.TIMEOUT;
      else if (errorMessage.includes('network')) errorCode = UPLOAD_ERROR_CODES.NETWORK_ERROR;

      uploadTelemetry.log(uploadId, LogLevel.ERROR, 'Upload failed after all retries', { error: errorMessage });
      return { success: false, error: ERROR_MESSAGES[errorCode] || errorMessage, errorCode };
    }

    // Step 6: Record upload attempt
    await uploadRateLimiter.recordUpload(fileSize);

    // Step 7: Optionally save URL to backend
    try {
      await fetch(`${API_BASE}/upload/save-url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ fileUrl: uploadResult.secure_url, cloudinaryPublicId: uploadResult.public_id, type: uploadType }),
      }).catch(() => uploadTelemetry.log(uploadId, LogLevel.WARN, 'URL save endpoint not available'));
    } catch {}

    const duration = uploadTelemetry.getDuration(uploadId);
    uploadTelemetry.log(uploadId, LogLevel.INFO, 'Upload completed successfully', { duration, fileSize });

    return { success: true, url: uploadResult.secure_url, fileUrl: uploadResult.secure_url, publicId: uploadResult.public_id, duration };
  } catch (error) {
    const errorMessage = error?.message || 'Unknown error';
    uploadTelemetry.log(uploadId, LogLevel.ERROR, 'Unexpected error during upload', { error: errorMessage });
    return { success: false, error: ERROR_MESSAGES.UPLOAD_FAILED, errorCode: UPLOAD_ERROR_CODES.UPLOAD_FAILED };
  }
}

/**
 * Get upload telemetry for debugging
 */
export function getUploadTelemetry() {
  return uploadTelemetry;
}

/**
 * Get upload rate limiter stats
 */
export async function getUploadStats() {
  return uploadRateLimiter.getStats();
}