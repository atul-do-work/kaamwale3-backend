const Wallet = require("../models/Wallet");
const User = require("../models/User");
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
