const Wallet = require("../models/Wallet");
const CancellationLog = require("../models/CancellationLog");
const ReconciliationRun = require("../models/ReconciliationRun");
const { sendOpsAlert } = require("../utils/opsAlert");

function toStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function runCancellationReconciliation() {
  const now = new Date();
  const runDate = toStartOfDay(now);
  const lookbackDays = Number(process.env.CANCEL_RECON_LOOKBACK_DAYS || 7);
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const run = await ReconciliationRun.create({
    runType: "daily",
    provider: "internal",
    runDate,
    startedAt: now,
    status: "processing",
  });

  try {
    const cancellations = await CancellationLog.find({
      cancelledAt: { $gte: since },
      cancelledBy: "contractor",
      $or: [{ refundAmount: { $gt: 0 } }, { cancellationFee: { $gt: 0 } }],
    }).select("_id jobId contractorPhone refundAmount cancellationFee cancelledAt");

    const mismatches = [];

    for (const row of cancellations) {
      const wallet = await Wallet.findOne({ phone: row.contractorPhone }).select("transactions");
      const txs = Array.isArray(wallet?.transactions) ? wallet.transactions : [];

      const hasRefund =
        Number(row.refundAmount || 0) <= 0 ||
        txs.some((t) => {
          const amount = Number(t?.amount || 0);
          const reason = String(t?.metadata?.reason || "");
          const cancellationId = String(t?.metadata?.cancellationId || "");
          const jobId = String(t?.metadata?.jobId || "");
          return (
            t?.type === "refund" &&
            amount === Number(row.refundAmount || 0) &&
            reason === "job_cancel_refund" &&
            (cancellationId === String(row._id) || jobId === String(row.jobId))
          );
        });

      if (!hasRefund) {
        mismatches.push({
          entityType: "wallet_tx",
          localId: String(row._id),
          providerId: String(row.jobId),
          issue: "missing_cancellation_refund_wallet_tx",
        });
      }

      const hasFeeDeduction =
        Number(row.cancellationFee || 0) <= 0 ||
        txs.some((t) => {
          const amount = Number(t?.amount || 0);
          const reason = String(t?.metadata?.reason || "");
          const cancellationId = String(t?.metadata?.cancellationId || "");
          const jobId = String(t?.metadata?.jobId || "");
          return (
            t?.type === "job_post_fee" &&
            amount === Number(row.cancellationFee || 0) &&
            reason === "job_cancel_fee" &&
            (cancellationId === String(row._id) || jobId === String(row.jobId))
          );
        });

      if (!hasFeeDeduction) {
        mismatches.push({
          entityType: "wallet_tx",
          localId: String(row._id),
          providerId: String(row.jobId),
          issue: "missing_cancellation_fee_wallet_tx",
        });
      }
    }

    run.summary = {
      ordersChecked: cancellations.length,
      paymentsChecked: 0,
      payoutsChecked: 0,
      mismatchesFound: mismatches.length,
      repairedCount: 0,
    };
    run.mismatches = mismatches.slice(0, 5000);
    run.completedAt = new Date();
    run.status = "completed";
    await run.save();

    if (mismatches.length > 0) {
      await sendOpsAlert("Cancellation reconciliation mismatches detected", {
        runId: String(run._id),
        mismatchesFound: mismatches.length,
        sample: mismatches.slice(0, 10),
      });
    }

    return {
      runId: String(run._id),
      cancellationsChecked: cancellations.length,
      mismatchesFound: mismatches.length,
    };
  } catch (err) {
    run.status = "failed";
    run.completedAt = new Date();
    run.notes = err && err.message ? err.message : "Unknown cancellation reconciliation error";
    await run.save();
    await sendOpsAlert("Cancellation reconciliation failed", {
      runId: String(run._id),
      error: err && err.message,
    });
    throw err;
  }
}

function startCancellationReconciliationScheduler() {
  const enabled = String(process.env.CANCEL_RECON_ENABLED || "true") === "true";
  if (!enabled) return;

  const intervalMs = Number(process.env.CANCEL_RECON_INTERVAL_MS || 24 * 60 * 60 * 1000);
  setInterval(async () => {
    try {
      const result = await runCancellationReconciliation();
      console.log(
        `[cancel-recon] completed runId=${result.runId} checked=${result.cancellationsChecked} mismatches=${result.mismatchesFound}`
      );
    } catch (err) {
      console.error("[cancel-recon] failed:", err && err.message);
    }
  }, intervalMs);

  console.log(`[cancel-recon] scheduler started (${intervalMs}ms)`);
}

module.exports = {
  runCancellationReconciliation,
  startCancellationReconciliationScheduler,
};

