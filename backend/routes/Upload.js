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

    const uploadResult = await uploadFileBufferToCloudinary({
      buffer: req.file.buffer,
      mimeType,
      folder,
      publicId,
      resourceType,
    });

    const fileUrl = uploadResult.secure_url;

    const newUpload = new Upload({
      userId: user._id,
      type: normalizedType,
      fileName: req.file.originalname,
      fileUrl,
      cloudinaryPublicId: uploadResult.public_id,
    });
    await newUpload.save();

    if (normalizedType === "profilePhoto") {
      user.profilePhoto = fileUrl;
      user.profilePhotoPublicId = uploadResult.public_id || "";
      await user.save();
    }

    return res.json({
      success: true,
      fileUrl,
      profilePhoto: normalizedType === "profilePhoto" ? fileUrl : undefined,
      cloudinaryPublicId: uploadResult.public_id,
      upload: newUpload,
    });
  } catch (err) {
    console.error("Upload error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

module.exports = router;
