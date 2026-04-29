export function isPremiumPlanActive(plan: any): boolean {
  if (!plan) return false;

  const type = String(plan.type || plan.premiumPlan || "").toLowerCase();
  if (!type || type === "free") return false;

  const now = new Date();
  const expiryDate = plan.expiryDate ? new Date(plan.expiryDate) : null;
  const graceUntil = plan.graceUntil ? new Date(plan.graceUntil) : null;
  const status = String(plan.status || "").toLowerCase();

  if (expiryDate && expiryDate > now) return true;
  if (graceUntil && graceUntil > now) return true;

  return status === "active" || status === "grace";
}

export function mergePremiumPlan(currentPlan: any, patch: any = {}) {
  return {
    ...(currentPlan || {}),
    ...patch,
  };
}
