const express = require("express");
const fs = require("fs").promises;
const { authenticateToken } = require("../utils/auth");
const User = require("../models/User");
const { uploadImagePathToCloudinary } = require("../utils/cloudinaryUpload");

function createUsersProfileRouter({ upload, io, connectedWorkers }) {
  const router = express.Router();

  router.post("/users/photo", authenticateToken, upload.single("photo"), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

      const user = await User.findOne({ phone: req.user.phone });
      if (!user) return res.status(404).json({ success: false, message: "User not found" });

      const uploaded = await uploadImagePathToCloudinary({
        filePath: req.file.path,
        mimeType: req.file.mimetype || "image/jpeg",
        folder: "kaamwale/profile",
        publicId: `profile-${req.user.phone}-${Date.now()}`,
      });
      user.profilePhoto = uploaded.secure_url;
      await user.save();

      io.emit("profilePhotoUpdated", {
        phone: req.user.phone,
        profilePhoto: user.profilePhoto,
      });

      return res.json({ success: true, profilePhoto: user.profilePhoto });
    } catch (err) {
      console.error("Profile photo upload error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    } finally {
      if (req.file?.path) {
        fs.rm(req.file.path, { force: true }).catch(() => {});
      }
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
          city: user.city,
          state: user.state,
          premiumPlan: user.premiumPlan || { type: "free" },
          latitude: user.latitude || (user.location && user.location.coordinates ? user.location.coordinates[1] : 0),
          longitude: user.longitude || (user.location && user.location.coordinates ? user.location.coordinates[0] : 0),
          mainSkill: user.mainSkill || "",
          expectedWage: user.expectedWage || "",
        },
      });
    } catch (err) {
      console.error("Profile error:", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createUsersProfileRouter };
