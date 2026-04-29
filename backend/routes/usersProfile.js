const express = require("express");
const { authenticateToken } = require("../utils/auth");
const User = require("../models/User");
const Worker = require("../models/Worker");
const Wallet = require("../models/Wallet");
const BankAccount = require("../models/BankAccount");
const Withdrawal = require("../models/Withdrawal");
const VerificationDocument = require("../models/VerificationDocument");
const NotificationHistory = require("../models/NotificationHistory");
const ActivityLog = require("../models/ActivityLog");
const SupportTicket = require("../models/SupportTicket");
const ContractorStats = require("../models/ContractorStats");
const IncentiveLedger = require("../models/IncentiveLedger");
const GigHistory = require("../models/GigHistory");
const WorkerEarnings = require("../models/WorkerEarnings");
const CashDeposit = require("../models/CashDeposit");
const PayoutBatch = require("../models/PayoutBatch");
const TermsAuditLog = require("../models/TermsAuditLog");
const PremiumSubscription = require("../models/PremiumSubscription");
const CancellationLog = require("../models/CancellationLog");
const CityLeaderboard = require("../models/CityLeaderboard");
const Job = require("../models/Jobs");
const JobEventLog = require("../models/JobEventLog");
const Upload = require("../models/Upload");
const {
  uploadImageBufferToCloudinary,
  isCloudinaryAssetUrl,
  deleteCloudinaryAsset,
} = require("../utils/cloudinaryUpload");
const MAX_IMAGE_SIZE_BYTES = Math.floor(1.5 * 1024 * 1024);

async function deleteUserAccountData({ user, connectedWorkers }) {
  const phone = String(user?.phone || "").trim();
  const userId = user?._id ? String(user._id) : "";
  if (!phone || !userId) {
    throw new Error("Missing user identity for account deletion");
  }

  const uploads = await Upload.find({ userId: user._id }).select("cloudinaryPublicId").lean();
  const cloudinaryIds = new Set(
    [
      user.profilePhotoPublicId || "",
      ...uploads.map((item) => item?.cloudinaryPublicId || ""),
    ].filter(Boolean)
  );

  const postedJobs = await Job.find({ contractorPhone: phone }).select("_id").lean();
  const postedJobIds = postedJobs.map((job) => job._id).filter(Boolean);

  await Promise.allSettled(
    Array.from(cloudinaryIds).map((publicId) => deleteCloudinaryAsset(publicId))
  );

  if (postedJobIds.length > 0) {
    await JobEventLog.deleteMany({ jobId: { $in: postedJobIds } });
  }

  // Remove jobs created by this contractor entirely.
  await Job.deleteMany({ contractorPhone: phone });

  // Remove this worker's direct traces from jobs owned by others.
  await Job.updateMany(
    {
      contractorPhone: { $ne: phone },
      $or: [
        { acceptedBy: phone },
        { "acceptedWorkers.phone": phone },
        { declinedBy: phone },
      ],
    },
    {
      $unset: {
        acceptedBy: "",
        acceptedWorker: "",
        acceptedAt: "",
        attendanceStatus: "",
        attendanceTime: "",
        paymentStatus: "",
        paymentMode: "",
        paymentTime: "",
        hoursWorked: "",
        timeSpentMinutes: "",
        rating: "",
      },
      $pull: {
        acceptedWorkers: { phone },
        declinedBy: phone,
      },
    }
  );

  await Promise.all([
    Upload.deleteMany({ userId: user._id }),
    Wallet.deleteMany({ phone }),
    BankAccount.deleteMany({ phone }),
    Withdrawal.deleteMany({ phone }),
    VerificationDocument.deleteMany({ $or: [{ userId }, { phone }] }),
    NotificationHistory.deleteMany({ $or: [{ recipientPhone: phone }, { senderPhone: phone }] }),
    ActivityLog.deleteMany({ $or: [{ userId }, { phone }, { relatedPhone: phone }] }),
    SupportTicket.deleteMany({ $or: [{ reporterPhone: phone }, { reportedPhone: phone }] }),
    ContractorStats.deleteMany({ phone }),
    IncentiveLedger.deleteMany({ phone }),
    GigHistory.deleteMany({ $or: [{ workerPhone: phone }, { contractorPhone: phone }] }),
    WorkerEarnings.deleteMany({ $or: [{ workerPhone: phone }, { contractorPhone: phone }] }),
    CashDeposit.deleteMany({ $or: [{ workerPhone: phone }, { contractorPhone: phone }] }),
    PayoutBatch.updateMany(
      { "workers.workerPhone": phone },
      { $pull: { workers: { workerPhone: phone } } }
    ),
    TermsAuditLog.deleteMany({ phone }),
    PremiumSubscription.deleteMany({ contractorPhone: phone }),
    CancellationLog.deleteMany({ $or: [{ contractorPhone: phone }, { workerPhone: phone }] }),
    CityLeaderboard.updateMany({}, { $pull: { leaderboard: { phone } } }),
    JobEventLog.deleteMany({ actorPhone: phone }),
    Worker.deleteMany({ phone }),
    User.deleteOne({ _id: user._id }),
  ]);

  if (connectedWorkers && typeof connectedWorkers.entries === "function") {
    for (const [key, worker] of connectedWorkers.entries()) {
      if (worker?.phone === phone) {
        connectedWorkers.delete(key);
      }
    }
  }

  return {
    deletedPostedJobs: postedJobIds.length,
    deletedUploads: uploads.length,
  };
}

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

  router.delete("/users/account", authenticateToken, async (req, res) => {
    try {
      const user = await User.findOne({ phone: req.user.phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const cleanupSummary = await deleteUserAccountData({ user, connectedWorkers });

      return res.json({
        success: true,
        message: "Account deleted successfully",
        summary: cleanupSummary,
      });
    } catch (err) {
      console.error("Account deletion error:", err);
      return res.status(500).json({ success: false, message: err?.message || "Failed to delete account" });
    }
  });

  return router;
}

module.exports = { createUsersProfileRouter };
