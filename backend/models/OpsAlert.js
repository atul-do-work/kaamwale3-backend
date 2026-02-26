const mongoose = require("mongoose");

const opsAlertSchema = new mongoose.Schema(
  {
    alertType: { type: String, default: "general", index: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "warning", index: true },
    title: { type: String, required: true },
    message: { type: String, default: "" },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
    source: { type: String, default: "backend", index: true },
    audiences: {
      type: [String],
      enum: ["admin", "contractor", "worker", "all"],
      default: ["admin"],
      index: true,
    },
    targetPhones: { type: [String], default: [], index: true },
    readByPhones: { type: [String], default: [], index: true },
    read: { type: Boolean, default: false, index: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);

opsAlertSchema.index({ createdAt: -1, read: 1 });

module.exports = mongoose.model("OpsAlert", opsAlertSchema);
