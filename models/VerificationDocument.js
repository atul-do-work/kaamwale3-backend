const mongoose = require("mongoose");

const verificationDocumentSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    phone: { type: String, required: true, unique: true, index: true },
    documents: [
      {
        type: {
          type: String,
          enum: ["aadhar", "pan", "driver_license", "voter_id", "bank_account", "gst", "other"],
          required: true,
        },
        fileUrl: { type: String, required: true },
        fileName: String,
        documentNumber: String, // Aadhar no, PAN no, etc.
        uploadedAt: { type: Date, default: Date.now },
        // Verification details
        verificationStatus: {
          type: String,
          enum: ["pending", "approved", "rejected", "expired"],
          default: "pending",
        },
        verifiedAt: Date,
        verifiedBy: String, // admin phone who verified
        rejectionReason: String, // reason if rejected
        expiryDate: Date,
        // Metadata
        issuingAuthority: String,
        issuingDate: Date,
      },
    ],
    // Overall verification status
    overallVerificationStatus: {
      type: String,
      enum: ["verified", "pending", "rejected", "suspended"],
      default: "pending",
    },
    backgroundCheckPassed: { type: Boolean, default: false },
    backgroundCheckDate: Date,
    backgroundCheckProvider: String, // e.g., 'internal', 'third_party'
    backgroundCheckResult: String,
    // Verification timeline
    firstVerificationRequest: Date,
    lastVerificationUpdate: Date,
    verificationNotes: String,
    // Compliance
    kycStatus: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    kycApprovedAt: Date,
    kycApprovedBy: String,
    // Notifications
    reminderSent: { type: Boolean, default: false },
    reminderSentAt: Date,
    // Account status based on verification
    accountStatus: {
      type: String,
      enum: ["active", "restricted", "suspended", "banned"],
      default: "restricted", // restricted until verified
    },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Indexes
verificationDocumentSchema.index({ phone: 1, overallVerificationStatus: 1 });
verificationDocumentSchema.index({ verificationStatus: 1 });
verificationDocumentSchema.index({ backgroundCheckPassed: 1 });
verificationDocumentSchema.index({ kycStatus: 1 });

module.exports = mongoose.model("VerificationDocument", verificationDocumentSchema);
