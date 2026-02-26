const mongoose = require('mongoose');

const JOB_STATUS = ['pending', 'posted', 'offered', 'accepted', 'in_progress', 'completed', 'cancelled', 'expired'];
const PAYMENT_STATUS = ['pending', 'authorized', 'captured', 'failed', 'refunded', 'Paid', 'Pending', 'Failed'];

function normalizePaymentStatusValue(value) {
  const v = String(value || "").trim();
  const lower = v.toLowerCase();
  if (!v) return v;
  if (lower === "paid") return "Paid";
  if (lower === "pending") return "Pending";
  if (lower === "failed") return "Failed";
  if (lower === "authorized") return "authorized";
  if (lower === "captured") return "captured";
  if (lower === "refunded") return "refunded";
  return v;
}

const ALLOWED_JOB_STATUS_TRANSITIONS = {
  pending: ['offered', 'accepted', 'cancelled', 'expired', 'posted', 'completed'],
  posted: ['offered', 'accepted', 'cancelled', 'expired', 'completed'],
  offered: ['accepted', 'cancelled', 'expired', 'completed'],
  accepted: ['in_progress', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
  expired: [],
};

const ALLOWED_PAYMENT_STATUS_TRANSITIONS = {
  pending: ['authorized', 'captured', 'failed', 'refunded', 'Paid', 'Failed'],
  authorized: ['captured', 'failed', 'refunded'],
  captured: ['refunded'],
  failed: [],
  refunded: [],
  Pending: ['Paid', 'Failed'],
  Paid: ['refunded'],
  Failed: [],
};

const jobSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: String,
    workerType: String,
    amount: Number,
    contractorName: String,
    contractorPhone: String,
    imageUrl: String,
    lat: Number,
    lon: Number,
    jobLocation: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: undefined }, // [longitude, latitude]
    },
    date: { type: Date, default: Date.now },
    startTime: String,
    endTime: String,
    numberOfDays: { type: Number, default: 1 },
    status: { type: String, enum: JOB_STATUS, default: 'pending', index: true },
    acceptedBy: String,
    acceptedWorker: {
      id: String,
      name: String,
      phone: String,
      skills: [String],
      profilePhoto: String,
      location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: [Number],
      },
    },
    bulkHiring: { type: Boolean, default: false },
    requiredWorkers: { type: Number, default: 1 },
    idempotencyKey: { type: String },
    acceptedWorkers: [
      {
        phone: String,
        name: String,
        profilePhoto: String,
        acceptedAt: Date,
        attendanceStatus: { type: String, enum: ["Present", "Absent", null], default: null },
        attendanceTime: Date,
        paymentStatus: { type: String, enum: PAYMENT_STATUS, default: "Pending", set: normalizePaymentStatusValue },
        paymentMode: String,
        paymentTime: Date,
        rating: {
          stars: { type: Number, min: 1, max: 5 },
          feedback: String,
          ratedAt: Date,
          ratedBy: String,
        },
        skills: [String],
        location: {
          type: { type: String, enum: ['Point'], default: 'Point' },
          coordinates: [Number],
        },
      },
    ],
    declinedBy: [String],
    isCancelled: { type: Boolean, default: false },
    cancelledAt: { type: Date, default: null, index: true },
    cancelledBy: { type: String, enum: ['contractor', 'worker', 'admin', 'system', null], default: null, index: true },
    cancellationReason: { type: String, default: null },
    cancellationReasonDescription: { type: String, default: null },
    attendanceStatus: String,
    attendanceTime: Date,
    paymentStatus: { type: String, enum: PAYMENT_STATUS, default: 'Pending', set: normalizePaymentStatusValue },
    paymentMode: String,
    paymentTime: Date,
    offerExpiresAt: { type: Date, index: true },
    acceptedAt: Date,
    timeSpentMinutes: Number,
    hoursWorked: { type: Number, default: 0 },
    rating: {
      stars: { type: Number, min: 1, max: 5 },
      feedback: String,
      ratedAt: Date,
      ratedBy: String,
    },
    contractorRating: {
      stars: { type: Number, min: 1, max: 5 },
      feedback: String,
      ratedAt: Date,
      ratedBy: String,
    },
  },
  { timestamps: true }
);

jobSchema.index({ status: 1, createdAt: -1 });
jobSchema.index({ contractorPhone: 1, createdAt: -1 });
jobSchema.index({ contractorPhone: 1, idempotencyKey: 1 }, { unique: true, sparse: true });
jobSchema.index({ acceptedBy: 1, createdAt: -1 });
jobSchema.index({ jobLocation: '2dsphere' });

function getUpdatedValue(update, key) {
  if (!update || typeof update !== 'object') return undefined;
  if (update.$set && Object.prototype.hasOwnProperty.call(update.$set, key)) {
    return update.$set[key];
  }
  if (Object.prototype.hasOwnProperty.call(update, key)) {
    return update[key];
  }
  return undefined;
}

jobSchema.pre('validate', function syncGeoLocation() {
  if (
    Number.isFinite(this.lat) &&
    Number.isFinite(this.lon) &&
    (!this.jobLocation || !Array.isArray(this.jobLocation.coordinates) || this.jobLocation.coordinates.length !== 2)
  ) {
    this.jobLocation = {
      type: 'Point',
      coordinates: [this.lon, this.lat],
    };
  }

  if (this.paymentStatus) {
    this.paymentStatus = normalizePaymentStatusValue(this.paymentStatus);
  }
  if (Array.isArray(this.acceptedWorkers)) {
    for (const worker of this.acceptedWorkers) {
      if (worker && worker.paymentStatus) {
        worker.paymentStatus = normalizePaymentStatusValue(worker.paymentStatus);
      }
    }
  }
});

jobSchema.pre('save', async function enforceTransitionsOnSave() {
  // Enforce terminal consistency: paid jobs should not remain in non-terminal in-flight states.
  if (String(this.paymentStatus || "").toLowerCase() === "paid") {
    const currentStatus = String(this.status || "").toLowerCase();
    if (currentStatus !== "completed" && currentStatus !== "cancelled" && currentStatus !== "expired") {
      this.status = "completed";
    }
  }

  if (this.isNew) return;

  const existing = await this.constructor.findById(this._id).select('status paymentStatus').lean();
  if (!existing) return;

  if (this.isModified('status') && this.status !== existing.status) {
    const allowed = ALLOWED_JOB_STATUS_TRANSITIONS[existing.status] || [];
    if (allowed.length && !allowed.includes(this.status)) {
      throw new Error(`Invalid job status transition: ${existing.status} -> ${this.status}`);
    }
  }

  if (this.isModified('paymentStatus') && this.paymentStatus !== existing.paymentStatus) {
    const allowed = ALLOWED_PAYMENT_STATUS_TRANSITIONS[existing.paymentStatus] || [];
    if (allowed.length && !allowed.includes(this.paymentStatus)) {
      throw new Error(`Invalid payment status transition: ${existing.paymentStatus} -> ${this.paymentStatus}`);
    }
  }
});

jobSchema.pre('findOneAndUpdate', async function enforceTransitions() {
  const update = this.getUpdate() || {};
  const rawNextPaymentStatus = getUpdatedValue(update, 'paymentStatus');
  const nextPaymentStatus = rawNextPaymentStatus ? normalizePaymentStatusValue(rawNextPaymentStatus) : rawNextPaymentStatus;
  const requestedStatus = getUpdatedValue(update, 'status');
  let nextStatus = requestedStatus;

  if (nextPaymentStatus && rawNextPaymentStatus !== nextPaymentStatus) {
    update.$set = update.$set || {};
    update.$set.paymentStatus = nextPaymentStatus;
    this.setUpdate(update);
  }

  // Enforce terminal consistency for update operations too.
  if (String(nextPaymentStatus || "").toLowerCase() === "paid") {
    const existingForPaid = await this.model.findOne(this.getQuery()).select('status').lean();
    const existingStatus = String(existingForPaid?.status || "").toLowerCase();
    if (existingStatus !== "cancelled" && existingStatus !== "expired") {
      update.$set = update.$set || {};
      update.$set.status = "completed";
      this.setUpdate(update);
      nextStatus = "completed";
    }
  }

  if (!nextStatus && !nextPaymentStatus) {
    return;
  }

  const existing = await this.model.findOne(this.getQuery()).select('status paymentStatus').lean();
  if (!existing) {
    return;
  }

  if (nextStatus && nextStatus !== existing.status) {
    const allowed = ALLOWED_JOB_STATUS_TRANSITIONS[existing.status] || [];
    if (allowed.length && !allowed.includes(nextStatus)) {
      throw new Error(`Invalid job status transition: ${existing.status} -> ${nextStatus}`);
    }
  }

  if (nextPaymentStatus && nextPaymentStatus !== existing.paymentStatus) {
    const allowed = ALLOWED_PAYMENT_STATUS_TRANSITIONS[existing.paymentStatus] || [];
    if (allowed.length && !allowed.includes(nextPaymentStatus)) {
      throw new Error(`Invalid payment status transition: ${existing.paymentStatus} -> ${nextPaymentStatus}`);
    }
  }

  if (
    Number.isFinite(getUpdatedValue(update, 'lat')) &&
    Number.isFinite(getUpdatedValue(update, 'lon')) &&
    getUpdatedValue(update, 'jobLocation') === undefined
  ) {
    update.$set = update.$set || {};
    update.$set.jobLocation = {
      type: 'Point',
      coordinates: [getUpdatedValue(update, 'lon'), getUpdatedValue(update, 'lat')],
    };
    this.setUpdate(update);
  }
});

module.exports = mongoose.model('Job', jobSchema);
