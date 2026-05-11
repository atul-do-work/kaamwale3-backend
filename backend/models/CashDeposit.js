const mongoose = require('mongoose');

const CASH_DEPOSIT_STATUS = ['pending', 'completed', 'expired', 'cancelled'];

const cashDepositSchema = new mongoose.Schema({
  jobId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Job',
    required: true,
    index: true
  },
  workerPhone: {
    type: String,
    required: true,
    index: true
  },
  contractorPhone: {
    type: String,
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true,
    min: 0
  },
  status: {
    type: String,
    enum: CASH_DEPOSIT_STATUS,
    default: 'pending',
    index: true
  },
  paymentMode: {
    type: String,
    default: 'cash'
  },
  depositDeadline: {
    type: Date,
    required: true,
    index: true
  },
  depositedAt: Date,
  idempotencyKey: {
    type: String,
    index: true
  },
  jobTitle: String,
  contractorName: String,
  workerName: String,
  // For bulk jobs
  isBulkJob: {
    type: Boolean,
    default: false
  },
  // Audit trail
  createdAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound indexes for efficient queries
cashDepositSchema.index({ workerPhone: 1, status: 1, createdAt: -1 });
cashDepositSchema.index({ jobId: 1, workerPhone: 1 }, { unique: true });
cashDepositSchema.index({ depositDeadline: 1, status: 1 });

// Auto-update updatedAt
cashDepositSchema.pre('save', function() {
  this.updatedAt = new Date();
});

// TTL index for automatic expiration (24 hours after deadline)
cashDepositSchema.index({ depositDeadline: 1 }, {
  expireAfterSeconds: 24 * 60 * 60, // 24 hours
  partialFilterExpression: { status: 'pending' }
});

module.exports = mongoose.model('CashDeposit', cashDepositSchema);