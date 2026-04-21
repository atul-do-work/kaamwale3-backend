const User = require("../models/User");
const { getPlanEntitlements } = require("../config/premiumEntitlements");

function isPremiumEntitled(user) {
  if (!user || !user.premiumPlan) return false;
  const { type, expiryDate, graceUntil, status } = user.premiumPlan;
  if (!type || type === "free") return false;

  const now = new Date();
  const expiryOk = expiryDate && new Date(expiryDate) > now;
  const graceOk = graceUntil && new Date(graceUntil) > now;

  // ✅ FIXED: If status is missing, calculate it from dates
  let statusOk = false;
  if (status === "active" || status === "grace") {
    statusOk = true;
  } else if (!status) {
    // Status is undefined - calculate from dates
    statusOk = expiryOk || graceOk;
  }

  return statusOk && (expiryOk || graceOk);
}

function requirePremium(featureKey) {
  return async function premiumFeatureGuard(req, res, next) {
    try {
      const user = await User.findOne({ phone: req.user.phone }).select("phone premiumPlan");
      if (!user || !isPremiumEntitled(user)) {
        return res.status(403).json({
          success: false,
          message: "Active premium subscription required",
        });
      }

      const entitlements = getPlanEntitlements(user.premiumPlan.type);
      if (featureKey && !entitlements[featureKey]) {
        return res.status(403).json({
          success: false,
          message: `Premium plan does not include ${featureKey}`,
        });
      }

      req.premiumEntitlement = {
        type: user.premiumPlan.type,
        expiryDate: user.premiumPlan.expiryDate,
        graceUntil: user.premiumPlan.graceUntil || null,
        status: user.premiumPlan.status || "active",
        entitlements,
      };

      return next();
    } catch (err) {
      return res.status(500).json({ success: false, message: "Premium entitlement check failed" });
    }
  };
}

module.exports = {
  isPremiumEntitled,
  requirePremium,
};
