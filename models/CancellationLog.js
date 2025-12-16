const mongoose = require("mongoose");

const cancellationLogSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, index: true },
    contractorPhone: { type: String, required: true, index: true },
    contractorName: String,
    workerPhone: String,
    workerName: String,
    // Who cancelled
    cancelledBy: {
      type: String,
      enum: ["contractor", "worker", "admin", "system"],
      required: true,
    },
    // Why cancelled
    reason: {
      type: String,
      enum: [
        "no_workers_available",
        "worker_not_responding",
        "location_changed",
        "job_completed_elsewhere",
        "payment_issue",
        "safety_concern",
        "worker_unavailable",
        "technical_issue",
        "contractor_request",
        "contractor_requested",
        "worker_request",
        "worker_requested",
        "admin_action",
        "other",
      ],
      required: true,
    },
    reasonDescription: String,
    // Financial details
    jobAmount: Number, // amount at time of cancellation
    cancellationFee: { type: Number, default: 0 }, // fee charged for cancellation
    refundAmount: Number, // amount refunded
    refundToPhone: String, // who gets the refund
    // Work done before cancellation
    hoursWorked: Number,
    partialPaymentDue: Number,
    // Timing
    jobPostedAt: Date,
    cancelledAt: { type: Date, default: Date.now, index: true },
    timeFromPostingToCancellation: Number, // in minutes
    timeFromAcceptanceToCancellation: Number, // in minutes (if accepted)
    // Policy applied
    cancellationPolicy: String, // which policy was used
    policyExplanation: String,
    // Admin review (if disputed)
    adminReview: Boolean,
    adminNotes: String,
    reviewedBy: String, // admin phone
    reviewedAt: Date,
    // Follow-up
    disputeRaised: { type: Boolean, default: false },
    ticketId: String, // reference to support ticket if disputed
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Indexes
cancellationLogSchema.index({ jobId: 1 });
cancellationLogSchema.index({ contractorPhone: 1, cancelledAt: -1 });
cancellationLogSchema.index({ workerPhone: 1, cancelledAt: -1 });
cancellationLogSchema.index({ cancelledAt: -1 });

module.exports = mongoose.model("CancellationLog", cancellationLogSchema);
