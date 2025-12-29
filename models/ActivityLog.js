const mongoose = require("mongoose");

const activityLogSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    phone: { type: String, required: true, index: true },
    action: {
      type: String,
      enum: [
        "user_registered",
        "user_login",
        "user_logout",
        "profile_updated",
        "photo_uploaded",
        "job_posted",
        "job_accepted",
        "job_declined",
        "attendance_marked",
        "payment_sent",
        "payment_received",
        "job_completed",
        "rating_given",
        "wallet_deposit",
        "wallet_withdraw",
        "location_updated",
        "document_uploaded",
        "support_ticket_created",
        "job_cancelled",
        "verification_document_uploaded",
        "refund_processed",
        "premium_subscription",
        "bank_account_verified",
        "bank_account_rejected",
        "document_verified",
        "document_rejected",
      ],
      required: true,
      index: true,
    },
    description: String,
    jobId: { type: String, index: true },
    relatedUserId: String, // other user involved (e.g., contractor for worker's job_accepted)
    relatedPhone: String,
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: [Number], // [longitude, latitude]
    },
    ipAddress: String,
    deviceInfo: String,
    status: {
      type: String,
      enum: ["success", "failed", "pending"],
      default: "success",
    },
    metadata: {
      // Store extra info: amount for payments, stars for ratings, etc.
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

// Compound index for faster queries by phone and action
activityLogSchema.index({ phone: 1, timestamp: -1 });
activityLogSchema.index({ action: 1, timestamp: -1 });

module.exports = mongoose.model("ActivityLog", activityLogSchema);
