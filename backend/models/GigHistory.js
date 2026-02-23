const mongoose = require("mongoose");

const gigHistorySchema = new mongoose.Schema(
  {
    workerPhone: { type: String, required: true, index: true },
    workerName: { type: String, default: "" },
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: "Job", index: true },
    jobTitle: { type: String, default: "" },
    contractorPhone: { type: String, default: "", index: true },
    contractorName: { type: String, default: "" },
    eventType: {
      type: String,
      enum: [
        "job_accepted",
        "job_completed",
        "job_declined_offer",
        "job_cancelled_by_worker",
        "job_cancelled_by_contractor",
      ],
      required: true,
      index: true,
    },
    status: { type: String, default: "" },
    paymentStatus: { type: String, default: "" },
    hoursWorked: { type: Number, default: 0 },
    timeSpentMinutes: { type: Number, default: 0 },
    eventTime: { type: Date, default: Date.now, index: true },
    workDate: { type: String, default: "", index: true }, // YYYY-MM-DD
    metadata: { type: Object, default: {} },
  },
  { timestamps: true }
);

gigHistorySchema.index({ workerPhone: 1, eventTime: -1 });
gigHistorySchema.index({ workerPhone: 1, workDate: -1, eventType: 1 });

module.exports = mongoose.model("GigHistory", gigHistorySchema);

