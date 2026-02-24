const mongoose = require("mongoose");

const dispatchStateSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true, index: true },
    type: { type: String, enum: ["retry_offer", "expire_offer"], required: true, index: true },
    runAt: { type: Date, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "processing", "done", "cancelled", "failed"],
      default: "pending",
      index: true,
    },
    attempts: { type: Number, default: 0 },
    reason: { type: String, default: "" },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    lastError: { type: String, default: "" },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

dispatchStateSchema.index({ status: 1, runAt: 1, type: 1 });
dispatchStateSchema.index({ jobId: 1, type: 1, status: 1 });

module.exports = mongoose.model("DispatchState", dispatchStateSchema);

