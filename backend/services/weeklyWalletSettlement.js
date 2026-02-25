const Wallet = require("../models/Wallet");
const User = require("../models/User");
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

function computeClosedWeekNet(walletDoc, closedStart, closedEndExclusive) {
  const txs = Array.isArray(walletDoc?.transactions) ? walletDoc.transactions : [];
  let earnings = 0;
  let deducted = 0;

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

    if (tx.type === "payment" || isIncentive) {
      earnings += amount;
      continue;
    }
    if (tx.type === "withdraw") {
      const fromPocket = String(tx?.metadata?.balanceSource || "") === "pocket";
      if (!fromPocket) deducted += amount;
    }
  }

  return Math.max(0, earnings - deducted);
}

async function runWeeklyWalletSettlement(now = new Date(), options = {}) {
  const io = options?.io || null;
  const { start: currentStart } = getWeekBounds(now);
  const closedStart = new Date(currentStart.getTime() - PAYOUT_CYCLE_MS);
  const closedEndExclusive = new Date(currentStart);

  // Process wallets that had financial activity in the closed cycle.
  const candidateWallets = await Wallet.find({
    availableBalance: { $gt: 0 },
    transactions: { $elemMatch: { date: { $gte: closedStart, $lt: closedEndExclusive } } },
  }).select("phone availableBalance balance transactions");

  if (!candidateWallets.length) {
    return { settledWorkers: 0, settledAmount: 0, cycleStart: closedStart, cycleEnd: new Date(closedEndExclusive.getTime() - 1) };
  }

  const phones = candidateWallets.map((w) => w.phone);
  const workerUsers = await User.find({
    phone: { $in: phones },
    role: { $regex: /^worker$/i },
  }).select("phone");
  const workerPhones = new Set(workerUsers.map((u) => u.phone));

  let settledWorkers = 0;
  let settledAmount = 0;

  for (const wallet of candidateWallets) {
    if (!workerPhones.has(wallet.phone)) continue;

    const currentAvailable = Number(wallet.availableBalance ?? wallet.balance ?? 0);
    if (!Number.isFinite(currentAvailable) || currentAvailable <= 0) continue;

    const closedWeekNet = computeClosedWeekNet(wallet, closedStart, closedEndExclusive);
    if (!Number.isFinite(closedWeekNet) || closedWeekNet <= 0) continue;

    const settleAmount = Math.min(currentAvailable, closedWeekNet);
    if (settleAmount <= 0) continue;

    const idempotencyKey = `weekly_settlement:${wallet.phone}:${closedStart.toISOString()}:${closedEndExclusive.toISOString()}`;
    const openingBalance = currentAvailable;
    const closingBalance = openingBalance - settleAmount;

    const updatedWallet = await Wallet.findOneAndUpdate(
      {
        phone: wallet.phone,
        availableBalance: { $gte: settleAmount },
        "transactions.idempotencyKey": { $ne: idempotencyKey },
      },
      {
        $inc: { availableBalance: -settleAmount, balance: -settleAmount },
        $push: {
          transactions: {
            type: "payout_settlement",
            amount: settleAmount,
            date: new Date(),
            description: `Weekly payout settlement (${closedStart.toISOString().slice(0, 10)} to ${new Date(
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
              basedOn: "weekly_earnings_net_of_withdrawals",
            },
          },
        },
      },
      { new: true }
    );

    if (!updatedWallet) continue;

    settledWorkers += 1;
    settledAmount += settleAmount;

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
        },
      }
    );
  }

  return {
    settledWorkers,
    settledAmount,
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
