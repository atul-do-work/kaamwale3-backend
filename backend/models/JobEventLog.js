const mongoose = require('mongoose');

const jobEventLogSchema = new mongoose.Schema(
  {
    jobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', required: true, immutable: true },
    eventType: { type: String, required: true, immutable: true },
    actorType: {
      type: String,
      enum: ['worker', 'contractor', 'admin', 'system', 'webhook'],
      required: true,
      immutable: true,
    },
    actorId: { type: String, default: null, immutable: true },
    actorPhone: { type: String, default: null, immutable: true },
    oldState: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    newState: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    source: {
      type: String,
      enum: ['app', 'webhook', 'admin_panel', 'reconciliation', 'system'],
      default: 'system',
      immutable: true,
    },
    idempotencyKey: { type: String, default: null, immutable: true },
    provider: { type: String, default: null, immutable: true },
    providerEventId: { type: String, default: null, immutable: true },
    reasonCode: { type: String, default: null, immutable: true },
    reasonText: { type: String, default: null, immutable: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null, immutable: true },
    timestamp: { type: Date, default: Date.now, index: true, immutable: true },
  },
  { timestamps: true }
);

jobEventLogSchema.index({ jobId: 1, timestamp: -1 });
jobEventLogSchema.index({ eventType: 1, timestamp: -1 });
jobEventLogSchema.index({ providerEventId: 1 }, { sparse: true });
jobEventLogSchema.index({ idempotencyKey: 1 }, { sparse: true });

module.exports = mongoose.model('JobEventLog', jobEventLogSchema);
