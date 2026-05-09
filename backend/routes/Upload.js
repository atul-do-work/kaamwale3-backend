const express = require("express");
const router = express.Router();
const multer = require("multer");
const Upload = require("../models/Upload");
const User = require("../models/User");
const { authenticateToken } = require("../utils/auth");
const { uploadFileBufferToCloudinary, signUploadParams, getCloudinaryConfig } = require("../utils/cloudinaryUpload");

// Configure multer for file uploads in memory only
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10 MB limit
  },
});

router.post("/cloudinary-signature", authenticateToken, async (req, res) => {
  try {
    const { folder, publicId, resourceType = "image" } = req.body || {};
    const cfg = getCloudinaryConfig();
    if (!cfg.configured) {
      return res.status(500).json({ success: false, message: "Cloudinary is not configured" });
    }

    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = {
      timestamp,
      ...(folder ? { folder } : {}),
      ...(publicId ? { public_id: publicId } : {}),
    };
    const signature = signUploadParams(paramsToSign, cfg.apiSecret);

    return res.json({
      success: true,
      cloudName: cfg.cloudName,
      apiKey: cfg.apiKey,
      timestamp,
      signature,
      folder,
      publicId,
      resourceType,
    });
  } catch (err) {
    console.error("Cloudinary signature error", err);
    return res.status(500).json({ success: false, message: "Failed to generate Cloudinary upload signature" });
  }
});

// Save uploaded file URL to database (for tracking after direct Cloudinary upload)
router.post("/save-url", authenticateToken, async (req, res) => {
  try {
    const { fileUrl, cloudinaryPublicId, type = "document" } = req.body;
    const normalizedType = type === "profile" ? "profilePhoto" : type;

    if (!fileUrl) {
      return res.status(400).json({ success: false, message: "fileUrl is required" });
    }

    const user = await User.findOne({ phone: req.user.phone });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const newUpload = new Upload({
      userId: user._id,
      type: normalizedType,
      fileName: cloudinaryPublicId || `uploaded-${Date.now()}`,
      fileUrl,
      cloudinaryPublicId,
    });

    await newUpload.save();

    // If it's a profile photo, also update User
    if (normalizedType === "profilePhoto") {
      user.profilePhoto = fileUrl;
      await user.save();
    }

    return res.json({ success: true, upload: newUpload });
  } catch (err) {
    console.error("Save URL error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Upload a file (profile photo or document) to Cloudinary
router.post("/upload", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: "No file uploaded" });

    const user = await User.findOne({ phone: req.user.phone });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const mimeType = req.file.mimetype || "application/octet-stream";
    const isImage = mimeType.startsWith("image/");
    const resourceType = isImage ? "image" : "raw";
    const type = (req.body && req.body.type) || "document";
    const normalizedType = type === "profile" ? "profilePhoto" : type;
    const folder = normalizedType === "profilePhoto"
      ? "kaamwale/profiles"
      : isImage
      ? "kaamwale/uploads/images"
      : "kaamwale/uploads/documents";
    const publicId = normalizedType === "profilePhoto"
      ? `profile-${req.user.phone}-${Date.now()}`
      : `${req.user.phone}-${Date.now()}-${req.file.originalname}`;

    // 🔐 EDGE CASE: Upload failure mid-way
    // Create a placeholder upload record BEFORE Cloudinary upload
    // This allows retry detection and prevents duplicate uploads on client timeout
    const uploadRecord = new Upload({
      userId: user._id,
      type: normalizedType,
      fileName: req.file.originalname,
      fileUrl: null,
      cloudinaryPublicId: publicId,
      status: "uploading", // Track upload state
      uploadedAt: new Date(),
    });
    await uploadRecord.save();

    let uploadResult;
    try {
      uploadResult = await uploadFileBufferToCloudinary({
        buffer: req.file.buffer,
        mimeType,
        folder,
        publicId,
        resourceType,
      });
    } catch (cloudinaryErr) {
      // Mark upload as failed but keep the record for audit/retry
      uploadRecord.status = "failed";
      uploadRecord.failureReason = cloudinaryErr?.message || String(cloudinaryErr);
      await uploadRecord.save();
      
      console.error("Cloudinary upload failed for record:", uploadRecord._id, cloudinaryErr);
      return res.status(500).json({ 
        success: false, 
        message: "File upload to Cloudinary failed. Please retry.",
        uploadId: uploadRecord._id, // Allow client to retry with this ID
        retryable: true,
      });
    }

    const fileUrl = uploadResult.secure_url;

    // 🔐 Update upload record with successful Cloudinary URL
    uploadRecord.fileUrl = fileUrl;
    uploadRecord.cloudinaryPublicId = uploadResult.public_id;
    uploadRecord.status = "completed";
    uploadRecord.completedAt = new Date();
    await uploadRecord.save();

    // Update user profile with new photo URL (non-blocking)
    if (normalizedType === "profilePhoto") {
      try {
        user.profilePhoto = fileUrl;
        user.profilePhotoPublicId = uploadResult.public_id || "";
        await user.save();
      } catch (userUpdateErr) {
        // If user update fails, upload is still tracked and can be referenced
        console.error("Failed to update user profile photo link:", userUpdateErr);
        // Don't fail the response - the upload itself succeeded
        // Client can retry user update separately
      }
    }

    return res.json({
      success: true,
      fileUrl,
      profilePhoto: normalizedType === "profilePhoto" ? fileUrl : undefined,
      cloudinaryPublicId: uploadResult.public_id,
      upload: uploadRecord,
      uploadId: uploadRecord._id, // Return ID for future reference/retry
    });
  } catch (err) {
    console.error("Upload error", err);
    return res.status(500).json({ 
      success: false, 
      message: "Upload failed. Please try again.",
      error: err?.message,
      retryable: true,
    });
  }
});

// 🔐 RETRY ENDPOINT: Check upload status and resume if needed
// Allows client to detect if previous upload succeeded/failed after network timeout
router.get("/upload-status/:uploadId", authenticateToken, async (req, res) => {
  try {
    const { uploadId } = req.params;
    const upload = await Upload.findById(uploadId);

    if (!upload) {
      return res.status(404).json({ success: false, message: "Upload record not found" });
    }

    // Verify user owns this upload
    const user = await User.findOne({ phone: req.user.phone });
    if (!user || String(upload.userId) !== String(user._id)) {
      return res.status(403).json({ success: false, message: "Unauthorized" });
    }

    return res.json({
      success: true,
      uploadId: upload._id,
      status: upload.status, // "uploading", "completed", "failed"
      fileUrl: upload.fileUrl,
      cloudinaryPublicId: upload.cloudinaryPublicId,
      failureReason: upload.failureReason,
      completedAt: upload.completedAt,
      retryable: upload.status === "failed",
    });
  } catch (err) {
    console.error("Upload status check error:", err);
    return res.status(500).json({ success: false, message: "Error checking upload status" });
  }
});

module.exports = router;
