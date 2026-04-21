const User = require("../models/User");
const { getPlanEntitlements } = require("../config/premiumEntitlements");

function isPremiumEntitled(user) {
  if (!user || !user.premiumPlan) return false;
  const { type, expiryDate, graceUntil, status } = user.premiumPlan;
  if (!type || type === "free") return false;

  const now = new Date();
  const expiryDate_ = expiryDate ? new Date(expiryDate) : null;
  const graceUntil_ = graceUntil ? new Date(graceUntil) : null;
  
  const expiryOk = expiryDate_ && expiryDate_ > now;
  const graceOk = graceUntil_ && graceUntil_ > now;

  // ✅ CRITICAL FIX: Always recalculate status from dates, don't rely on stored status
  // This handles cases where:
  // 1. Status field is missing or incorrect
  // 2. Time zone issues caused incorrect status storage
  // 3. Migration from old data format
  
  let isEntitled = false;
  
  // Check dates first (most reliable indicator)
  if (expiryOk || graceOk) {
    isEntitled = true;
  } 
  // If dates say no, check stored status as backup
  else if (status === "active" || status === "grace") {
    // Status says active but dates say expired - prefer dates (dates are source of truth)
    isEntitled = false;
  }

  return isEntitled;
}

/**
 * ✅ FIXED: Normalize premium plan status from dates
 * Should be called before `isPremiumEntitled` to ensure status is correct
 * This matches the logic in premiumWallet.js
 */
function normalizePremiumPlanStatus(user) {
  if (!user || !user.premiumPlan) {
    return user;
  }

  const now = new Date();
  const plan = user.premiumPlan;
  const expiryDate = plan.expiryDate ? new Date(plan.expiryDate) : null;
  const graceUntil = plan.graceUntil ? new Date(plan.graceUntil) : null;

  // Recalculate status from dates (dates are source of truth)
  if (expiryDate && expiryDate > now) {
    plan.status = "active";
  } else if (graceUntil && graceUntil > now) {
    plan.status = "grace";
  } else {
    plan.status = "expired";
  }

  return user;
}

function requirePremium(featureKey) {
  return async function premiumFeatureGuard(req, res, next) {
    try {
      const user = await User.findOne({ phone: req.user.phone }).select("phone premiumPlan");
      
      // ✅ FIXED: Normalize premium plan status before checking
      normalizePremiumPlanStatus(user);
      
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
  normalizePremiumPlanStatus,
  requirePremium,
};
