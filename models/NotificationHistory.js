const mongoose = require("mongoose");

const notificationHistorySchema = new mongoose.Schema(
  {
    recipientPhone: { type: String, required: true },
    senderPhone: String, // who triggered the notification
    senderName: String,
    type: {
      type: String,
      enum: [
        "job_offer",
        "job_accepted",
        "job_rejected",
        "job_cancelled",
        "attendance_required",
        "payment_sent",
        "payment_received",
        "rating_received",
        "rating_given",
        "message",
        "promo",
        "announcement",
        "support_response",
        "document_verified",
        "verification_required",
        "account_warning",
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    jobId: { type: String, index: true },
    // Metadata
    metadata: {
      amount: Number,
      rating: Number,
      jobTitle: String,
      location: String,
      actionRequired: Boolean,
    },
    // Navigation
    deepLink: String, // to navigate to specific screen on click
    // Read status
    isRead: { type: Boolean, default: false },
    readAt: Date,
    // Delivery
    pushNotificationSent: { type: Boolean, default: false },
    pushNotificationSentAt: Date,
    emailSent: { type: Boolean, default: false },
    emailSentAt: Date,
    smsSent: { type: Boolean, default: false },
    smsSentAt: Date,
    // User action
    actionTaken: { type: Boolean, default: false },
    actionTakenAt: Date,
    actionType: String, // e.g., 'accepted', 'rejected', 'viewed'
    // Expiry (some notifications become stale)
    expiryDate: Date,
    isExpired: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// Indexes
notificationHistorySchema.index({ recipientPhone: 1, createdAt: -1 });
notificationHistorySchema.index({ recipientPhone: 1, isRead: 1 });
notificationHistorySchema.index({ type: 1, createdAt: -1 });

module.exports = mongoose.model("NotificationHistory", notificationHistorySchema);
