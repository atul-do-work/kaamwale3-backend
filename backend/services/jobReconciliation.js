const Job = require("../models/Jobs");
const Wallet = require("../models/Wallet");
const WorkerEarnings = require("../models/WorkerEarnings");
const Withdrawal = require("../models/Withdrawal");
const ReconciliationRun = require("../models/ReconciliationRun");
const { sendOpsAlert } = require("../utils/opsAlert");

function toStartOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

async function runJobReconciliation() {
  const now = new Date();
  const runDate = toStartOfDay(now);
  const lookbackDays = Number(process.env.JOB_RECON_LOOKBACK_DAYS || 7);
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const run = await ReconciliationRun.create({
    runType: "daily",
    provider: "razorpay",
    runDate,
    startedAt: now,
    status: "processing",
  });

  try {
    const mismatches = [];
    const paidJobs = await Job.find({
      paymentStatus: "paid",
      paymentTime: { $gte: since },
    }).select("_id acceptedBy acceptedWorkers amount paymentTime");

    for (const job of paidJobs) {
      // Check single job payments
      if (job.acceptedBy) {
        const earning = await WorkerEarnings.findOne({ jobId: job._id, workerPhone: job.acceptedBy }).select("_id");
        if (!earning) {
          mismatches.push({
            entityType: "payment",
            localId: job._id.toString(),
            issue: "missing_worker_earning",
            workerPhone: job.acceptedBy,
          });
        }

        const wallet = await Wallet.findOne({
          phone: job.acceptedBy,
          transactions: { $elemMatch: { type: "payment", jobId: job._id } },
        }).select("_id");

        if (!wallet) {
          mismatches.push({
            entityType: "wallet_tx",
            localId: job._id.toString(),
            issue: "missing_wallet_payment_transaction",
            workerPhone: job.acceptedBy,
          });
        }
      }

      // Check bulk job payments
      if (Array.isArray(job.acceptedWorkers)) {
        for (const worker of job.acceptedWorkers) {
          if (!worker?.phone || worker.paymentStatus !== "paid") continue;

          const earning = await WorkerEarnings.findOne({ jobId: job._id, workerPhone: worker.phone }).select("_id");
          if (!earning) {
            mismatches.push({
              entityType: "payment",
              localId: job._id.toString(),
              issue: "missing_worker_earning_bulk",
              workerPhone: worker.phone,
            });
          }

          const wallet = await Wallet.findOne({
            phone: worker.phone,
            transactions: { $elemMatch: { type: "payment", jobId: job._id } },
          }).select("_id");

          if (!wallet) {
            mismatches.push({
              entityType: "wallet_tx",
              localId: job._id.toString(),
              issue: "missing_wallet_payment_transaction_bulk",
              workerPhone: worker.phone,
            });
          }
        }
      }
    }

    const payoutRows = await Withdrawal.find({
      status: { $in: ["success", "processing"] },
      createdAt: { $gte: since },
    }).select("_id status providerPayoutId");

    for (const row of payoutRows) {
      if (row.status === "success" && !row.providerPayoutId) {
        mismatches.push({
          entityType: "payout",
          localId: row._id.toString(),
          issue: "success_without_provider_payout_id",
        });
      }
    }

    run.summary = {
      ordersChecked: 0,
      paymentsChecked: paidJobs.length,
      payoutsChecked: payoutRows.length,
      mismatchesFound: mismatches.length,
      repairedCount: 0,
    };
    run.mismatches = mismatches.slice(0, 5000);
    run.completedAt = new Date();
    run.status = "completed";
    await run.save();

    if (mismatches.length > 0) {
      await sendOpsAlert("Job reconciliation mismatches detected", {
        runId: run._id.toString(),
        mismatchesFound: mismatches.length,
        sample: mismatches.slice(0, 10),
      });
    }

    return {
      runId: run._id.toString(),
      paymentsChecked: paidJobs.length,
      payoutsChecked: payoutRows.length,
      mismatchesFound: mismatches.length,
    };
  } catch (err) {
    run.status = "failed";
    run.completedAt = new Date();
    run.notes = err && err.message ? err.message : "Unknown reconciliation error";
    await run.save();
    await sendOpsAlert("Job reconciliation failed", {
      runId: run._id.toString(),
      error: err && err.message,
    });
    throw err;
  }
}

function startJobReconciliationScheduler() {
  const enabled = String(process.env.JOB_RECON_ENABLED || "true") === "true";
  if (!enabled) return;

  const intervalMs = Number(process.env.JOB_RECON_INTERVAL_MS || 24 * 60 * 60 * 1000);
  setInterval(async () => {
    try {
      const result = await runJobReconciliation();
      console.log(
        `[job-recon] completed runId=${result.runId} payments=${result.paymentsChecked} payouts=${result.payoutsChecked} mismatches=${result.mismatchesFound}`
      );
    } catch (err) {
      console.error("[job-recon] failed:", err && err.message);
    }
  }, intervalMs);

  console.log(`[job-recon] scheduler started (${intervalMs}ms)`);
}

module.exports = {
  runJobReconciliation,
  startJobReconciliationScheduler,
};
