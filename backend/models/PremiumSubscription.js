const mongoose = require("mongoose");

const premiumSubscriptionSchema = new mongoose.Schema(
  {
    subscriptionId: { type: String, required: true, unique: true, index: true },
    userPhone: { type: String, required: true, index: true },
    userName: { type: String, default: "" },
    eventType: {
      type: String,
      enum: ["subscription_started", "subscription_renewed", "subscription_cancelled", "subscription_failed"],
      default: "subscription_started",
      index: true,
    },
    planType: { type: String, enum: ["free", "basic", "pro"], default: "free", index: true },
    price: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    tax: { type: Number, default: 0 },
    coupon: { type: String, default: null },
    status: {
      type: String,
      enum: ["active", "cancelled", "expired", "grace", "failed"],
      default: "active",
      index: true,
    },
    provider: { type: String, default: "internal", index: true },
    providerSubId: { type: String, default: null, index: true },
    invoiceId: { type: String, default: null, index: true },
    idempotencyKey: { type: String, default: null, index: true },
    startedAt: { type: Date, default: Date.now },
    expiryDate: { type: Date, default: null, index: true },
    cancelAt: { type: Date, default: null },
    graceUntil: { type: Date, default: null },
    failureReason: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: null },
    isCurrent: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

premiumSubscriptionSchema.index(
  { userPhone: 1, idempotencyKey: 1 },
  { unique: true, sparse: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } }
);
premiumSubscriptionSchema.index(
  { userPhone: 1, isCurrent: 1 },
  { unique: true, partialFilterExpression: { isCurrent: true } }
);
premiumSubscriptionSchema.index(
  { userPhone: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["active", "grace"] } } }
);

module.exports = mongoose.model("PremiumSubscription", premiumSubscriptionSchema);
