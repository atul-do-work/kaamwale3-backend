const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const Upload = require("../models/Upload");
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { authenticateToken } = require("../utils/auth");

const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

// Multer storage setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});

const upload = multer({ storage });

// Upload a file (profile photo or document)
router.post("/upload", authenticateToken, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: "No file uploaded" });

    const user = await User.findOne({ phone: req.user.phone });
    if (!user) return res.status(404).json({ success: false, message: "User not found" });

    const fileUrl = `${req.protocol}://${req.get("host")}/uploads/${req.file.filename}`;

    // Save in uploads collection
    const newUpload = new Upload({
      userId: user._id,
      type: req.body.type || "document",
      fileName: req.file.filename,
      fileUrl,
    });

    await newUpload.save();

    // If it's a profile photo, also update User
    if (req.body.type === "profilePhoto") {
      user.profilePhoto = fileUrl;
      await user.save();
    }

    return res.json({ success: true, fileUrl, upload: newUpload });
  } catch (err) {
    console.error("Upload error", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

module.exports = router;
