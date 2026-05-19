const Wallet = require("../models/Wallet");
const User = require("../models/User");
const PayoutBatch = require("../models/PayoutBatch");
const WorkerEarnings = require("../models/WorkerEarnings");

const PAYOUT_CYCLE_ANCHOR_ISO = process.env.PAYOUT_CYCLE_ANCHOR_ISO || "2025-02-25T00:00:00+05:30";
const PAYOUT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;

function getWeekBounds(now = new Date()) {
  const anchor = new Date(PAYOUT_CYCLE_ANCHOR_ISO);
  if (Number.isNaN(anchor.getTime())) {
    const fallbackStart = new Date(now);
    const day = fallbackStart.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    fallbackStart.setDate(fallbackStart.getDate() + diff);
    fallbackStart.setHours(0, 0, 0, 0);
    const fallbackEnd = new Date(fallbackStart.getTime() + PAYOUT_CYCLE_MS);
    return { start: fallbackStart, endExclusive: fallbackEnd };
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  const cycleIndex = Math.floor(elapsedMs / PAYOUT_CYCLE_MS);
  const cycleStartMs = anchor.getTime() + cycleIndex * PAYOUT_CYCLE_MS;
  const start = new Date(cycleStartMs);
  const endExclusive = new Date(cycleStartMs + PAYOUT_CYCLE_MS);
  return { start, endExclusive };
}

function getIsoWeekNumber(date = new Date()) {
  const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNumber = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNumber);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  return Math.ceil((((tmp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function getPayoutWeekInfo(date = new Date()) {
  const { start, endExclusive } = getWeekBounds(date);
  return {
    year: start.getUTCFullYear(),
    week: getIsoWeekNumber(start),
    startDate: start,
    endDate: new Date(endExclusive.getTime() - 1),
  };
}

function computeClosedWeekSummary(walletDoc, closedStart, closedEndExclusive) {
  const txs = Array.isArray(walletDoc?.transactions) ? walletDoc.transactions : [];
  let totalEarnings = 0;
  let availableEarnings = 0;
  let pocketEarnings = 0;
  let deductions = 0;

  for (const tx of txs) {
    const txDate = tx?.date ? new Date(tx.date) : null;
    if (!txDate || Number.isNaN(txDate.getTime())) continue;
    if (txDate < closedStart || txDate >= closedEndExclusive) continue;

    const amount = Number(tx.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const isIncentive =
      tx.type === "incentive_reward" ||
      tx.type === "incentive" ||
      String(tx?.metadata?.source || "").toLowerCase() === "incentive";
    const isReferral =
      tx.type === "referral" ||
      tx.type === "referral_reward" ||
      String(tx?.metadata?.source || "").toLowerCase() === "referral";
    const balanceType = String(tx?.metadata?.balanceType || "").toLowerCase();

    if (tx.type === "payment" || isIncentive || (isReferral && balanceType !== "pocket" && balanceType !== "available")) {
      availableEarnings += amount;
      totalEarnings += amount;
      continue;
    }

    const isAvailableReferral = isReferral && balanceType === "available";
    if (isAvailableReferral) {
      availableEarnings += amount;
      totalEarnings += amount;
      continue;
    }

    const isPocketCredit =
      tx.type === "cash_deposit" ||
      tx.type === "pocket_deposit" ||
      (isReferral && balanceType === "pocket") ||
      (tx.type === "deposit" && balanceType === "pocket");
    if (isPocketCredit) {
      pocketEarnings += amount;
      totalEarnings += amount;
      continue;
    }
    if (tx.type === "withdraw") {
      const fromPocket = String(tx?.metadata?.balanceSource || "") === "pocket";
      if (!fromPocket) deductions += amount;
    }
  }

  return {
    totalEarnings,
    availableEarnings,
    pocketEarnings,
    deductions,
    netAmount: Math.max(0, totalEarnings - deductions),
  };
}

function getWorkerWeekTransactions(walletDoc, closedStart, closedEndExclusive) {
  const txs = Array.isArray(walletDoc?.transactions) ? walletDoc.transactions : [];
  return txs
    .filter((tx) => {
      const txDate = tx?.date ? new Date(tx.date) : null;
      if (!txDate || Number.isNaN(txDate.getTime())) return false;
      if (txDate < closedStart || txDate >= closedEndExclusive) return false;
      return Boolean(Number(tx.amount || 0) > 0);
    })
    .map((tx) => ({
      type: tx.type,
      amount: tx.amount,
      date: tx.date,
      description: tx.description,
      jobId: tx.jobId || null,
      provider: tx.provider || null,
      providerEventId: tx.providerEventId || null,
      metadata: tx.metadata || null,
    }));
}

async function runWeeklyWalletSettlement(now = new Date(), options = {}) {
  const io = options?.io || null;
  const { start: currentStart } = getWeekBounds(now);
  const closedStart = new Date(currentStart.getTime() - PAYOUT_CYCLE_MS);
  const closedEndExclusive = new Date(currentStart);

  // Process all active worker wallets with a positive balance.
  const candidateWallets = await Wallet.find({
    $or: [{ availableBalance: { $gt: 0 } }, { pocketBalance: { $gt: 0 } }],
  }).select("phone availableBalance pocketBalance balance transactions");

  if (!candidateWallets.length) {
    return { settledWorkers: 0, settledAmount: 0, cycleStart: closedStart, cycleEnd: new Date(closedEndExclusive.getTime() - 1) };
  }

  const phones = candidateWallets.map((w) => w.phone);
  const workerUsers = await User.find({
    phone: { $in: phones },
    role: { $regex: /^worker$/i },
  }).select("phone name");
  const workerMap = new Map(workerUsers.map((u) => [u.phone, u]));
  const workerPhones = new Set(workerUsers.map((u) => u.phone));

  let settledWorkers = 0;
  let settledAmount = 0;
  const batchWorkers = [];

  for (const wallet of candidateWallets) {
    if (!workerPhones.has(wallet.phone)) continue;

    const availableSettle = Math.max(0, Number(wallet.availableBalance ?? wallet.balance ?? 0));
    const pocketSettle = Math.max(0, Number(wallet.pocketBalance ?? 0));
    const settleAmount = availableSettle + pocketSettle;
    if (settleAmount <= 0) continue;

    const idempotencyKey = `weekly_settlement:${wallet.phone}:${closedStart.toISOString()}:${closedEndExclusive.toISOString()}`;
    const openingBalance = availableSettle + pocketSettle;
    const closingBalance = 0;
    const settlementTransaction = {
      type: "payout_settlement",
      amount: settleAmount,
      date: new Date(),
      description: `Weekly wallet reset settlement (${closedStart.toISOString().slice(0, 10)} to ${new Date(
        closedEndExclusive.getTime() - 1
      ).toISOString().slice(0, 10)})`,
      status: "completed",
      openingBalance,
      closingBalance,
      source: "scheduler",
      provider: "internal",
      providerEventId: idempotencyKey,
      idempotencyKey,
      metadata: {
        settlementWindowStart: closedStart,
        settlementWindowEnd: new Date(closedEndExclusive.getTime() - 1),
        basedOn: "weekly_wallet_reset",
        availableSettle,
        pocketSettle,
      },
    };

    const update = { $inc: {}, $push: { transactions: settlementTransaction } };

    if (availableSettle > 0) {
      update.$inc.availableBalance = -availableSettle;
      update.$inc.balance = -availableSettle;
    }
    if (pocketSettle > 0) {
      update.$inc.pocketBalance = -pocketSettle;
    }

    const query = {
      phone: wallet.phone,
      "transactions.idempotencyKey": { $ne: idempotencyKey },
    };
    if (availableSettle > 0) query.availableBalance = { $gte: availableSettle };
    if (pocketSettle > 0) query.pocketBalance = { $gte: pocketSettle };

    const updatedWallet = await Wallet.findOneAndUpdate(query, update, { new: true });
    if (!updatedWallet) continue;

    settledWorkers += 1;
    settledAmount += settleAmount;

    const workerName = String(workerMap.get(wallet.phone)?.name || '');
    batchWorkers.push({
      workerPhone: wallet.phone,
      workerName,
      earningsAmount: settleAmount,
      deductions: 0,
      netAmount: settleAmount,
      status: 'pending',
      transactionId: idempotencyKey,
      bankDetails: {},
      transactions: [settlementTransaction],
    });

    if (io) {
      io.to(wallet.phone).emit("walletUpdated", {
        phone: wallet.phone,
        type: "payout_settlement",
        amount: settleAmount,
        balance: Number(updatedWallet.balance || 0),
        availableBalance: Number(updatedWallet.availableBalance ?? updatedWallet.balance ?? 0),
        pocketBalance: Number(updatedWallet.pocketBalance || 0),
        message: `Weekly settlement processed: Rs ${settleAmount}`,
      });
    }

    await WorkerEarnings.updateMany(
      {
        workerPhone: wallet.phone,
        earnedAt: { $gte: closedStart, $lt: closedEndExclusive },
        status: { $in: ["earned", "payout_requested"] },
      },
      {
        $set: {
          status: "payout_completed",
          payoutCompletedAt: new Date(),
          provider: "internal",
          source: "reconciliation",
          providerEventId: idempotencyKey,
          payoutDetails: {
            batchId,
            transactionId: idempotencyKey,
            settlementWindowStart: closedStart,
            settlementWindowEnd: new Date(closedEndExclusive.getTime() - 1),
          },
        },
      }
    );
  }

  const payoutWeek = getPayoutWeekInfo(closedStart);
  const batchId = `PAYOUT_${payoutWeek.year}_W${String(payoutWeek.week).padStart(2, '0')}`;
  let batchCreated = false;

  if (batchWorkers.length > 0) {
    const existingBatch = await PayoutBatch.findOne({ batchId });
    if (!existingBatch) {
      await PayoutBatch.create({
        batchId,
        payoutWeek,
        status: 'pending',
        totalAmount: batchWorkers.reduce((sum, item) => sum + Number(item.netAmount || 0), 0),
        totalEarnings: batchWorkers.reduce((sum, item) => sum + Number(item.earningsAmount || 0), 0),
        totalDeductions: batchWorkers.reduce((sum, item) => sum + Number(item.deductions || 0), 0),
        totalWorkers: batchWorkers.length,
        workers: batchWorkers,
        processedBy: 'scheduler',
      });
      batchCreated = true;
    }
  }

  return {
    settledWorkers,
    settledAmount,
    batchId: batchWorkers.length > 0 ? batchId : null,
    batchCreated,
    cycleStart: closedStart,
    cycleEnd: new Date(closedEndExclusive.getTime() - 1),
  };
}

function startWeeklyWalletSettlementScheduler(options = {}) {
  const io = options?.io || null;
  const enabled = String(process.env.WEEKLY_SETTLEMENT_ENABLED || "true") === "true";
  if (!enabled) return;

  const intervalMs = Number(process.env.WEEKLY_SETTLEMENT_INTERVAL_MS || 60 * 60 * 1000);
  setInterval(async () => {
    try {
      const result = await runWeeklyWalletSettlement(new Date(), { io });
      if (result.settledWorkers > 0 || result.settledAmount > 0) {
        console.log(
          `[weekly-settlement] workers=${result.settledWorkers} amount=${result.settledAmount} cycle=${result.cycleStart.toISOString()}..${result.cycleEnd.toISOString()}`
        );
      }
    } catch (err) {
      console.error("[weekly-settlement] failed:", err && err.message);
    }
  }, intervalMs);

  console.log(`[weekly-settlement] scheduler started (${intervalMs}ms)`);
}

module.exports = {
  runWeeklyWalletSettlement,
  startWeeklyWalletSettlementScheduler,
};
