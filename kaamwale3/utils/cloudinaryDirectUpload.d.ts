export type CloudinaryUploadProgress = {
  loaded: number;
  total: number;
  percent?: number;
};

export type CloudinaryUploadOptions = {
  onProgress?: (progress: CloudinaryUploadProgress) => void;
  uploadType?: string;
  authToken?: string | null;
  maxRetries?: number;
  timeout?: number;
  mimeType?: string | null;
};

export type CloudinaryUploadResult = {
  success: boolean;
  url?: string;
  fileUrl?: string;
  publicId?: string;
  duration?: number;
  error?: string;
  errorCode?: string;
};

export function uploadToCloudinaryDirect(
  fileUri: string,
  folder?: string,
  publicId?: string | null,
  options?: CloudinaryUploadOptions
): Promise<CloudinaryUploadResult>;

export function getUploadTelemetry(): any;
export function getUploadStats(): Promise<any>;
