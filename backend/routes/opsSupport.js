const express = require("express");
const { authenticateToken } = require("../utils/auth");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = require("express-rate-limit");
const crypto = require("crypto");
const ActivityLog = require("../models/ActivityLog");
const SupportTicket = require("../models/SupportTicket");
const VerificationDocument = require("../models/VerificationDocument");
const { uploadFileBufferToCloudinary } = require("../utils/cloudinaryUpload");

function createOpsSupportRouter({ upload, PORT }) {
  const router = express.Router();
  const SUPPORT_TYPES = new Set([
    "payment_issue",
    "quality_issue",
    "safety_concern",
    "fraud",
    "behavioral_issue",
    "technical_issue",
    "other",
  ]);

  const supportCreateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.user?.phone || ipKeyGenerator(req.ip),
    message: { success: false, message: "Too many support tickets created. Please try again later." },
  });

  const sanitizeText = (value, maxLen) => {
    if (typeof value !== "string") return "";
    return value
      .replace(/[\u0000-\u001F\u007F]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLen);
  };

  const generateTicketId = () => {
    if (typeof crypto.randomUUID === "function") {
      return `TKT-${crypto.randomUUID()}`;
    }
    return `TKT-${crypto.randomBytes(16).toString("hex")}`;
  };

  router.post("/activity/log", authenticateToken, async (req, res) => {
    try {
      const { action, jobId, relatedPhone, metadata } = req.body;

      const activityLog = new ActivityLog({
        userId: req.user._id || req.user.phone,
        phone: req.user.phone,
        action,
        jobId,
        relatedPhone,
        metadata,
        status: "success",
        timestamp: new Date(),
      });

      await activityLog.save();
      return res.json({ success: true, activity: activityLog });
    } catch (err) {
      console.error("Activity log error:", err);
      return res.status(500).json({ success: false, message: "Error logging activity" });
    }
  });

  router.get("/activity/history", authenticateToken, async (req, res) => {
    try {
      const { limit = 50, skip = 0 } = req.query;
      const parsedLimit = parseInt(limit, 10);
      const parsedSkip = parseInt(skip, 10);

      const activities = await ActivityLog.find({ phone: req.user.phone })
        .sort({ timestamp: -1 })
        .limit(parsedLimit)
        .skip(parsedSkip);

      const total = await ActivityLog.countDocuments({ phone: req.user.phone });
      return res.json({
        success: true,
        activities,
        total,
        page: Math.ceil((parsedSkip + parsedLimit) / parsedLimit),
      });
    } catch (err) {
      console.error("Activity history error:", err);
      return res.status(500).json({ success: false, message: "Error fetching activity history" });
    }
  });

  router.post("/support/create", authenticateToken, supportCreateLimiter, async (req, res) => {
    try {
      // Reject abnormally large request payloads for this endpoint.
      if (JSON.stringify(req.body || {}).length > 15000) {
        return res.status(413).json({ success: false, message: "Support request payload too large" });
      }

      const type = sanitizeText(req.body?.type, 40);
      const subject = sanitizeText(req.body?.subject, 140);
      const description = sanitizeText(req.body?.description, 2500);
      const jobId = sanitizeText(req.body?.jobId, 64) || undefined;
      const reportedPhone = sanitizeText(req.body?.reportedPhone, 16) || undefined;
      const screenshots = Array.isArray(req.body?.screenshots) ? req.body.screenshots : [];

      if (!type || !subject || !description) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
      }
      if (!SUPPORT_TYPES.has(type)) {
        return res.status(400).json({ success: false, message: "Invalid support ticket type" });
      }
      if (subject.length < 5 || subject.length > 120) {
        return res.status(400).json({ success: false, message: "Subject must be 5-120 characters" });
      }
      if (description.length < 15 || description.length > 2000) {
        return res.status(400).json({ success: false, message: "Description must be 15-2000 characters" });
      }
      if (reportedPhone && !/^\d{10}$/.test(reportedPhone)) {
        return res.status(400).json({ success: false, message: "reportedPhone must be a valid 10-digit phone" });
      }
      if (screenshots.length > 5) {
        return res.status(400).json({ success: false, message: "Maximum 5 screenshots allowed" });
      }
      if (screenshots.some((s) => typeof s !== "string" || s.length > 2048)) {
        return res.status(400).json({ success: false, message: "Invalid screenshot data" });
      }

      const ticketId = generateTicketId();
      const ticket = new SupportTicket({
        ticketId,
        reporterPhone: req.user.phone,
        reportedPhone,
        jobId,
        type,
        subject,
        description,
        screenshots,
        status: "open",
        createdAt: new Date(),
      });
      await ticket.save();

      await ActivityLog.create({
        userId: req.user._id || req.user.phone,
        phone: req.user.phone,
        action: "support_ticket_created",
        description: `Support ticket created: ${subject}`,
        status: "success",
        metadata: { ticketId, type },
      });

      return res.json({ success: true, ticket, message: "Support ticket created successfully" });
    } catch (err) {
      console.error("Support ticket creation error:", err);
      return res.status(500).json({ success: false, message: "Error creating support ticket" });
    }
  });

  router.get("/support/tickets", authenticateToken, async (req, res) => {
    try {
      const tickets = await SupportTicket.find({
        $or: [{ reporterPhone: req.user.phone }, { reportedPhone: req.user.phone }],
      })
        .sort({ createdAt: -1 })
        .limit(50);

      return res.json({ success: true, tickets, count: tickets.length });
    } catch (err) {
      console.error("Fetch tickets error:", err);
      return res.status(500).json({ success: false, message: "Error fetching tickets" });
    }
  });

  router.get("/support/ticket/:ticketId", authenticateToken, async (req, res) => {
    try {
      const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
      if (!ticket) {
        return res.status(404).json({ success: false, message: "Ticket not found" });
      }

      const requesterPhone = req.user?.phone;
      const requesterRole = req.user?.role;
      const isOwner =
        requesterPhone &&
        (ticket.reporterPhone === requesterPhone || ticket.reportedPhone === requesterPhone);
      const isAdmin = requesterRole === "admin";

      if (!isOwner && !isAdmin) {
        return res.status(403).json({ success: false, message: "Not authorized to view this ticket" });
      }

      if (ticket.reporterPhone === req.user.phone && !ticket.isRead) {
        ticket.isRead = true;
        ticket.readAt = new Date();
        await ticket.save();
      }

      return res.json({ success: true, ticket });
    } catch (err) {
      console.error("Fetch ticket error:", err);
      return res.status(500).json({ success: false, message: "Error fetching ticket" });
    }
  });

  const ALLOWED_DOCUMENT_TYPES = new Set(["aadhar", "pan", "voter", "policy", "bank_account"]);

  const verificationUploadMiddleware = upload.single('file');

  router.post("/verification/upload", authenticateToken, verificationUploadMiddleware, async (req, res) => {
    try {
      const type = req.body?.type || req.body?.documentType || req.query?.type;
      const documentNumber = req.body?.documentNumber || req.query?.documentNumber;
      const expiryDate = req.body?.expiryDate || req.query?.expiryDate;

      // Validate document type
      if (!type) {
        return res.status(400).json({ success: false, message: "Missing document type" });
      }
      if (!ALLOWED_DOCUMENT_TYPES.has(type)) {
        return res.status(400).json({ success: false, message: `Invalid document type. Allowed types: ${Array.from(ALLOWED_DOCUMENT_TYPES).join(", ")}` });
      }

      // Check if it's a direct Cloudinary URL upload (new method)
      if (req.body?.fileUrl && req.body?.cloudinaryPublicId) {
        // Direct upload - URL already uploaded to Cloudinary
        let verification = await VerificationDocument.findOne({ phone: req.user.phone });
        if (!verification) {
          verification = new VerificationDocument({
            userId: req.user._id || req.user.phone,
            phone: req.user.phone,
            documents: [],
            accountStatus: "restricted",
          });
        }

        // Check if document with this type already has pending or approved status
        const existingDoc = verification.documents.find((doc) => doc.type === type);
        if (existingDoc && (existingDoc.verificationStatus === "pending" || existingDoc.verificationStatus === "approved")) {
          return res.status(400).json({
            success: false,
            message: `A ${type} document with status "${existingDoc.verificationStatus}" already exists. Please wait for verification to complete or contact support.`,
            existingStatus: existingDoc.verificationStatus,
          });
        }

        verification.documents.push({
          type,
          fileUrl: req.body.fileUrl,
          fileName: req.body.fileName || `${type}_${Date.now()}`,
          documentNumber: documentNumber || undefined,
          uploadedAt: new Date(),
          verificationStatus: "pending",
          expiryDate: expiryDate ? new Date(expiryDate) : undefined,
          cloudinaryPublicId: req.body.cloudinaryPublicId,
        });
        await verification.save();

        return res.json({ success: true, verification, message: "Document uploaded for verification" });
      }

      // Legacy method - handle file upload via multer
      if (!req.file && !req.body?.imageData) {
        return res.status(400).json({ success: false, message: "Missing file" });
      }

      let verification = await VerificationDocument.findOne({ phone: req.user.phone });
      if (!verification) {
        verification = new VerificationDocument({
          userId: req.user._id || req.user.phone,
          phone: req.user.phone,
          documents: [],
          accountStatus: "restricted",
        });
      }

      // Check if document with this type already has pending or approved status
      const existingDoc = verification.documents.find((doc) => doc.type === type);
      if (existingDoc && (existingDoc.verificationStatus === "pending" || existingDoc.verificationStatus === "approved")) {
        return res.status(400).json({
          success: false,
          message: `A ${type} document with status "${existingDoc.verificationStatus}" already exists. Please wait for verification to complete or contact support.`,
          existingStatus: existingDoc.verificationStatus,
        });
      }

      let fileUrl = null;
      let fileName = null;
      let cloudinaryPublicId = null;

      if (req.file && req.file.buffer) {
        fileName = req.file.originalname || req.file.filename;
        const mimeType = req.file.mimetype || "application/octet-stream";
        const isImage = mimeType.startsWith("image/");
        const resourceType = isImage ? "image" : "raw";
        const folder = "kaamwale/verification";

        const uploadResult = await uploadFileBufferToCloudinary({
          buffer: req.file.buffer,
          mimeType,
          folder,
          publicId: `verification-${req.user.phone}-${Date.now()}-${fileName}`,
          resourceType,
        });

        fileUrl = uploadResult.secure_url;
        cloudinaryPublicId = uploadResult.public_id;
      } else if (req.body?.imageData) {
        fileUrl = req.body.imageData;
        fileName = req.body.fileName || `${type}_${Date.now()}`;
      }

      verification.documents.push({
        type,
        fileUrl,
        fileName: fileName || "",
        documentNumber: documentNumber || undefined,
        uploadedAt: new Date(),
        verificationStatus: "pending",
        expiryDate: expiryDate ? new Date(expiryDate) : undefined,
        cloudinaryPublicId,
      });
      await verification.save();

      return res.json({ success: true, verification, message: "Document uploaded for verification" });
    } catch (err) {
      console.error("Document upload error:", err);
      return res.status(500).json({ success: false, message: "Error uploading document" });
    }
  });

  router.get("/verification/status", authenticateToken, async (req, res) => {
    try {
      let verification = await VerificationDocument.findOne({ phone: req.user.phone });
      if (!verification) {
        verification = new VerificationDocument({
          userId: req.user._id || req.user.phone,
          phone: req.user.phone,
          overallVerificationStatus: "pending",
          accountStatus: "restricted",
        });
        await verification.save();
      }

      return res.json({ success: true, verification });
    } catch (err) {
      console.error("Verification status error:", err);
      return res.status(500).json({ success: false, message: "Error fetching verification status" });
    }
  });

  return router;
}

module.exports = { createOpsSupportRouter };
