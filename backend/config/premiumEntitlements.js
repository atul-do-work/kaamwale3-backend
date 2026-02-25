const DEFAULT_PLAN = "free";

const PREMIUM_ENTITLEMENTS = {
  free: {
    canViewLeaderboard: false,
    canBulkHire: false,
    canMultiDayPost: false,
    prioritySupport: false,
  },
  basic: {
    canViewLeaderboard: true,
    canBulkHire: true,
    canMultiDayPost: true,
    prioritySupport: false,
  },
  pro: {
    canViewLeaderboard: true,
    canBulkHire: true,
    canMultiDayPost: true,
    prioritySupport: true,
  },
};

function getPlanEntitlements(planType) {
  const normalized = String(planType || DEFAULT_PLAN).toLowerCase();
  return PREMIUM_ENTITLEMENTS[normalized] || PREMIUM_ENTITLEMENTS[DEFAULT_PLAN];
}

module.exports = {
  PREMIUM_ENTITLEMENTS,
  getPlanEntitlements,
};
