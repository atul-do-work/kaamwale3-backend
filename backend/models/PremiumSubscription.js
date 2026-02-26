const mongoose = require("mongoose");

const premiumSubscriptionSchema = new mongoose.Schema(
  {
    subscriptionId: { type: String, required: true, unique: true, index: true },
    userPhone: { type: String, required: true, index: true },
    userName: { type: String, default: "" },
    premiumTxnId: { type: String, default: null },
    eventType: {
      type: String,
      enum: ["subscription_started", "subscription_renewed", "subscription_cancelled", "subscription_failed"],
      default: "subscription_started",
      index: true,
    },
    plan: { type: String, enum: ["free", "basic", "pro"], default: "free", index: true },
    planType: { type: String, enum: ["free", "basic", "pro"], default: "free", index: true },
    price: { type: Number, default: 0 },
    currency: { type: String, default: "INR" },
    tax: { type: Number, default: 0 },
    coupon: { type: String, default: null },
    source: { type: String, enum: ["wallet", "gateway"], default: "wallet", index: true },
    amount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["active", "cancelled", "expired", "grace", "failed"],
      default: "active",
      index: true,
    },
    autoRenew: { type: Boolean, default: false },
    provider: { type: String, default: "internal", index: true },
    gatewayOrderId: { type: String, default: null, index: true },
    gatewayPaymentId: { type: String, default: null, index: true },
    gatewaySubscriptionId: { type: String, default: null, index: true },
    providerSubId: { type: String, default: null, index: true },
    invoiceId: { type: String, default: null, index: true },
    walletTxnId: { type: String, default: null },
    idempotencyKey: { type: String, default: null, index: true },
    startAt: { type: Date, default: Date.now, index: true },
    endAt: { type: Date, default: null, index: true },
    renewalAt: { type: Date, default: null, index: true },
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
premiumSubscriptionSchema.index(
  { premiumTxnId: 1 },
  { unique: true, sparse: true, partialFilterExpression: { premiumTxnId: { $type: "string" } } }
);
premiumSubscriptionSchema.index(
  { walletTxnId: 1 },
  { sparse: true }
);

module.exports = mongoose.model("PremiumSubscription", premiumSubscriptionSchema);
