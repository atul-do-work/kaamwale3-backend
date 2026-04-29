/**
 * Modern Expo File System Utilities
 * 
 * Handles file operations using modern expo-file-system API
 * Provides fallbacks for compatibility
 */

import * as FileSystem from 'expo-file-system/legacy';

/**
 * ✅ Fixed: Get file information with modern API
 * Handles both iOS and Android properly
 */
export async function getFileInfo(fileUri: string) {
  try {
    // Modern API - works with both old and new versions
    const info = await FileSystem.getInfoAsync(fileUri);
    
    if (!info) {
      throw new Error('File info is null');
    }

    return {
      exists: info.exists === true,
      isDirectory: (info as any).isDirectory === true,
      size: typeof (info as any).size === 'number' ? (info as any).size : 0,
      modificationTime: (info as any).modificationTime,
      uri: info.uri,
    };
  } catch (error) {
    const err = error as Error;
    console.error('Error getting file info:', err?.message);
    throw new Error(`Failed to read file: ${err?.message}`);
  }
}

/**
 * ✅ Fixed: Safely get file size
 * Returns 0 on any error instead of throwing
 */
export async function getFileSizeBytes(fileUri: string): Promise<number> {
  try {
    const info = await getFileInfo(fileUri);
    return info.size;
  } catch (error) {
    const err = error as Error;
    console.warn(`Failed to get file size for ${fileUri}:`, err?.message);
    return 0;
  }
}

/**
 * ✅ Fixed: Check if file exists
 */
export async function fileExists(fileUri: string): Promise<boolean> {
  try {
    const info = await getFileInfo(fileUri);
    return info.exists;
  } catch {
    return false;
  }
}

/**
 * ✅ Fixed: Read file as binary (for FormData)
 * Works with local file URIs and cached files
 */
export async function readFileAsBlob(
  fileUri: string,
  mimeType: string = 'application/octet-stream'
) {
  try {
    // For React Native, we typically work with URI directly in FormData
    // But if needed, we can read as base64
    const exists = await fileExists(fileUri);
    if (!exists) {
      throw new Error('File does not exist');
    }

    // Return the URI which FormData will handle
    // Modern fetch API in React Native handles file:// URIs in FormData
    return {
      uri: fileUri,
      type: mimeType,
      name: fileUri.split('/').pop() || 'file',
    };
  } catch (error) {
    const err = error as Error;
    console.error('Error reading file as blob:', err?.message);
    throw error;
  }
}

/**
 * ✅ Fixed: Read file as base64 (for direct API uploads)
 * Use only if absolutely necessary (slower for large files)
 */
export async function readFileAsBase64(fileUri: string): Promise<string> {
  try {
    // Use proper encoding constant
    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: 'base64' as any, // Cast to any to handle version differences
    });
    return base64;
  } catch (error) {
    const err = error as Error;
    console.error('Error reading file as base64:', err?.message);
    throw new Error(`Failed to read file: ${err?.message}`);
  }
}

/**
 * ✅ Fixed: Delete file safely
 */
export async function deleteFile(fileUri: string): Promise<boolean> {
  try {
    await FileSystem.deleteAsync(fileUri, { idempotent: true });
    return true;
  } catch (error) {
    const err = error as Error;
    console.warn(`Failed to delete file ${fileUri}:`, err?.message);
    return false;
  }
}

/**
 * ✅ Fixed: Copy file to temp location
 * Useful if original file might be deleted
 */
export async function copyFileToTemp(fileUri: string, fileName: string): Promise<string> {
  try {
    // Use proper cache directory constant
    const tempDir = (FileSystem as any).cacheDirectory || (FileSystem as any).documentDirectory;
    if (!tempDir) {
      throw new Error('Cache directory not available');
    }

    const destUri = `${tempDir}${fileName}`;
    await FileSystem.copyAsync({
      from: fileUri,
      to: destUri,
    });

    return destUri;
  } catch (error) {
    const err = error as Error;
    console.error('Error copying file to temp:', err?.message);
    throw error;
  }
}

/**
 * ✅ Fixed: Validate file for upload
 */
export async function validateFileForUpload(
  fileUri: string,
  maxSizeBytes: number = 4 * 1024 * 1024
) {
  try {
    const info = await getFileInfo(fileUri);

    if (!info.exists) {
      return { valid: false, error: 'File does not exist' };
    }

    if (info.isDirectory) {
      return { valid: false, error: 'Path is a directory, not a file' };
    }

    if (info.size === 0) {
      return { valid: false, error: 'File is empty' };
    }

    if (info.size > maxSizeBytes) {
      return {
        valid: false,
        error: `File too large: ${(info.size / 1024 / 1024).toFixed(2)}MB (max: ${(maxSizeBytes / 1024 / 1024).toFixed(2)}MB)`,
      };
    }

    return { valid: true, size: info.size };
  } catch (error) {
    const err = error as Error;
    return { valid: false, error: err?.message || 'File validation failed' };
  }
}

export default {
  getFileInfo,
  getFileSizeBytes,
  fileExists,
  readFileAsBlob,
  readFileAsBase64,
  deleteFile,
  copyFileToTemp,
  validateFileForUpload,
};
