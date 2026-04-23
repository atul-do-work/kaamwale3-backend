const express = require("express");
const { authenticateToken } = require("../utils/auth");
const User = require("../models/User");
const Upload = require("../models/Upload");
const {
  uploadImageBufferToCloudinary,
  isCloudinaryAssetUrl,
  deleteCloudinaryAsset,
} = require("../utils/cloudinaryUpload");
const MAX_IMAGE_SIZE_BYTES = Math.floor(1.5 * 1024 * 1024);

function createUsersProfileRouter({ upload, io, connectedWorkers }) {
  const router = express.Router();

  router.post("/users/photo", authenticateToken, async (req, res) => {
    try {
      console.log("[profile-upload] /users/photo called", {
        phone: req.user?.phone,
        hasFileUrl: Boolean(req.body?.fileUrl),
        hasCloudinaryPublicId: Boolean(req.body?.cloudinaryPublicId),
        hasMultipartFile: Boolean(req.file),
      });

      let uploaded;

      // Check if it's a direct Cloudinary URL upload (new method)
      if (req.body.fileUrl) {
        if (!isCloudinaryAssetUrl(req.body.fileUrl)) {
          console.warn("[profile-upload] rejected invalid cloudinary url", {
            phone: req.user?.phone,
            fileUrl: req.body.fileUrl,
          });
          return res.status(400).json({ success: false, message: "Invalid Cloudinary asset URL" });
        }
        // Direct upload - URL already uploaded to Cloudinary
        uploaded = {
          secure_url: req.body.fileUrl,
          public_id: req.body.cloudinaryPublicId || ""
        };
        console.log("[profile-upload] accepted direct cloudinary url", {
          phone: req.user?.phone,
          publicId: uploaded.public_id || null,
        });
      } else {
        // Legacy method - handle file upload via multer
        if (!req.file || !req.file.buffer) return res.status(400).json({ success: false, message: "No file uploaded" });
        if (Number(req.file.size || 0) > MAX_IMAGE_SIZE_BYTES) {
          return res.status(400).json({
            success: false,
            message: "Image too large. Maximum size is 1.5MB",
          });
        }

        uploaded = await uploadImageBufferToCloudinary({
          buffer: req.file.buffer,
          mimeType: req.file.mimetype || "image/jpeg",
          folder: "kaamwale/profile",
          publicId: `profile-${req.user.phone}-${Date.now()}`,
        });
        console.log("[profile-upload] uploaded via multipart backend path", {
          phone: req.user?.phone,
          publicId: uploaded?.public_id || null,
        });
      }

      const user = await User.findOne({ phone: req.user.phone });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const previousPublicId = user.profilePhotoPublicId || "";
      user.profilePhoto = uploaded.secure_url;
      user.profilePhotoPublicId = uploaded.public_id || "";
      await user.save();
      console.log("[profile-upload] user profile saved", {
        phone: req.user?.phone,
        previousPublicId: previousPublicId || null,
        nextPublicId: user.profilePhotoPublicId || null,
      });

      await Upload.create({
        userId: user._id,
        type: "profilePhoto",
        fileName: uploaded.public_id || `profile-${req.user.phone}-${Date.now()}`,
        fileUrl: user.profilePhoto,
        cloudinaryPublicId: user.profilePhotoPublicId,
      });
      console.log("[profile-upload] upload record created", {
        phone: req.user?.phone,
        fileUrl: user.profilePhoto,
      });

      if (previousPublicId && previousPublicId !== user.profilePhotoPublicId) {
        deleteCloudinaryAsset(previousPublicId).catch((cleanupErr) => {
          console.warn("Failed to delete previous Cloudinary profile photo", cleanupErr.message);
        });
      }

      if (io && typeof io.to === "function") {
        io.to(req.user.phone).emit("profilePhotoUpdated", {
          phone: req.user.phone,
          profilePhoto: user.profilePhoto,
        });
        console.log("[profile-upload] socket event emitted", { phone: req.user?.phone });
      }

      console.log("[profile-upload] /users/photo success", { phone: req.user?.phone });
      return res.json({ success: true, profilePhoto: user.profilePhoto });
    } catch (err) {
      console.error("[profile-upload] /users/photo failed", {
        phone: req.user?.phone,
        message: err?.message,
        stack: err?.stack,
      });
      return res.status(500).json({ success: false, message: err?.message || "Internal server error" });
    }
  });

  router.post("/users/update-profile", authenticateToken, async (req, res) => {
    try {
      const { mainSkill, expectedWage } = req.body;
      if (!mainSkill || !expectedWage) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
      }

      const user = await User.findOne({ phone: req.user.phone });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      user.mainSkill = mainSkill;
      user.expectedWage = expectedWage;
      await user.save();

      for (const [, worker] of connectedWorkers.entries()) {
        if (worker.phone === req.user.phone) {
          worker.mainSkill = mainSkill;
          worker.expectedWage = expectedWage;
          break;
        }
      }

      return res.json({
        success: true,
        message: "Profile updated successfully",
        user: {
          name: user.name,
          phone: user.phone,
          mainSkill: user.mainSkill,
          expectedWage: user.expectedWage,
        },
      });
    } catch (err) {
      console.error("Profile update error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/users", authenticateToken, async (req, res) => {
    try {
      const users = await User.find();
      return res.json(users);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Failed to load users" });
    }
  });

  router.get("/users/profile", authenticateToken, async (req, res) => {
    try {
      const user = await User.findOne({ phone: req.user.phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      return res.json({
        success: true,
        user: {
          _id: user._id,
          name: user.name,
          phone: user.phone,
          role: user.role,
          profilePhoto: user.profilePhoto,
          profilePhotoPublicId: user.profilePhotoPublicId || "",
          city: user.city,
          state: user.state,
          premiumPlan: user.premiumPlan || { type: "free" },
          latitude: user.latitude || (user.location && user.location.coordinates ? user.location.coordinates[1] : 0),
          longitude: user.longitude || (user.location && user.location.coordinates ? user.location.coordinates[0] : 0),
          mainSkill: user.mainSkill || "",
          expectedWage: user.expectedWage || "",
          preferences: {
            notifications: user.preferences?.notifications ?? true,
            emailAlerts: user.preferences?.emailAlerts ?? true,
          },
        },
      });
    } catch (err) {
      console.error("Profile error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/users/preferences", authenticateToken, async (req, res) => {
    try {
      const user = await User.findOne({ phone: req.user.phone }).select('preferences');
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
      return res.json({
        success: true,
        preferences: {
          notifications: user.preferences?.notifications ?? true,
          emailAlerts: user.preferences?.emailAlerts ?? true,
        },
      });
    } catch (err) {
      console.error("Preferences fetch error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/users/preferences", authenticateToken, async (req, res) => {
    try {
      const { notifications, emailAlerts } = req.body;
      if (typeof notifications !== 'boolean' || typeof emailAlerts !== 'boolean') {
        return res.status(400).json({ success: false, message: "Invalid preferences payload" });
      }

      const user = await User.findOne({ phone: req.user.phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      user.preferences = {
        notifications,
        emailAlerts,
      };
      await user.save();

      return res.json({ success: true, preferences: user.preferences });
    } catch (err) {
      console.error("Preferences update error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createUsersProfileRouter };
