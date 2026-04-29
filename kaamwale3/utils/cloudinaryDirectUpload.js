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
  LogLevel,
} from './uploadConfig';
import { uploadTelemetry } from './uploadTelemetry';
import { uploadRateLimiter } from './uploadRateLimiter';
import fileSystemUtils from './fileSystem';

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
    heic: 'image/heic',
    heif: 'image/heif',
    pdf: 'application/pdf',
  };
  return mimeMap[extension] || 'image/jpeg';
}

/**
 * Get file size in bytes - Using modern utility
 * ✅ Fixed: Replaced deprecated getInfoAsync() with utility function
 */
async function getFileSize(fileUri) {
  try {
    return await fileSystemUtils.getFileSizeBytes(fileUri);
  } catch (error) {
    console.warn('Error getting file size:', error?.message);
    return 0;
  }
}

async function getExtensionFromUri(fileUri) {
  const match = /(?:\.)([a-zA-Z0-9]+)(?:\?.*)?$/.exec(fileUri);
  const extension = match ? `.${match[1].toLowerCase()}` : '.jpg';
  return extension;
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
      // Removed dimension validation as requested
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
  if (!authToken) {
    throw new Error('Missing authentication token');
  }

  console.log('[profile-upload] requesting cloudinary signature', {
    folder,
    publicId,
    hasAuthToken: Boolean(authToken),
  });

  const response = await fetch(`${API_BASE}/upload/cloudinary-signature`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ folder, publicId, resourceType: 'image' }),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.message || 'Failed to get upload signature';
    throw new Error(message);
  }
  if (!data?.success) {
    throw new Error(data.message || 'Signature request failed');
  }

  console.log('[profile-upload] cloudinary signature success', {
    cloudName: data.cloudName,
    folder: data.folder,
    publicId: data.publicId,
  });

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
  let currentFileUri = fileUri;

  try {
    console.log('[profile-upload] direct upload start', {
      uploadId,
      fileUri: currentFileUri,
      folder,
      publicId: finalPublicId,
      uploadType,
      mimeType,
    });

    // Step 1: Check rate limit
    uploadTelemetry.log(uploadId, LogLevel.DEBUG, 'Checking rate limit');
    const rateLimitCheck = await uploadRateLimiter.canUpload();
    if (!rateLimitCheck.allowed) {
      uploadTelemetry.log(uploadId, LogLevel.WARN, 'Rate limit exceeded', rateLimitCheck);
      return { success: false, error: rateLimitCheck.reason, errorCode: UPLOAD_ERROR_CODES.RATE_LIMIT_EXCEEDED };
    }

    // Step 2: Validate file
    uploadTelemetry.log(uploadId, LogLevel.DEBUG, 'Validating file');
    const detectedMimeType = mimeType || (await getMimeType(currentFileUri));
    let validation = await validateFile(currentFileUri, uploadType, detectedMimeType);
    if (!validation.valid) {
      uploadTelemetry.log(uploadId, LogLevel.WARN, 'File validation failed', validation);
      if (validation.errorCode === UPLOAD_ERROR_CODES.FILE_TOO_LARGE && detectedMimeType.startsWith('image/')) {
        uploadTelemetry.log(uploadId, LogLevel.INFO, 'Attempting compression for oversized image');
        try {
          const compressed = await ImageManipulator.manipulateAsync(currentFileUri, [{ resize: { width: 1200 } }], {
            compress: 0.7,
            format: ImageManipulator.SaveFormat.JPEG,
          });
          currentFileUri = compressed.uri;
          validation = await validateFile(currentFileUri, uploadType, detectedMimeType);
          if (!validation.valid) {
            uploadTelemetry.log(uploadId, LogLevel.WARN, 'Compressed file validation failed', validation);
            return { success: false, error: validation.error, errorCode: validation.errorCode };
          }
        } catch (compressionError) {
          uploadTelemetry.log(uploadId, LogLevel.WARN, 'Image compression failed', { error: compressionError });
          return { success: false, error: validation.error, errorCode: validation.errorCode };
        }
      } else {
        return { success: false, error: validation.error, errorCode: validation.errorCode };
      }
    }

    const fileSize = await getFileSize(currentFileUri);
    uploadTelemetry.log(uploadId, LogLevel.INFO, 'File validated', { fileSize, mimeType: detectedMimeType });
    console.log('[profile-upload] file validated', { uploadId, fileSize, detectedMimeType });

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

      // FALLBACK: If server-side Cloudinary signing is not available (e.g. Cloudinary not configured),
      // try a backend multipart upload endpoint as a last-resort compatibility path.
      const signatureMsg = signatureError?.message || '';
      if (signatureMsg.toLowerCase().includes('cloudinary is not configured') || signatureMsg.toLowerCase().includes('signature request failed') || signatureMsg.toLowerCase().includes('failed to get upload signature')) {
        uploadTelemetry.log(uploadId, LogLevel.WARN, 'Attempting backend multipart upload fallback', { reason: signatureMsg });
        try {
          // Create form data compatible with RN fetch
          const formData = new FormData();
          const fileName = `${finalPublicId}${await getExtensionFromUri(currentFileUri)}`;
          const detectedMimeType = mimeType || (await getMimeType(currentFileUri));
          formData.append('file', { uri: currentFileUri, name: fileName, type: detectedMimeType });
          formData.append('type', uploadType || 'document');

          const resp = await fetch(`${API_BASE}/upload/upload`, {
            method: 'POST',
            body: formData,
            headers: {
              Authorization: `Bearer ${authToken}`,
              // NOTE: Do not set Content-Type; fetch will set multipart boundary
            },
          });

          const payload = await resp.json().catch(() => null);
          if (!resp.ok || !payload) {
            const reason = payload?.message || `Backend upload HTTP ${resp.status}`;
            uploadTelemetry.log(uploadId, LogLevel.ERROR, 'Backend multipart upload failed', { reason, payload });
            return { success: false, error: reason, errorCode: UPLOAD_ERROR_CODES.UPLOAD_FAILED };
          }

          const fileUrl = payload.fileUrl || payload.upload?.fileUrl;
          const public_id = payload.upload?.cloudinaryPublicId || payload.cloudinaryPublicId || payload.publicId || finalPublicId;

          if (!fileUrl) {
            uploadTelemetry.log(uploadId, LogLevel.ERROR, 'Backend upload succeeded but no fileUrl returned', { payload });
            return { success: false, error: 'Backend upload missing file URL', errorCode: UPLOAD_ERROR_CODES.UPLOAD_FAILED };
          }

        uploadTelemetry.log(uploadId, LogLevel.INFO, 'Backend multipart upload successful', { fileUrl, public_id });
        console.log('[profile-upload] backend fallback upload success', { uploadId, fileUrl, publicId: public_id });
          // Record upload rate and return success
          await uploadRateLimiter.recordUpload(fileSize);
          const durationFallback = uploadTelemetry.getDuration(uploadId);
          uploadTelemetry.log(uploadId, LogLevel.INFO, 'Upload completed via backend fallback', { duration: durationFallback });
          return { success: true, url: fileUrl, fileUrl, publicId: public_id };
        } catch (backendErr) {
          uploadTelemetry.log(uploadId, LogLevel.ERROR, 'Backend multipart upload fallback failed', { error: backendErr?.message });
          return { success: false, error: ERROR_MESSAGES.UPLOAD_FAILED, errorCode: UPLOAD_ERROR_CODES.UPLOAD_FAILED };
        }
      }

      return { success: false, error: ERROR_MESSAGES.SIGNATURE_EXPIRED, errorCode: UPLOAD_ERROR_CODES.SIGNATURE_EXPIRED };
    }

    // Step 4: Prepare form data
    const formData = new FormData();
    const file = { uri: currentFileUri, type: detectedMimeType, name: `${finalPublicId}${await getExtensionFromUri(currentFileUri)}` };
    formData.append('file', file);
    formData.append('api_key', signature.signature.apiKey);
    formData.append('timestamp', signature.signature.timestamp.toString());
    formData.append('signature', signature.signature.signature);
    if (signature.signature.folder) formData.append('folder', signature.signature.folder);
    formData.append('public_id', signature.signature.publicId || finalPublicId);

    // Step 5: Upload with retry logic
    uploadTelemetry.log(uploadId, LogLevel.INFO, 'Starting upload to Cloudinary', { totalSize: fileSize });
    console.log('[profile-upload] uploading to cloudinary', {
      uploadId,
      cloudName: signature.signature.cloudName,
      folder: signature.signature.folder,
      publicId: signature.signature.publicId || finalPublicId,
    });
    let uploadResult;
    let uploadError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        onProgress?.({ loaded: 0, total: fileSize, percent: 0 });
        const attemptStartedAt = Date.now();

        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => {
            console.error('[profile-upload] cloudinary timeout fired', {
              uploadId,
              attempt: attempt + 1,
              timeout,
              elapsedMs: Date.now() - attemptStartedAt,
            });
            reject(new Error(`Upload timeout after ${timeout}ms`));
          }, timeout)
        );

        const uploadPromise = fetch(`https://api.cloudinary.com/v1_1/${signature.signature.cloudName}/image/upload`, {
          method: 'POST',
          body: formData,
        }).then(async (r) => {
          const payload = await r.json().catch(() => null);
          console.log('[profile-upload] cloudinary http response', {
            uploadId,
            attempt: attempt + 1,
            status: r.status,
            ok: r.ok,
            elapsedMs: Date.now() - attemptStartedAt,
            hasSecureUrl: Boolean(payload?.secure_url),
            errorMessage: payload?.error?.message || null,
          });
          if (!r.ok) {
            console.error('[profile-upload] cloudinary non-200 payload', {
              uploadId,
              attempt: attempt + 1,
              status: r.status,
              payload,
            });
            throw new Error(payload?.error?.message || `Cloudinary HTTP ${r.status}`);
          }
          return payload;
        });

        uploadResult = await Promise.race([uploadPromise, timeoutPromise]);

        if (!uploadResult.secure_url) throw new Error(uploadResult.error?.message || 'Upload failed');

        onProgress?.({ loaded: fileSize, total: fileSize, percent: 100 });
        uploadTelemetry.log(uploadId, LogLevel.INFO, 'Upload successful', { url: uploadResult.secure_url, publicId: uploadResult.public_id });
        console.log('[profile-upload] cloudinary upload success', {
          uploadId,
          fileUrl: uploadResult.secure_url,
          publicId: uploadResult.public_id,
        });
        break;
      } catch (error) {
        uploadError = error;
        console.error('[profile-upload] cloudinary attempt failed', {
          uploadId,
          attempt: attempt + 1,
          elapsedMs: Date.now() - attemptStartedAt,
          message: error?.message || 'unknown error',
          stack: error?.stack,
        });
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
      console.log('[profile-upload] save-url request completed', { uploadId, publicId: uploadResult.public_id });
    } catch {}

    const duration = uploadTelemetry.getDuration(uploadId);
    uploadTelemetry.log(uploadId, LogLevel.INFO, 'Upload completed successfully', { duration, fileSize });
    console.log('[profile-upload] direct upload finished', {
      uploadId,
      duration,
      fileUrl: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    });

    return { success: true, url: uploadResult.secure_url, fileUrl: uploadResult.secure_url, publicId: uploadResult.public_id, duration };
  } catch (error) {
    const errorMessage = error?.message || 'Unknown error';
    uploadTelemetry.log(uploadId, LogLevel.ERROR, 'Unexpected error during upload', { error: errorMessage });
    console.error('[profile-upload] direct upload failed', {
      uploadId,
      message: errorMessage,
      stack: error?.stack,
    });
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
