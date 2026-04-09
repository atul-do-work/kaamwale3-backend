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
        "job_request",
        "job_request_accepted",
        "job_request_declined",
        "job_accepted",
        "job_rejected",
        "job_cancelled",
        "worker_request",
        "attendance_required",
        "payment_sent",
        "payment_received",
        "rating_received",
        "rating_given",
        "message",
        "promo",
        "announcement",
        "support_response",
        "forgot_password_otp",
        "password_reset_success",
        "document_verified",
        "document_rejected",
        "verification_required",
        "account_warning",
        "account_restricted",
        "refund_processed",
        "job_completed",
        "review_reminder",
        "ops_alert",
      ],
      required: true,
      index: true,
    },
    title: { type: String, required: true },
    body: { type: String, required: true },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", index: true },
    // Metadata - flexible object for additional data
    metadata: mongoose.Schema.Types.Mixed,
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
    provider: { type: String, default: null }, // fcm, sms_vendor, email_provider
    providerMessageId: { type: String, default: null, index: true },
    deliveryStatus: {
      type: String,
      enum: ["queued", "sent", "delivered", "failed"],
      default: "queued",
      index: true,
    },
    failureReason: { type: String, default: null },
    deliveredAt: Date,
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
