const mongoose = require("mongoose");

const supportTicketSchema = new mongoose.Schema(
  {
    ticketId: { type: String, required: true, unique: true, index: true },
    reporterPhone: { type: String, required: true, index: true },
    reportedPhone: String, // person being reported/complained about
    jobId: { type: String, index: true },
    type: {
      type: String,
      enum: [
        "payment_issue",
        "quality_issue",
        "safety_concern",
        "fraud",
        "behavioral_issue",
        "technical_issue",
        "other",
      ],
      required: true,
    },
    subject: { type: String, required: true },
    description: { type: String, required: true },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium",
    },
    status: {
      type: String,
      enum: ["open", "under_review", "waiting_user_response", "resolved", "closed"],
      default: "open",
    },
    screenshots: [String], // URLs of evidence/proof
    attachments: [
      {
        fileName: String,
        fileUrl: String,
        uploadedAt: Date,
      },
    ],
    // Resolution details
    assignedToAdmin: String, // admin phone who handles this
    resolution: String,
    resolutionNotes: String,
    resolvedAt: Date,
    resolutionEvidenceUrl: String,
    // Follow-up
    followUpRequired: { type: Boolean, default: false },
    followUpDate: Date,
    // Timeline
    createdAt: { type: Date, default: Date.now, index: true },
    updatedAt: { type: Date, default: Date.now },
    closedAt: Date,
    responseTime: Number, // minutes to first response
  },
  { timestamps: true }
);

// Indexes for efficient queries
supportTicketSchema.index({ reporterPhone: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ priority: 1, status: 1 });

module.exports = mongoose.model("SupportTicket", supportTicketSchema);
