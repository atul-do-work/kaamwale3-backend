const crypto = require("crypto");
const fs = require("fs").promises;

function parseCloudinaryUrl(cloudinaryUrl) {
  if (!cloudinaryUrl || typeof cloudinaryUrl !== "string") return {};
  const trimmed = cloudinaryUrl.trim();
  const match = trimmed.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (!match) return {};
  return {
    apiKey: decodeURIComponent(match[1]),
    apiSecret: decodeURIComponent(match[2]),
    cloudName: decodeURIComponent(match[3]),
  };
}

function getCloudinaryConfig() {
  const parsedFromUrl = parseCloudinaryUrl(process.env.CLOUDINARY_URL || process.env.CLOUDINARY_API_URL);
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || parsedFromUrl.cloudName || "";
  const apiKey = process.env.CLOUDINARY_API_KEY || parsedFromUrl.apiKey || "";
  const apiSecret = process.env.CLOUDINARY_API_SECRET || parsedFromUrl.apiSecret || "";
  return {
    cloudName,
    apiKey,
    apiSecret,
    configured: Boolean(cloudName && apiKey && apiSecret),
  };
}

function signUploadParams(params, apiSecret) {
  const serialized = Object.keys(params)
    .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
  return crypto.createHash("sha1").update(`${serialized}${apiSecret}`).digest("hex");
}

async function uploadImageBufferToCloudinary({
  buffer,
  mimeType = "image/jpeg",
  folder = "kaamwale",
  publicId,
}) {
  const cfg = getCloudinaryConfig();
  if (!cfg.configured) {
    throw new Error("Cloudinary is not configured");
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty image buffer");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder,
    public_id: publicId,
    timestamp,
  };
  const signature = signUploadParams(params, cfg.apiSecret);

  const form = new FormData();
  form.append("file", `data:${mimeType};base64,${buffer.toString("base64")}`);
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  if (folder) form.append("folder", folder);
  if (publicId) form.append("public_id", publicId);

  const endpoint = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`;
  const response = await fetch(endpoint, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload?.secure_url) {
    const reason = payload?.error?.message || "Cloudinary upload failed";
    throw new Error(reason);
  }

  return payload;
}

async function uploadImagePathToCloudinary({
  filePath,
  mimeType = "image/jpeg",
  folder = "kaamwale",
  publicId,
}) {
  const fileBuffer = await fs.readFile(filePath);
  return uploadImageBufferToCloudinary({
    buffer: fileBuffer,
    mimeType,
    folder,
    publicId,
  });
}

async function uploadFileBufferToCloudinary({
  buffer,
  mimeType = "application/octet-stream",
  folder = "kaamwale",
  publicId,
  resourceType = "auto", // auto, image, video, raw
}) {
  const cfg = getCloudinaryConfig();
  if (!cfg.configured) {
    throw new Error("Cloudinary is not configured");
  }

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("Empty file buffer");
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    folder,
    public_id: publicId,
    timestamp,
    resource_type: resourceType,
  };
  const signature = signUploadParams(params, cfg.apiSecret);

  const form = new FormData();
  form.append("file", `data:${mimeType};base64,${buffer.toString("base64")}`);
  form.append("api_key", cfg.apiKey);
  form.append("timestamp", String(timestamp));
  form.append("signature", signature);
  if (folder) form.append("folder", folder);
  if (publicId) form.append("public_id", publicId);
  if (resourceType !== "auto") form.append("resource_type", resourceType);

  const endpoint = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType === "auto" ? "auto" : resourceType}/upload`;
  const response = await fetch(endpoint, { method: "POST", body: form });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || !payload?.secure_url) {
    const reason = payload?.error?.message || "Cloudinary upload failed";
    throw new Error(reason);
  }

  return payload;
}

async function uploadFilePathToCloudinary({
  filePath,
  mimeType = "application/octet-stream",
  folder = "kaamwale",
  publicId,
  resourceType = "auto",
}) {
  const fileBuffer = await fs.readFile(filePath);
  return uploadFileBufferToCloudinary({
    buffer: fileBuffer,
    mimeType,
    folder,
    publicId,
    resourceType,
  });
}

function isCloudinaryAssetUrl(url, cfg = getCloudinaryConfig()) {
  if (!url || typeof url !== "string" || !cfg?.cloudName) return false;

  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "res.cloudinary.com" &&
      parsed.pathname.startsWith(`/${cfg.cloudName}/`)
    );
  } catch (err) {
    return false;
  }
}

async function deleteCloudinaryAsset(publicId, resourceType = "image") {
  const cfg = getCloudinaryConfig();
  if (!cfg.configured || !publicId) {
    return { result: "skipped" };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const params = {
    public_id: publicId,
    timestamp,
  };
  const signature = signUploadParams(params, cfg.apiSecret);

  const body = new URLSearchParams();
  body.set("public_id", publicId);
  body.set("timestamp", String(timestamp));
  body.set("api_key", cfg.apiKey);
  body.set("signature", signature);

  const endpoint = `https://api.cloudinary.com/v1_1/${cfg.cloudName}/${resourceType}/destroy`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const reason = payload?.error?.message || "Cloudinary delete failed";
    throw new Error(reason);
  }

  return payload;
}

module.exports = {
  getCloudinaryConfig,
  signUploadParams,
  isCloudinaryAssetUrl,
  deleteCloudinaryAsset,
  uploadImageBufferToCloudinary,
  uploadImagePathToCloudinary,
  uploadFileBufferToCloudinary,
  uploadFilePathToCloudinary,
};
