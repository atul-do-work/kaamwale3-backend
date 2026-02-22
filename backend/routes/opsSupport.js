const express = require("express");
const { authenticateToken } = require("../utils/auth");
const ActivityLog = require("../models/ActivityLog");
const SupportTicket = require("../models/SupportTicket");
const VerificationDocument = require("../models/VerificationDocument");

function createOpsSupportRouter({ upload, PORT }) {
  const router = express.Router();

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

  router.post("/support/create", authenticateToken, async (req, res) => {
    try {
      const { type, subject, description, jobId, reportedPhone, screenshots } = req.body;
      if (!type || !subject || !description) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
      }

      const ticketId = `TICKET-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const ticket = new SupportTicket({
        ticketId,
        reporterPhone: req.user.phone,
        reportedPhone,
        jobId,
        type,
        subject,
        description,
        screenshots: screenshots || [],
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

  router.post("/verification/upload", authenticateToken, upload.single("file"), async (req, res) => {
    try {
      const type = req.body?.type || req.query?.type;
      const documentNumber = req.body?.documentNumber || req.query?.documentNumber;
      const expiryDate = req.body?.expiryDate || req.query?.expiryDate;

      if (!type && !req.file && !req.body?.imageData) {
        return res.status(400).json({ success: false, message: "Missing document type or file" });
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

      let fileUrl = null;
      let fileName = null;

      if (req.file) {
        fileName = req.file.originalname || req.file.filename;
        const host = req.headers.host || `localhost:${PORT}`;
        const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
        fileUrl = `${protocol}://${host}/uploads/${req.file.filename}`;
      } else if (req.body?.imageData) {
        fileUrl = req.body.imageData;
        fileName = req.body.fileName || `${type || "doc"}_${Date.now()}`;
      }

      verification.documents.push({
        type: type || "unknown",
        fileUrl,
        fileName: fileName || "",
        documentNumber: documentNumber || undefined,
        uploadedAt: new Date(),
        verificationStatus: "pending",
        expiryDate: expiryDate ? new Date(expiryDate) : undefined,
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
