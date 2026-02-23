const User = require("../models/User");

function isPremiumEntitled(user) {
  if (!user || !user.premiumPlan) return false;
  const { type, expiryDate, graceUntil, status } = user.premiumPlan;
  if (!type || type === "free") return false;

  const now = new Date();
  const expiryOk = expiryDate && new Date(expiryDate) > now;
  const graceOk = graceUntil && new Date(graceUntil) > now;
  const statusOk = !status || status === "active" || status === "grace";
  return statusOk && (expiryOk || graceOk);
}

async function requireActivePremium(req, res, next) {
  try {
    const user = await User.findOne({ phone: req.user.phone }).select("phone premiumPlan");
    if (!user || !isPremiumEntitled(user)) {
      return res.status(403).json({
        success: false,
        message: "Active premium subscription required",
      });
    }

    req.premiumEntitlement = {
      type: user.premiumPlan.type,
      expiryDate: user.premiumPlan.expiryDate,
      graceUntil: user.premiumPlan.graceUntil || null,
      status: user.premiumPlan.status || "active",
    };
    return next();
  } catch (err) {
    return res.status(500).json({ success: false, message: "Premium entitlement check failed" });
  }
}

module.exports = {
  isPremiumEntitled,
  requireActivePremium,
};
