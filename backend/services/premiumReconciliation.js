const Wallet = require("../models/Wallet");
const User = require("../models/User");
const ActivityLog = require("../models/ActivityLog");
const PremiumSubscription = require("../models/PremiumSubscription");
const ReconciliationRun = require("../models/ReconciliationRun");
const { sendOpsAlert } = require("../utils/opsAlert");

function toStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function runPremiumReconciliation() {
  const now = new Date();
  const runDate = toStartOfDay(now);
  const lookbackDays = Number(process.env.PREMIUM_RECON_LOOKBACK_DAYS || 30);
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const run = await ReconciliationRun.create({
    runType: "daily",
    provider: "internal_premium",
    runDate,
    startedAt: now,
    status: "processing",
  });

  try {
    const mismatches = [];

    const wallets = await Wallet.find({
      "transactions.type": "premium_subscription",
      "transactions.date": { $gte: since },
    }).select("phone transactions");

    let chargesChecked = 0;
    for (const wallet of wallets) {
      const premiumCharges = (wallet.transactions || []).filter(
        (tx) => tx.type === "premium_subscription" && tx.date && new Date(tx.date) >= since
      );

      for (const tx of premiumCharges) {
        chargesChecked += 1;
        const subId = tx.metadata && tx.metadata.subscriptionId;
        if (!subId) {
          mismatches.push({
            entityType: "subscription",
            localId: wallet.phone,
            issue: "premium_charge_missing_subscription_id",
          });
          continue;
        }

        const sub = await PremiumSubscription.findOne({ subscriptionId: subId }).select("_id userPhone status source walletTxnId");
        if (!sub) {
          mismatches.push({
            entityType: "subscription",
            localId: subId,
            issue: "missing_subscription_ledger",
          });
        } else if (sub.userPhone !== wallet.phone) {
          mismatches.push({
            entityType: "subscription",
            localId: subId,
            issue: "wallet_phone_subscription_phone_mismatch",
          });
        } else if (sub.source === "wallet" && !sub.walletTxnId) {
          mismatches.push({
            entityType: "subscription",
            localId: subId,
            issue: "wallet_source_subscription_missing_wallet_txn_id",
          });
        }
      }
    }

    const activeSubs = await PremiumSubscription.find({
      isCurrent: true,
      status: { $in: ["active", "grace"] },
      $or: [{ expiryDate: { $gt: now } }, { graceUntil: { $gt: now } }],
    }).select("subscriptionId userPhone");

    for (const sub of activeSubs) {
      const user = await User.findOne({ phone: sub.userPhone }).select("phone premiumPlan");
      if (!user) {
        mismatches.push({
          entityType: "subscription",
          localId: sub.subscriptionId,
          issue: "active_subscription_missing_user",
        });
        continue;
      }

      if (!user.premiumPlan || user.premiumPlan.type === "free") {
        mismatches.push({
          entityType: "subscription",
          localId: sub.subscriptionId,
          issue: "active_subscription_user_entitlement_missing",
        });
      }
    }

    // Check for subscriptions expiring soon (send renewal reminders)
    const subscriptionsExpiringSoon = await PremiumSubscription.find({
      status: "active",
      expiryDate: {
        $gt: now,
        $lte: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000) // Expiring in next 3 days
      }
    }).select("subscriptionId userPhone expiryDate plan");

    for (const sub of subscriptionsExpiringSoon) {
      const user = await User.findOne({ phone: sub.userPhone }).select("fcmToken");
      if (user?.fcmToken) {
        // Send renewal reminder notification
        try {
          await sendOpsAlert(`Premium subscription expiring soon for ${sub.userPhone}`, {
            subscriptionId: sub.subscriptionId,
            expiryDate: sub.expiryDate,
            plan: sub.plan,
            daysLeft: Math.ceil((sub.expiryDate - now) / (24 * 60 * 60 * 1000))
          });
        } catch (err) {
          console.warn('Failed to send renewal reminder:', err);
        }
      }
    }

    for (const sub of subscriptionsNeedingRenewal) {
      // ✅ FIXED: Basic renewal logic - extend subscription by original duration
      const originalSub = await PremiumSubscription.findOne({
        subscriptionId: sub.subscriptionId
      }).select("plan startAt endAt");

      if (originalSub) {
        const durationMs = originalSub.endAt - originalSub.startAt;
        const newExpiry = new Date(sub.renewalAt.getTime() + durationMs);
        const newGraceUntil = new Date(newExpiry.getTime() + 7 * 24 * 60 * 60 * 1000);

        // Update subscription
        await PremiumSubscription.updateOne(
          { subscriptionId: sub.subscriptionId },
          {
            $set: {
              expiryDate: newExpiry,
              graceUntil: newGraceUntil,
              renewalAt: newExpiry,
              status: "active"
            }
          }
        );

        // Update user premium plan
        await User.updateOne(
          { phone: sub.userPhone },
          {
            $set: {
              "premiumPlan.expiryDate": newExpiry,
              "premiumPlan.graceUntil": newGraceUntil,
              "premiumPlan.renewalAt": newExpiry,
              "premiumPlan.status": "active"
            }
          }
        );

        await ActivityLog.create({
          userId: sub.userPhone,
          phone: sub.userPhone,
          action: "premium_renewed",
          description: `Premium subscription auto-renewed`,
          status: "success",
          metadata: {
            subscriptionId: sub.subscriptionId,
            newExpiryDate: newExpiry,
            autoRenew: true
          },
        });
      }
    }

    for (const user of premiumUsers) {
      const plan = user.premiumPlan || {};
      const previousStatus = String(plan.status || "inactive").toLowerCase();
      const expiryDate = plan.expiryDate ? new Date(plan.expiryDate) : null;
      const graceUntil = plan.graceUntil ? new Date(plan.graceUntil) : null;

      let nextStatus = previousStatus;
      if (graceUntil && graceUntil > now && (!expiryDate || expiryDate <= now)) {
        nextStatus = "grace";
      } else if (expiryDate && expiryDate > now) {
        nextStatus = "active";
      } else if (graceUntil && graceUntil <= now) {
        nextStatus = "expired";
      } else {
        nextStatus = "expired";
      }

      if (nextStatus === previousStatus) continue;

      // ✅ FIXED: Update both user and subscription status
      user.premiumPlan.status = nextStatus;

      // ✅ FIXED: Set/clear graceUntil based on status transitions
      if (nextStatus === "active" && !user.premiumPlan.graceUntil) {
        // If becoming active and no grace period set, set one
        user.premiumPlan.graceUntil = new Date(expiryDate.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else if (nextStatus === "expired") {
        // Clear grace period when fully expired
        user.premiumPlan.graceUntil = null;
      }

      await user.save();

      const transitionAction =
        nextStatus === "active"
          ? "premium_activated"
          : nextStatus === "grace"
            ? "premium_grace_started"
            : "premium_expired";
      const transitionDescription =
        nextStatus === "active"
          ? "Premium activated during reconciliation"
          : nextStatus === "grace"
            ? "Premium moved to grace period"
            : "Premium expired";

      await ActivityLog.create({
        userId: user.phone,
        phone: user.phone,
        action: transitionAction,
        description: transitionDescription,
        status: "success",
        metadata: {
          previousStatus,
          nextStatus,
          expiryDate: plan.expiryDate || null,
          graceUntil: plan.graceUntil || null,
          source: "premium_reconciliation",
        },
      });
    }

    run.summary = {
      ordersChecked: 0,
      paymentsChecked: chargesChecked,
      payoutsChecked: activeSubs.length,
      mismatchesFound: mismatches.length,
      repairedCount: 0,
    };
    run.mismatches = mismatches.slice(0, 5000);
    run.completedAt = new Date();
    run.status = "completed";
    await run.save();

    if (mismatches.length > 0) {
      await sendOpsAlert("Premium reconciliation mismatches detected", {
        runId: run._id.toString(),
        mismatchesFound: mismatches.length,
        sample: mismatches.slice(0, 10),
      });
    }

    return {
      runId: run._id.toString(),
      chargesChecked,
      activeSubscriptionsChecked: activeSubs.length,
      mismatchesFound: mismatches.length,
    };
  } catch (err) {
    run.status = "failed";
    run.completedAt = new Date();
    run.notes = err && err.message ? err.message : "Unknown premium reconciliation error";
    await run.save();
    await sendOpsAlert("Premium reconciliation failed", {
      runId: run._id.toString(),
      error: err && err.message,
    });
    throw err;
  }
}

function startPremiumReconciliationScheduler() {
  const enabled = String(process.env.PREMIUM_RECON_ENABLED || "true") === "true";
  if (!enabled) return;

  const intervalMs = Number(process.env.PREMIUM_RECON_INTERVAL_MS || 24 * 60 * 60 * 1000);
  setInterval(async () => {
    try {
      const result = await runPremiumReconciliation();
      console.log(
        `[premium-recon] completed runId=${result.runId} charges=${result.chargesChecked} activeSubs=${result.activeSubscriptionsChecked} mismatches=${result.mismatchesFound}`
      );
    } catch (err) {
      console.error("[premium-recon] failed:", err && err.message);
    }
  }, intervalMs);

  console.log(`[premium-recon] scheduler started (${intervalMs}ms)`);
}

module.exports = {
  runPremiumReconciliation,
  startPremiumReconciliationScheduler,
};
