// routes/wallet.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const mongoose = require("mongoose");
const { authenticateToken } = require("../utils/auth");
const Wallet = require("../models/Wallet");
const User = require("../models/User");
const BankAccount = require("../models/BankAccount");
const Withdrawal = require("../models/Withdrawal");
const CashDeposit = require("../models/CashDeposit");
const Job = require("../models/Jobs");
const NotificationHistory = require("../models/NotificationHistory");
const { sendOpsAlert } = require("../utils/opsAlert");
const axios = require('axios');
const { getWeekBounds } = require('../utils/weekBounds');

async function createRazorpayPayout({ withdrawalId, amountPaise, payoutMethod, bankAccount, upiId, phone, loggerContext = {} }) {
  const key = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!key || !secret) throw new Error('Razorpay keys not configured for payouts');
  const sourceAccountNumber = String(process.env.RAZORPAY_PAYOUT_SOURCE_ACCOUNT || '').trim();
  if (!sourceAccountNumber) {
    throw new Error('RAZORPAY_PAYOUT_SOURCE_ACCOUNT not configured for payouts');
  }

  const url = 'https://api.razorpay.com/v1/payouts';

  // Build fund_account based on payout method
  let fund_account = null;
  if (payoutMethod === 'bank') {
    // bankAccount may store account number encrypted; prefer decrypted virtual
    const accountNumber = (bankAccount && (bankAccount.accountNumberDecrypted || bankAccount.accountNumber)) || '';
    if (!accountNumber) {
      throw new Error('Bank account number unavailable for payout');
    }
    fund_account = {
      account_type: 'bank_account',
      bank_account: {
        name: bankAccount.accountHolderName || '',
        ifsc: bankAccount.ifscCode || '',
        account_number: accountNumber,
      }
    };
  } else {
    fund_account = {
      account_type: 'vpa',
      vpa: { address: upiId }
    };
  }

  const payload = {
    account_number: sourceAccountNumber,
    amount: amountPaise,
    currency: 'INR',
    mode: payoutMethod === 'bank' ? (process.env.RAZORPAY_PAYOUT_MODE || 'IMPS') : 'UPI',
    purpose: 'payout',
    fund_account,
    narration: `Payout for withdrawal ${withdrawalId}`,
    reference_id: String(withdrawalId),
    queue_if_low_balance: true,
    notes: {
      withdrawalId: String(withdrawalId),
      phone: String(phone || '')
    }
  };

  // Include mandatory idempotency header per Razorpay docs
  const idempotencyKey = `payout_${String(withdrawalId)}`;
  const headers = {
    'X-Payout-Idempotency': idempotencyKey,
    'Content-Type': 'application/json'
  };

  const resp = await axios.post(url, payload, {
    auth: { username: key, password: secret },
    timeout: 15000,
    headers,
  });

  // Attach idempotency key to response for observability
  return { ...resp.data, idempotencyKey };
}

function mapRazorpayPayoutStatus(providerStatus) {
  const normalized = String(providerStatus || '').toLowerCase();
  if (['queued', 'pending', 'processing', 'scheduled', 'created', 'initiated'].includes(normalized)) {
    return 'processing';
  }
  if (normalized === 'processed') return 'success';
  if (['reversed', 'cancelled'].includes(normalized)) return 'reversed';
  if (['rejected', 'failed'].includes(normalized)) return 'failed';
  return 'processing';
}

function markWalletTransactionStatus(wallet, walletTransactionId, status, extraMetadata = null) {
  if (!wallet || !walletTransactionId) return false;
  const tx = (wallet.transactions || []).find((row) => String(row?._id || '') === String(walletTransactionId));
  if (!tx) return false;
  tx.status = status;
  if (extraMetadata) {
    tx.metadata = {
      ...(tx.metadata || {}),
      ...extraMetadata,
    };
  }
  return true;
}

function rollbackWithdrawalOnWallet({ wallet, withdrawal, rollbackEventId, description, source, providerEventId, metadata = {} }) {
  if (!wallet || !withdrawal) return false;
  const alreadyRolledBack = (wallet.transactions || []).some((tx) => tx.providerEventId === rollbackEventId);
  if (alreadyRolledBack) return false;

  const refundAvailable = Number(withdrawal.deductedFromAvailable || 0);
  const refundPocket = Number(withdrawal.deductedFromPocket || 0);
  const fallbackAmount = Number(withdrawal.amount || 0);
  const openingBalance = Number(wallet.availableBalance ?? wallet.balance ?? 0) + Number(wallet.pocketBalance ?? 0);

  if (refundAvailable > 0 || refundPocket > 0) {
    if (refundAvailable > 0) {
      wallet.availableBalance = Number(wallet.availableBalance ?? wallet.balance ?? 0) + refundAvailable;
      wallet.balance = Number(wallet.availableBalance || 0);
    }
    if (refundPocket > 0) {
      wallet.pocketBalance = Number(wallet.pocketBalance || 0) + refundPocket;
    }
  } else if (String(withdrawal.balanceSource || 'available') === 'pocket') {
    wallet.pocketBalance = Number(wallet.pocketBalance || 0) + fallbackAmount;
  } else {
    wallet.availableBalance = Number(wallet.availableBalance ?? wallet.balance ?? 0) + fallbackAmount;
    wallet.balance = Number(wallet.availableBalance || 0);
  }

  markWalletTransactionStatus(wallet, withdrawal.walletTransactionId, 'failed', {
    rollbackEventId,
    providerEventId,
    failureReason: metadata.failureReason || null,
  });

  const closingBalance = Number(wallet.availableBalance ?? wallet.balance ?? 0) + Number(wallet.pocketBalance ?? 0);
  wallet.transactions.push(
    appendAuditFields({
      type: 'refund',
      amount: fallbackAmount,
      openingBalance,
      closingBalance,
      status: 'completed',
      description,
      source,
      provider: 'razorpay',
      providerEventId: rollbackEventId,
      metadata,
    })
  );
  return true;
}

async function updateWalletTransactionStatus(phone, walletTransactionId, status, extraMetadata = null) {
  if (!phone || !walletTransactionId) return false;

  const existingWallet = await Wallet.findOne(
    { phone, 'transactions._id': walletTransactionId },
    { 'transactions.$': 1 }
  ).lean();

  const existingTx = existingWallet?.transactions?.[0];
  if (!existingTx) return false;

  const metadata = {
    ...(existingTx.metadata || {}),
    ...(extraMetadata || {}),
  };

  const updated = await Wallet.findOneAndUpdate(
    { phone, 'transactions._id': walletTransactionId },
    {
      $set: {
        'transactions.$.status': status,
        'transactions.$.metadata': metadata,
      }
    },
    { new: true }
  );

  return Boolean(updated);
}

async function rollbackWithdrawalOnWalletAtomic({ phone, withdrawal, rollbackEventId, description, source, providerEventId, metadata = {} }) {
  if (!phone || !withdrawal) return false;

  const duplicateRollback = await Wallet.exists({ phone, 'transactions.providerEventId': rollbackEventId });
  if (duplicateRollback) return false;

  const walletDoc = await Wallet.findOne(
    { phone, 'transactions._id': withdrawal.walletTransactionId },
    { availableBalance: 1, balance: 1, pocketBalance: 1, 'transactions.$': 1 }
  ).lean();

  if (!walletDoc || !walletDoc.transactions?.[0]) return false;

  const refundAvailable = Number(withdrawal.deductedFromAvailable || 0);
  const refundPocket = Number(withdrawal.deductedFromPocket || 0);
  const fallbackAmount = Number(withdrawal.amount || 0);
  const openingBalance = Number(walletDoc.availableBalance ?? walletDoc.balance ?? 0) + Number(walletDoc.pocketBalance ?? 0);

  const incOps = {};
  if (refundAvailable > 0) {
    incOps.availableBalance = refundAvailable;
    incOps.balance = refundAvailable;
  }
  if (refundPocket > 0) {
    incOps.pocketBalance = refundPocket;
  }

  const balanceSource = String(withdrawal.balanceSource || 'available').toLowerCase();
  if (!refundAvailable && !refundPocket) {
    if (balanceSource === 'pocket') {
      incOps.pocketBalance = fallbackAmount;
    } else {
      incOps.availableBalance = fallbackAmount;
      incOps.balance = fallbackAmount;
    }
  }

  const closingBalance = openingBalance + Object.values(incOps).reduce((sum, value) => sum + Number(value || 0), 0);
  const existingTx = walletDoc.transactions[0];
  const currentMetadata = existingTx.metadata || {};

  const update = {
    ...(Object.keys(incOps).length ? { $inc: incOps } : {}),
    $set: {
      'transactions.$.status': 'failed',
      'transactions.$.metadata': { ...currentMetadata, rollbackEventId, providerEventId, ...metadata },
    },
    $push: {
      transactions: appendAuditFields({
        type: 'refund',
        amount: fallbackAmount,
        openingBalance,
        closingBalance,
        status: 'completed',
        description,
        source,
        provider: 'razorpay',
        providerEventId: rollbackEventId,
        metadata,
      })
    }
  };

  const updated = await Wallet.findOneAndUpdate(
    {
      phone,
      'transactions._id': withdrawal.walletTransactionId,
      'transactions.providerEventId': { $ne: rollbackEventId },
    },
    update,
    { new: true }
  );

  return Boolean(updated);
}

const depositOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many deposit order attempts, please try again later." },
});

const depositVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many payment verification attempts, please try again later." },
});

const withdrawLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, message: "Too many withdrawal attempts, please try again later." },
});

function forceFreshJson(req, res) {
  // Prevent Express fresh-check from converting JSON responses to 304 for app clients.
  if (req?.headers) {
    delete req.headers["if-none-match"];
    delete req.headers["if-modified-since"];
  }
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
}

function appendAuditFields({
  type,
  amount,
  openingBalance,
  closingBalance,
  description,
  orderId = null,
  paymentId = null,
  status = "completed",
  source = "app",
  provider = "internal",
  providerEventId = null,
  metadata = null,
}) {
  return {
    type,
    amount,
    date: new Date(),
    description,
    orderId,
    paymentId,
    status,
    openingBalance,
    closingBalance,
    source,
    provider,
    providerEventId,
    metadata,
  };
}

function maskUpiId(upiId) {
  if (!upiId || typeof upiId !== "string" || !upiId.includes("@")) return "****";
  const [handle, provider] = upiId.split("@");
  if (!handle || !provider) return "****";
  const visible = handle.length <= 2 ? handle[0] || "*" : handle.slice(0, 2);
  return `${visible}***@${provider}`;
}

async function findPendingDuplicateWithdrawal({ phone, amount, payoutMethod, idempotencyKey }) {
  if (!phone) return null;
  const baseQuery = { phone, status: { $in: ["initiated", "processing"] } };
  if (idempotencyKey) {
    return Withdrawal.findOne({ ...baseQuery, idempotencyKey }).sort({ createdAt: -1 });
  }
  if (!Number.isFinite(amount) || !payoutMethod) return null;

  const recentThreshold = new Date(Date.now() - 10 * 60 * 1000);
  return Withdrawal.findOne({
    ...baseQuery,
    amount,
    payoutMethod,
    createdAt: { $gte: recentThreshold }
  }).sort({ createdAt: -1 });
}

function computeWorkerWeeklyMetrics(walletDoc, now = new Date()) {
  const { start, endExclusive } = getWeekBounds(now);
  const txs = Array.isArray(walletDoc?.transactions) ? walletDoc.transactions : [];
  let earnings = 0;
  let deducted = 0;
  let jobPayments = 0;
  let incentiveRewards = 0;
  let referralRewards = 0;
  let cashDeposits = 0;
  let pocketDeposits = 0;
  let otherCredits = 0;
  let totalWithdrawn = 0;
  let availableChange = 0;
  let pocketChange = 0;
  const dailyTotals = {};
  for (let i = 0; i < 7; i += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + i);
    const key = `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
    dailyTotals[key] = 0;
  }

  for (const tx of txs) {
    const txDate = tx?.date ? new Date(tx.date) : null;
    if (!txDate || Number.isNaN(txDate.getTime())) continue;
    if (txDate < start || txDate >= endExclusive) continue;

    const amount = Number(tx.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) continue;

    const normalizedType = String(tx.type || '').toLowerCase();
    const normalizedSource = String(tx?.metadata?.source || tx.source || '').toLowerCase();
    const balanceType = String(tx?.metadata?.balanceType || '').toLowerCase();
    const isJobPayment = normalizedType === 'payment';
    const isIncentive = normalizedType === 'incentive_reward' || normalizedSource === 'incentive';
    const isReferral = normalizedType === 'referral_reward' || normalizedType === 'referral' || normalizedSource === 'referral';
    const isCashDeposit = normalizedType === 'cash_deposit';
    const isPocketDeposit = normalizedType === 'pocket_deposit';
    const isDepositAvailable = normalizedType === 'deposit' && balanceType !== 'pocket';
    const isDepositPocket = normalizedType === 'deposit' && balanceType === 'pocket';
    const isPocketReferral = isReferral && balanceType === 'pocket';
    const isAvailableReferral = isReferral && balanceType !== 'pocket';
    const isEarning = isJobPayment || isIncentive || isReferral || isCashDeposit || isPocketDeposit || isDepositAvailable || isDepositPocket;

    if (isEarning) {
      earnings += amount;
      const isPocketCredit = isPocketDeposit || isDepositPocket || isPocketReferral;
      const isAvailableCredit = isJobPayment || isIncentive || isCashDeposit || isDepositAvailable || isAvailableReferral;
      if (isPocketCredit) {
        pocketChange += amount;
      } else if (isAvailableCredit) {
        availableChange += amount;
      }

      if (isJobPayment) jobPayments += amount;
      else if (isIncentive) incentiveRewards += amount;
      else if (isReferral) referralRewards += amount;
      else if (isCashDeposit || isDepositAvailable) cashDeposits += amount;
      else if (isPocketDeposit || isDepositPocket) pocketDeposits += amount;
      else otherCredits += amount;
      const dayKey = `${txDate.getFullYear()}-${txDate.getMonth() + 1}-${txDate.getDate()}`;
      if (dailyTotals[dayKey] !== undefined) {
        dailyTotals[dayKey] += amount;
      }
    }

    if (normalizedType === 'withdraw') {
      const fromPocket = String(tx?.metadata?.balanceSource || '').toLowerCase() === 'pocket';
      if (fromPocket) {
        pocketChange -= amount;
      } else {
        deducted += amount;
        availableChange -= amount;
      }
      totalWithdrawn += amount;
    }

    if (normalizedType === 'payout_settlement') {
      const settleAvailable = Number(tx?.metadata?.availableSettle || 0);
      const settlePocket = Number(tx?.metadata?.pocketSettle || 0);
      if (settleAvailable > 0) {
        availableChange -= settleAvailable;
        deducted += settleAvailable;
      }
      if (settlePocket > 0) {
        pocketChange -= settlePocket;
      }
      totalWithdrawn += settleAvailable + settlePocket;
    }

    if (normalizedType === 'refund') {
      const refundFromPocket = String(tx?.metadata?.balanceSource || '').toLowerCase() === 'pocket';
      if (refundFromPocket) {
        pocketChange += amount;
      } else {
        availableChange += amount;
      }
    }
  }

  const currentAvailable = Number(walletDoc.availableBalance ?? walletDoc.balance ?? 0);
  const currentPocket = Number(walletDoc.pocketBalance ?? 0);
  const startingAvailableBalance = Math.max(0, currentAvailable - availableChange);
  const startingPocketBalance = Math.max(0, currentPocket - pocketChange);
  const startingTotalBalance = startingAvailableBalance + startingPocketBalance;
  const currentTotalBalance = currentAvailable + currentPocket;
  const totalBalanceChange = availableChange + pocketChange;

  const available = Math.max(0, earnings - deducted);
  const netEarnings = Math.max(0, earnings - deducted);
  return {
    earnings,
    available,
    deducted,
    grossEarnings: earnings,
    netEarnings,
    totalWithdrawn,
    availableChange,
    pocketChange,
    totalBalanceChange,
    startingAvailableBalance,
    startingPocketBalance,
    startingTotalBalance,
    currentAvailableBalance: currentAvailable,
    currentPocketBalance: currentPocket,
    currentTotalBalance,
    categoryTotals: {
      jobPayments,
      incentiveRewards,
      referralRewards,
      cashDeposits,
      pocketDeposits,
      otherCredits,
    },
    dailyBreakdown: Object.keys(dailyTotals).map((key) => ({ key, amount: dailyTotals[key] || 0 })),
    weekStart: start,
    weekEnd: new Date(endExclusive.getTime() - 1),
  };
}

const PAYOUT_ALLOWED_ROLES = new Set(["worker", "contractor"]);

async function requirePayoutAccess(req, res) {
  let role = String(req.user?.role || "").toLowerCase();
  if (!role) {
    const user = await User.findOne({ phone: req.user?.phone }).select("role").lean();
    role = String(user?.role || "").toLowerCase();
    if (role) req.user.role = role;
  }
  if (!PAYOUT_ALLOWED_ROLES.has(role)) {
    res.status(403).json({
      success: false,
      message: "Payout methods are available only for worker/contractor accounts.",
      role: role || "unknown",
    });
    return false;
  }
  return true;
}

// ========== GET ROUTES ==========

// GET wallet
router.get("/", authenticateToken, async (req, res) => {
  try {
    forceFreshJson(req, res);
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone, balance: 0 });
      await wallet.save();
    } else if (wallet.availableBalance === undefined || wallet.availableBalance === null || wallet.pocketBalance === undefined || wallet.pocketBalance === null) {
      wallet.availableBalance = Number(wallet.availableBalance ?? wallet.balance ?? 0);
      wallet.pocketBalance = Number(wallet.pocketBalance ?? 0);
      wallet.balance = Number(wallet.availableBalance || 0);
      await wallet.save();
    }
    const walletPayload = wallet.toObject();
    if (String(req.user?.role || "").toLowerCase() === "worker") {
      walletPayload.weekly = computeWorkerWeeklyMetrics(wallet);
    }
    res.json({ success: true, wallet: walletPayload });
  } catch (err) {
    console.error('Wallet fetch error:', err);
    res.status(500).json({ success: false, message: "Error fetching wallet" });
  }
});

// GET wallet transactions with pagination
router.get("/transactions", authenticateToken, async (req, res) => {
  try {
    forceFreshJson(req, res);
    const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
    const limit = Math.min(50, Math.max(5, Number.parseInt(String(req.query.limit || '20'), 10) || 20));

    const wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      return res.json({ success: true, transactions: [], page, limit, total: 0, totalPages: 0 });
    }

    const allTransactions = Array.isArray(wallet.transactions) ? [...wallet.transactions] : [];
    const sortedTransactions = allTransactions.sort((a, b) => new Date(b.date) - new Date(a.date));
    const total = sortedTransactions.length;
    const totalPages = Math.ceil(total / limit);
    const paginated = sortedTransactions.slice((page - 1) * limit, page * limit);

    const formattedTransactions = paginated.map((t) => {
      const txDate = t.date ? new Date(t.date) : null;
      const formattedDate =
        txDate && !Number.isNaN(txDate.getTime())
          ? txDate.toISOString()
          : String(t.date || "");

      return {
        id: t._id,
        type: t.type,
        description: t.description || `${String(t.type || '').charAt(0).toUpperCase() + String(t.type || '').slice(1)}`,
        amount: t.amount,
        date: formattedDate,
        status: "completed",
      };
    });

    res.json({ success: true, transactions: formattedTransactions, page, limit, total, totalPages });
  } catch (err) {
    console.error('Transactions fetch error:', err);
    res.status(500).json({ success: false, message: "Error fetching transactions" });
  }
});

// ✅ GET bank account details
router.get("/bank-account", authenticateToken, async (req, res) => {
  try {
    forceFreshJson(req, res);
    if (!(await requirePayoutAccess(req, res))) return;
    const bankAccount = await BankAccount.findOne({ phone: req.user.phone });
    
    if (!bankAccount) {
      return res.json({ success: true, bankAccount: null, message: "No bank account linked" });
    }

    res.json({
      success: true,
      bankAccount: {
        accountHolderName: bankAccount.accountHolderName,
        maskedAccount: bankAccount.maskedAccount,
        ifscCode: bankAccount.ifscCode,
        bankName: bankAccount.bankName,
        accountType: bankAccount.accountType,
        isVerified: bankAccount.isVerified,
        verificationStatus: bankAccount.verificationStatus,
        addedAt: bankAccount.addedAt
      }
    });
  } catch (err) {
    console.error('Bank account fetch error:', err);
    res.status(500).json({ success: false, message: "Error fetching bank account" });
  }
});

// ========== DEPOSIT ROUTES ==========

// ✅ CREATE DEPOSIT ORDER (Razorpay)
router.post("/deposit/create-order", authenticateToken, depositOrderLimiter, async (req, res) => {
  try {
    // 🔐 ENFORCE: Keys must be configured
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('🔴 CRITICAL: Razorpay keys not configured in environment');
      return res.status(500).json({ success: false, message: "Payment service not configured" });
    }

    const { amount, depositId } = req.body;
    
    // 🔐 INPUT VALIDATION: Type safety
    if (amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    const depositAmount = Number(amount);
    if (isNaN(depositAmount)) {
      return res.status(400).json({ success: false, message: "Invalid amount format" });
    }

    if (depositAmount < 100) {
      return res.status(400).json({ success: false, message: "Minimum deposit is ₹100" });
    }

    // 🔐 FRAUD DETECTION: Max deposit limit
    if (depositAmount > 500000) { // ₹5,00,000 max per transaction
      console.warn(`⚠️ FRAUD: Attempted deposit of ₹${depositAmount} (exceeds limit)`);
      return res.status(400).json({ success: false, message: "Deposit amount exceeds limit" });
    }
    
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });

    const order = await razorpay.orders.create({
      amount: Math.round(depositAmount * 100),
      currency: 'INR',
      receipt: `deposit_${req.user.phone}_${Date.now()}`,
      notes: {
        phone: req.user.phone,
        role: req.user.role || "worker",
        type: depositId ? 'cash_deposit' : 'wallet_deposit',
        amount: depositAmount,
        depositId: depositId || undefined
      }
    });

    console.log(`💰 Deposit order created: ${order.id}, Amount: ₹${depositAmount}`);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Deposit order creation error:', err);
    res.status(500).json({ success: false, message: "Failed to create deposit order" });
  }
});

// ✅ VERIFY & COMPLETE DEPOSIT (FULLY ATOMIC)
router.post("/deposit/verify", authenticateToken, depositVerifyLimiter, async (req, res) => {
  try {
    const { orderId, paymentId, signature, depositId } = req.body;

    // 🔐 ENFORCE: Keys must be configured
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('🔴 CRITICAL: Razorpay keys not configured');
      return res.status(500).json({ success: false, message: "Payment service not configured" });
    }

    // 🔐 INPUT VALIDATION: Check for required fields and types
    if (!orderId || typeof orderId !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid orderId' });
    }
    if (!paymentId || typeof paymentId !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid paymentId' });
    }
    if (!signature || typeof signature !== 'string') {
      return res.status(400).json({ success: false, message: 'Invalid signature' });
    }

    // 🔐 STEP 1: Verify signature from Razorpay (verify early to fail fast)
    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.error(`🔴 Signature mismatch for paymentId: ${paymentId}`);
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    console.log(`✅ Deposit signature verified for order: ${orderId}`);

    // 🔐 STEP 2: Fetch and validate payment from Razorpay
    let depositAmount = null;
    let payment = null;
    try {
      const Razorpay = require('razorpay');
      const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      });
      payment = await razorpay.payments.fetch(paymentId);
      
      // 🔐 CRITICAL: Verify payment status is CAPTURED
      if (payment.status !== 'captured') {
        console.error(`🔴 Payment not captured for paymentId: ${paymentId}, status: ${payment.status}`);
        return res.status(400).json({ 
          success: false, 
          message: `Payment not completed. Status: ${payment.status}` 
        });
      }
      
      depositAmount = payment.amount / 100; // Convert from paise to rupees
      
      // Verify the amount is positive and reasonable (max ₹5,00,000)
      if (depositAmount <= 0 || depositAmount > 500000) {
        console.error(`🔴 FRAUD DETECTION: Suspicious amount: ₹${depositAmount}`);
        return res.status(400).json({ success: false, message: 'Invalid payment amount' });
      }
      if (depositAmount < 100) {
        console.error(`🔴 Deposit below minimum: ₹${depositAmount}`);
        return res.status(400).json({ success: false, message: "Minimum deposit is ₹100" });
      }
      
      console.log(`✅ Payment verified from Razorpay: ₹${depositAmount}, Status: captured`);
    } catch (razorpayErr) {
      console.error('Error fetching payment from Razorpay:', razorpayErr);
      return res.status(500).json({ success: false, message: 'Failed to verify payment with provider' });
    }

    // 🔐 CRITICAL: Verify deposit user matches authenticated user
    // Prevents user A's order from being verified/credited to user B
    if (!payment.notes || payment.notes.phone !== req.user.phone) {
      console.error(`🔴 Deposit user mismatch: payment for ${payment.notes?.phone || 'unknown'}, verified by ${req.user.phone}`);
      return res.status(400).json({
        success: false,
        message: 'Deposit user mismatch. This payment was created for a different user.'
      });
    }

    console.log(`✅ Deposit user verified: payment matches authenticated user`);

    const isPendingCashDeposit = Boolean(depositId);
    let cashDepositRecord = null;
    if (isPendingCashDeposit) {
      if (!payment.notes || payment.notes.type !== 'cash_deposit' || String(payment.notes.depositId) !== String(depositId)) {
        console.error(`🔴 Deposit verification mismatch: expected cash_deposit note for depositId=${depositId}`);
        return res.status(400).json({ success: false, message: 'Payment does not match the pending cash deposit record.' });
      }

      cashDepositRecord = await CashDeposit.findById(depositId);
      if (!cashDepositRecord) {
        return res.status(404).json({ success: false, message: 'Pending cash deposit record not found' });
      }
      if (cashDepositRecord.workerPhone !== req.user.phone) {
        return res.status(403).json({ success: false, message: 'Not authorized to settle this pending cash deposit' });
      }
      
      const cashDepositStatus = String(cashDepositRecord.status).toLowerCase();
      // ✅ IDEMPOTENT: If already completed by webhook, return success (payment was already verified)
      if (cashDepositStatus === 'completed') {
        const existingWallet = await Wallet.findOne({ phone: req.user.phone });
        return res.json({
          success: true,
          message: 'Deposit already processed',
          walletBalance: Number(existingWallet?.balance || 0),
          availableBalance: Number(existingWallet?.availableBalance ?? existingWallet?.balance ?? 0),
          pocketBalance: Number(existingWallet?.pocketBalance || 0),
          alreadyCompleted: true,
          transactionId: paymentId
        });
      }
      
      if (cashDepositStatus !== 'pending') {
        return res.status(400).json({ success: false, message: `This cash deposit is no longer available (status: ${cashDepositStatus})` });
      }
      if (Math.abs(Number(cashDepositRecord.amount || 0) - depositAmount) > 0.01) {
        return res.status(400).json({ success: false, message: 'Payment amount must match the pending cash deposit amount' });
      }

      const job = await Job.findById(cashDepositRecord.jobId);
      if (!job || job.status !== 'completed' || job.paymentStatus !== 'paid' || String(job.paymentMode || '').trim().toLowerCase() !== 'cash') {
        return res.status(400).json({ success: false, message: 'Pending cash deposit is not tied to a valid completed cash job' });
      }
    }

    // 🔐 STEP 3: CRITICAL IDEMPOTENCY CHECK
    // Check if this exact paymentId was already processed
    // This prevents race conditions and double-crediting
    const existingTransaction = await Wallet.findOne(
      {
        phone: req.user.phone,
        'transactions.paymentId': paymentId
      },
      { 'transactions.$': 1, balance: 1, availableBalance: 1, pocketBalance: 1 }
    );

    if (existingTransaction) {
      console.warn(`⚠️ IDEMPOTENCY: Payment already processed - paymentId: ${paymentId}`);
      // Return success to client (already credited)
      return res.json({
        success: true,
        message: "Payment already processed",
        walletBalance: Number(existingTransaction.balance || 0),
        availableBalance: Number(existingTransaction.availableBalance ?? existingTransaction.balance ?? 0),
        pocketBalance: Number(existingTransaction.pocketBalance || 0),
        isDuplicate: true,
        transactionId: paymentId
      });
    }

    // 🔐 STEP 4: FULLY ATOMIC UPDATE - Deposit credit via findOneAndUpdate
    // MongoDB ensures this is atomic at DB level
    // Unique index on paymentId provides additional protection
    const existingWalletBeforeUpdate = await Wallet.findOne({ phone: req.user.phone });
    if (!existingWalletBeforeUpdate) {
      return res.status(404).json({ success: false, message: "Wallet not found. Please login again." });
    }
    const role = String(req.user?.role || "").toLowerCase();
    const isWorker = role === "worker";
    const isContractor = role === "contractor";
    const targetBalanceField = isContractor ? "pocketBalance" : "availableBalance";
    const openingBalance = Number(existingWalletBeforeUpdate[targetBalanceField] || 0);
    const closingBalance = openingBalance + depositAmount;
    const balanceInc = isPendingCashDeposit
      ? { availableBalance: depositAmount, balance: depositAmount, totalEarned: depositAmount }
      : isContractor
        ? { pocketBalance: depositAmount }
        : { availableBalance: depositAmount, balance: depositAmount };

    const wallet = await Wallet.findOneAndUpdate(
      {
        phone: req.user.phone
      },
      {
        $inc: balanceInc, // Atomically increment target bucket
        $push: {
          transactions: appendAuditFields({
            type: isPendingCashDeposit ? 'cash_deposit' : isContractor ? 'pocket_deposit' : 'deposit',
            amount: depositAmount,
            openingBalance,
            closingBalance,
            paymentId,
            orderId,
            status: 'completed',
            description: isPendingCashDeposit
              ? `Pending cash deposit settled via Razorpay (${paymentId})`
              : isContractor
                ? `Pocket balance deposit via Razorpay (${paymentId})`
                : `Worker deposit credited to available via Razorpay (${paymentId})`,
            source: 'app',
            provider: 'razorpay',
            providerEventId: paymentId,
            metadata: {
              verifiedBy: 'deposit/verify',
              balanceType: isPendingCashDeposit ? 'available' : isContractor ? 'pocket' : 'available',
            },
          })
        }
      },
      { new: true, upsert: false } // Return updated doc, don't create if missing
    ).catch(err => {
      // Catch duplicate key error from unique index
      if (err.code === 11000 && err.keyPattern?.['transactions.paymentId']) {
        console.warn(`⚠️ DUPLICATE PAYMENT (unique index): paymentId: ${paymentId}`);
        return null; // Signal duplicate
      }
      throw err; // Re-throw actual errors
    });

    // If wallet is null, duplicate was detected by unique index
    if (!wallet) {
      console.warn(`⚠️ DUPLICATE: Unique index caught paymentId: ${paymentId}`);
      const existingWallet = await Wallet.findOne({ phone: req.user.phone });
      return res.json({
        success: true,
        message: "Payment already processed",
        walletBalance: existingWallet?.balance || 0,
        isDuplicate: true,
        transactionId: paymentId
      });
    }

    console.log(`✅ Wallet updated: ${req.user.phone} deposited ₹${depositAmount}`);

    if (isPendingCashDeposit && cashDepositRecord) {
      cashDepositRecord.status = 'completed';
      cashDepositRecord.depositedAt = new Date();
      try {
        await cashDepositRecord.save();
      } catch (saveErr) {
        console.error('Error saving cash deposit record after payment verification:', saveErr);
      }
    }

    // ✅ EMIT WALLET UPDATE to specific user only (via Socket.IO room)
    const io = req.app.get('io');
    if (io) {
      const socketData = {
        phone: req.user.phone,
        balance: wallet.balance,
        availableBalance: Number(wallet.availableBalance || wallet.balance || 0),
        pocketBalance: Number(wallet.pocketBalance || 0),
        type: isPendingCashDeposit ? 'cash_deposit' : 'deposit',
        amount: depositAmount,
        message: isPendingCashDeposit ? `Pending cash deposit settled: ₹${depositAmount}` : `Deposit successful: ₹${depositAmount}`
      };
      
      // ✅ Include depositId for cash deposits so frontend can update that specific card
      if (isPendingCashDeposit && depositId) {
        socketData.depositId = depositId;
        socketData.depositCompleted = true;
      }
      
      io.to(req.user.phone).emit('walletUpdated', socketData);
      console.log(`📤 Emitted walletUpdated for deposit to ${req.user.phone}`);
      
      // ✅ Also emit a specific event for cash deposit completion
      if (isPendingCashDeposit && depositId) {
        io.to(req.user.phone).emit('cashDepositCompleted', {
          depositId: depositId,
          status: 'completed',
          amount: depositAmount,
          depositedAt: new Date(),
          message: `Cash deposit of ₹${depositAmount} completed successfully`
        });
        console.log(`📤 Emitted cashDepositCompleted for deposit ${depositId} to ${req.user.phone}`);
      }
    }

    res.json({
      success: true,
      message: 'Deposit successful',
      walletBalance: wallet.balance,
      availableBalance: Number(wallet.availableBalance || wallet.balance || 0),
      pocketBalance: Number(wallet.pocketBalance || 0),
      transactionId: paymentId
    });
  } catch (err) {
    console.error('Deposit verification error:', err);
    res.status(500).json({ success: false, message: "Payment verification failed" });
  }
});

// ========== BANK ACCOUNT ROUTES ==========

// ✅ ADD/UPDATE bank account
router.post("/bank-account/add", authenticateToken, async (req, res) => {
  try {
    if (!(await requirePayoutAccess(req, res))) return;
    const { accountHolderName, accountNumber, accountNumberConfirm, ifscCode, bankName, accountType } = req.body;

    // Validation
    if (!accountHolderName || !accountNumber || !accountNumberConfirm || !ifscCode || !bankName) {
      return res.status(400).json({ success: false, message: "All fields are required" });
    }

    if (accountNumber !== accountNumberConfirm) {
      return res.status(400).json({ success: false, message: "Account numbers do not match" });
    }

    if (accountNumber.length < 9 || accountNumber.length > 18) {
      return res.status(400).json({ success: false, message: "Invalid account number length" });
    }

    if (ifscCode.length !== 11) {
      return res.status(400).json({ success: false, message: "IFSC code must be 11 characters" });
    }

    // Check if bank account already exists
    let bankAccount = await BankAccount.findOne({ phone: req.user.phone });

    if (bankAccount) {
      // Update existing
      bankAccount.accountHolderName = accountHolderName;
      bankAccount.accountNumberDecrypted = accountNumber;
      // Legacy plaintext confirm field write removed intentionally.
      // bankAccount.accountNumberConfirm = accountNumberConfirm;
      bankAccount.ifscCode = ifscCode;
      bankAccount.bankName = bankName;
      bankAccount.accountType = accountType || 'savings';
      bankAccount.verificationStatus = 'pending'; // Reset verification on update
      bankAccount.isVerified = false;
    } else {
      // Create new
      bankAccount = new BankAccount({
        phone: req.user.phone,
        accountHolderName,
        accountNumberDecrypted: accountNumber,
        // Legacy plaintext confirm field write removed intentionally.
        // accountNumberConfirm,
        ifscCode,
        bankName,
        accountType: accountType || 'savings'
      });
    }

    await bankAccount.save();

    console.log(`💳 Bank account saved for ${req.user.phone}`);

    res.json({
      success: true,
      message: 'Bank account added successfully. Waiting for verification.',
      bankAccount: {
        accountHolderName: bankAccount.accountHolderName,
        maskedAccount: bankAccount.maskedAccount,
        ifscCode: bankAccount.ifscCode,
        bankName: bankAccount.bankName,
        verificationStatus: bankAccount.verificationStatus
      }
    });
  } catch (err) {
    console.error('Bank account add error:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({ 
      success: false, 
      message: err.message || "Error adding bank account",
      error: process.env.NODE_ENV === 'development' ? err.message : "Server error"
    });
  }
});

// ========== WITHDRAWAL ROUTES ==========

router.get("/payout-method", authenticateToken, async (req, res) => {
  try {
    forceFreshJson(req, res);
    if (!(await requirePayoutAccess(req, res))) return;

    let wallet = await Wallet.findOne({ phone: req.user.phone }).select("preferredPayoutMethod upiId");
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone, balance: 0 });
      await wallet.save();
    }

    let method = wallet.preferredPayoutMethod;
    if (!method) {
      if (wallet.upiId) {
        method = "upi";
      } else {
        method = "bank";
      }
    }

    return res.json({ success: true, payoutMethod: method || "bank" });
  } catch (err) {
    console.error("Payout method fetch error:", err);
    return res.status(500).json({ success: false, message: "Error fetching payout method" });
  }
});

router.post("/payout-method", authenticateToken, async (req, res) => {
  try {
    if (!(await requirePayoutAccess(req, res))) return;
    const method = String(req.body?.method || "").toLowerCase();
    if (!["bank", "upi"].includes(method)) {
      return res.status(400).json({ success: false, message: "Invalid payout method" });
    }

    if (method === "bank") {
      const bankAccount = await BankAccount.findOne({ phone: req.user.phone }).select("_id").lean();
      if (!bankAccount) {
        return res.status(400).json({
          success: false,
          message: "Please add a bank account before selecting Bank payout.",
          requiresBankAccount: true,
        });
      }
    } else {
      const walletUpi = await Wallet.findOne({ phone: req.user.phone }).select("upiId").lean();
      if (!walletUpi?.upiId) {
        return res.status(400).json({
          success: false,
          message: "Please add a UPI ID before selecting UPI payout.",
          requiresUpi: true,
        });
      }
    }

    const wallet = await Wallet.findOneAndUpdate(
      { phone: req.user.phone },
      { $set: { preferredPayoutMethod: method } },
      { new: true, upsert: true }
    );

    return res.json({
      success: true,
      payoutMethod: wallet.preferredPayoutMethod || method,
      message: "Payout method updated",
    });
  } catch (err) {
    console.error("Payout method update error:", err);
    return res.status(500).json({ success: false, message: "Error updating payout method" });
  }
});

// ✅ WITHDRAW to bank account (requires bank account)
function getLastWithdrawal(phone) {
  return Withdrawal.findOne({ phone })
    .sort({ createdAt: -1 })
    .lean();
}

function isWeeklyWithdrawalBlocked(withdrawal, now = new Date()) {
  if (!withdrawal) return { blocked: false };

  const pendingStatuses = ["initiated", "processing"];
  if (pendingStatuses.includes(String(withdrawal.status || "").toLowerCase())) {
    return {
      blocked: true,
      message: "Please wait until your current withdrawal is completed before starting a new request.",
    };
  }

  if (String(withdrawal.status || "").toLowerCase() !== "success") {
    return { blocked: false };
  }

  const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lastCreated = new Date(withdrawal.createdAt || withdrawal.updatedAt || withdrawal.created_at || 0);
  if (Number.isNaN(lastCreated.getTime())) return { blocked: false };

  if (lastCreated >= oneWeekAgo) {
    const nextAvailable = new Date(lastCreated.getTime() + 7 * 24 * 60 * 60 * 1000);
    return {
      blocked: true,
      nextAllowedAt: nextAvailable,
      message: `Only one withdrawal is allowed per week. Next withdrawal available after ${nextAvailable.toLocaleString('en-IN')}.`,
    };
  }

  return { blocked: false, nextAllowedAt: null };
}

async function buildWithdrawStatus(phone) {
  const recentWithdrawal = await getLastWithdrawal(phone);
  const withdrawMeta = isWeeklyWithdrawalBlocked(recentWithdrawal);
  const isRequestPending = Boolean(
    recentWithdrawal &&
    ["initiated", "processing"].includes(String(recentWithdrawal.status || "").toLowerCase())
  );

  return {
    recentWithdrawal: recentWithdrawal || null,
    withdrawStatus: {
      blocked: Boolean(withdrawMeta.blocked),
      message: String(withdrawMeta.message || ""),
      nextAllowedAt: withdrawMeta.nextAllowedAt ? withdrawMeta.nextAllowedAt.toISOString() : null,
      isRequestPending,
      isWeeklyBlock: Boolean(withdrawMeta.blocked && withdrawMeta.nextAllowedAt),
    },
  };
}

router.post("/withdraw", authenticateToken, withdrawLimiter, async (req, res) => {
  try {
    // Prevent withdrawals if payout integration is not configured to avoid reconciled-but-unpaid withdrawals
    const payoutsEnabled = String(process.env.RAZORPAY_PAYOUTS_ENABLED || "false").toLowerCase() === "true";
    if (!payoutsEnabled) {
      return res.status(503).json({ success: false, message: "Payouts not configured on server. Withdrawals are disabled.", note: "Set RAZORPAY_PAYOUTS_ENABLED=true and configure payouts to enable this endpoint." });
    }
    if (!(await requirePayoutAccess(req, res))) return;
    const { amount, payoutMethod: payoutMethodInput, idempotencyKey } = req.body;
    const payoutMethod = String(payoutMethodInput || "bank").toLowerCase();
    const normalizedIdempotencyKey = idempotencyKey ? String(idempotencyKey).trim() : null;
    
    // 🔐 PRECHECK: Enforce contractor weekly withdrawal restrictions
    const role = String(req.user?.role || "").toLowerCase();
    if (role === "contractor") {
      const lastWithdrawal = await getLastWithdrawal(req.user.phone);
      const blockInfo = isWeeklyWithdrawalBlocked(lastWithdrawal);
      if (blockInfo.blocked) {
        if (!normalizedIdempotencyKey || !lastWithdrawal?.idempotencyKey || lastWithdrawal.idempotencyKey !== normalizedIdempotencyKey) {
          return res.status(400).json({ success: false, message: blockInfo.message });
        }
      }
    }

    // 🔐 STEP 1: INPUT VALIDATION - Numeric type safety
    if (amount === undefined || amount === null) {
      return res.status(400).json({ success: false, message: "Amount is required" });
    }

    const withdrawAmount = Number(amount);
    if (isNaN(withdrawAmount)) {
      return res.status(400).json({ success: false, message: "Invalid amount format" });
    }

    if (withdrawAmount <= 0) {
      return res.status(400).json({ success: false, message: "Amount must be positive" });
    }

    if (withdrawAmount < 100) {
      return res.status(400).json({ success: false, message: "Minimum withdrawal is ₹100" });
    }

    // 🔐 STEP 2: Fraud detection - max withdrawal limit
    if (withdrawAmount > 500000) { // ₹5,00,000 max per transaction
      console.warn(`⚠️ FRAUD: Attempted withdrawal of ₹${withdrawAmount} (exceeds limit)`);
      return res.status(400).json({ success: false, message: "Withdrawal amount exceeds limit" });
    }

    if (!["bank", "upi"].includes(payoutMethod)) {
      return res.status(400).json({ success: false, message: "Invalid payout method" });
    }

    if (normalizedIdempotencyKey) {
      const existingWithdrawal = await Withdrawal.findOne({ phone: req.user.phone, idempotencyKey: normalizedIdempotencyKey });
      if (existingWithdrawal) {
        return res.json({
          success: true,
          message: existingWithdrawal.status === 'failed' || existingWithdrawal.status === 'reversed'
            ? 'Previous withdrawal request completed with failure. Please use a new idempotency key to retry.'
            : 'Withdrawal already submitted',
          isDuplicate: true,
          withdrawalId: existingWithdrawal._id,
          status: existingWithdrawal.status,
          amount: existingWithdrawal.amount,
          failureReason: existingWithdrawal.failureReason || null,
        });
      }
    } else {
      const duplicatePendingWithdrawal = await findPendingDuplicateWithdrawal({
        phone: req.user.phone,
        amount: withdrawAmount,
        payoutMethod,
      });
      if (duplicatePendingWithdrawal) {
        return res.status(200).json({
          success: true,
          message: 'A withdrawal with the same amount is already pending. Please wait for it to complete.',
          isDuplicate: true,
          withdrawalId: duplicatePendingWithdrawal._id,
          status: duplicatePendingWithdrawal.status,
          amount: duplicatePendingWithdrawal.amount,
        });
      }
    }

    // 🔐 STEP 3: Verify selected payout method
    let bankAccount = null;
    let upiDetails = null;
    let rawUpiId = null;

    if (payoutMethod === "bank") {
      bankAccount = await BankAccount.findOne({ phone: req.user.phone });
      if (!bankAccount) {
        return res.status(400).json({
          success: false,
          message: "Please add a bank account before withdrawing",
          requiresBankAccount: true,
        });
      }

      if (!bankAccount.isVerified) {
        return res.status(400).json({
          success: false,
          message: `Bank account verification status: ${bankAccount.verificationStatus}. Please wait for verification.`,
          verificationStatus: bankAccount.verificationStatus
        });
      }
    } else {
      const walletForUpi = await Wallet.findOne({ phone: req.user.phone }).select(
        "upiId upiMasked upiIsVerified upiVerificationStatus"
      );
      if (!walletForUpi?.upiId) {
        return res.status(400).json({
          success: false,
          message: "Please add a UPI ID before withdrawing",
          requiresUpi: true,
        });
      }
      if (!walletForUpi.upiIsVerified) {
        return res.status(400).json({
          success: false,
          message: `UPI verification status: ${walletForUpi.upiVerificationStatus}. Please wait for verification.`,
          verificationStatus: walletForUpi.upiVerificationStatus,
          requiresUpiVerification: true,
        });
      }
      upiDetails = {
        maskedUpiId: walletForUpi.upiMasked || maskUpiId(walletForUpi.upiId),
      };
      rawUpiId = walletForUpi.upiId;
    }

    // 🔐 STEP 4: ATOMIC OPERATION - Prevent race condition
    // Use findOneAndUpdate to atomically check balance and deduct in one operation
    // This prevents two simultaneous requests from both passing the balance check
    const existingWalletBeforeWithdraw = await Wallet.findOne({ phone: req.user.phone });
    if (!existingWalletBeforeWithdraw) {
      return res.status(404).json({ success: false, message: "Wallet not found. Please login again." });
    }
    const userRole = String(req.user?.role || "").toLowerCase();
    const isContractor = userRole === "contractor";
    const rawAvailable = Number(existingWalletBeforeWithdraw.availableBalance ?? 0);
    const rawPocket = Number(existingWalletBeforeWithdraw.pocketBalance ?? 0);
    const openingAvailable = rawAvailable;
    const deductedFromAvailable = withdrawAmount;
    const deductedFromPocket = 0;
    const balanceSource = isContractor ? "pocket" : "available";

    const openingBalance = isContractor ? rawPocket : openingAvailable;
    const closingBalance = openingBalance - withdrawAmount;

    // 🔐 EDGE CASE: Available balance vs ledger truth
    // Double-check balance constraints before attempting atomic operation
    if (isContractor && rawPocket < withdrawAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient pocket balance for withdrawal",
        availableBalance: rawPocket,
        requiredAmount: withdrawAmount,
        hint: "Pocket balance may have changed. Please refresh and try again.",
      });
    }

    if (!isContractor && rawAvailable < withdrawAmount) {
      return res.status(400).json({
        success: false,
        message: "Insufficient available balance for withdrawal",
        availableBalance: rawAvailable,
        requiredAmount: withdrawAmount,
        hint: "Available balance may have changed due to ongoing transactions. Please refresh and try again.",
      });
    }

    const query = isContractor
      ? {
          phone: req.user.phone,
          pocketBalance: { $gte: withdrawAmount },
        }
      : {
          phone: req.user.phone,
          availableBalance: { $gte: withdrawAmount },
        };

    const incOps = {};
    if (isContractor) {
      incOps.pocketBalance = -withdrawAmount;
    } else {
      incOps.availableBalance = -deductedFromAvailable;
      incOps.balance = -deductedFromAvailable;
    }
    const wallet = await Wallet.findOneAndUpdate(
      query,
      {
        $inc: incOps,
        $push: {
          transactions: appendAuditFields({
            type: "withdraw",
            amount: withdrawAmount,
            openingBalance,
            closingBalance,
            status: "initiated", // pending until payout callback
            description:
              payoutMethod === "bank"
                ? `Withdrawal to bank account ${bankAccount.maskedAccount}`
                : `Withdrawal to UPI ${upiDetails.maskedUpiId}`,
            source: "app",
            provider: "razorpay",
            metadata:
              payoutMethod === "bank"
                ? { payoutMethod: "bank", bankMasked: bankAccount.maskedAccount, balanceSource, deductedFromAvailable: isContractor ? 0 : deductedFromAvailable, deductedFromPocket: isContractor ? withdrawAmount : 0 }
                : { payoutMethod: "upi", upiMasked: upiDetails.maskedUpiId, balanceSource, deductedFromAvailable: isContractor ? 0 : deductedFromAvailable, deductedFromPocket: isContractor ? withdrawAmount : 0 },
          })
        }
      },
      { new: true } // Return updated document
    );

    // If wallet is undefined, it means balance check failed (race condition prevented)
    if (!wallet) {
      return res.status(400).json({
        success: false,
        message: "Insufficient available balance. Another withdrawal may be in progress.",
        availableBalance: rawAvailable,
        requiredAmount: withdrawAmount,
        hint: "Please refresh and try again.",
      });
    }

    const latestTransaction = wallet.transactions[wallet.transactions.length - 1];
    const withdrawal = await Withdrawal.create({
      phone: req.user.phone,
      amount: withdrawAmount,
      status: 'initiated',
      payoutMethod,
      idempotencyKey: normalizedIdempotencyKey,
      balanceSource,
      deductedFromAvailable: isContractor ? 0 : deductedFromAvailable,
      deductedFromPocket: isContractor ? withdrawAmount : deductedFromPocket,
      walletTransactionId: latestTransaction?._id || null,
      provider: 'razorpay',
      bankSnapshot:
        payoutMethod === "bank"
          ? {
              accountHolderName: bankAccount.accountHolderName,
              maskedAccount: bankAccount.maskedAccount,
              ifscCode: bankAccount.ifscCode,
              bankName: bankAccount.bankName,
              accountType: bankAccount.accountType,
            }
          : undefined,
    });

    console.log(`✅ Withdrawal initiated: ${req.user.phone}, Amount: ₹${withdrawAmount}, Method: ${payoutMethod}`);

    // ✅ EMIT WALLET UPDATE to specific user only (via Socket.IO room)
    const io = req.app.get('io');
    if (io) {
      io.to(req.user.phone).emit('walletUpdated', {
        phone: req.user.phone,
        balance: wallet.balance,
        availableBalance: Number(wallet.availableBalance || wallet.balance || 0),
        pocketBalance: Number(wallet.pocketBalance || 0),
        type: 'withdraw',
        amount: withdrawAmount,
        message:
          payoutMethod === "bank"
            ? `Withdrawal initiated: ₹${withdrawAmount} to ${bankAccount.bankName}`
            : `Withdrawal initiated: ₹${withdrawAmount} to ${upiDetails.maskedUpiId}`
      });
      console.log(`📤 Emitted walletUpdated for withdrawal to ${req.user.phone}`);
    }

    // TODO: Trigger Razorpay Payouts API for actual bank transfer and update withdrawal status.
    // This endpoint now stores an explicit withdrawal ledger record for reconciliation/rollback.

    // Attempt to create a Razorpay payout (best-effort). If payouts are not configured this will be skipped.
    (async () => {
      try {
        const payoutsEnabled = String(process.env.RAZORPAY_PAYOUTS_ENABLED || "false").toLowerCase() === "true";
        if (!payoutsEnabled) return;

        // Amount is in INR; convert to paise for gateway
        const amountPaise = Math.round(withdrawAmount * 100);

        const payoutResp = await createRazorpayPayout({
          withdrawalId: withdrawal._id,
          amountPaise,
          payoutMethod: payoutMethod,
          bankAccount,
          upiId: rawUpiId,
          phone: req.user.phone,
          loggerContext: { phone: req.user.phone }
        });

        if (payoutResp && payoutResp.id) {
          withdrawal.providerPayoutId = payoutResp.id;
          withdrawal.providerEventId = payoutResp.idempotencyKey || payoutResp.status || null;
          withdrawal.status = mapRazorpayPayoutStatus(payoutResp.status);
          withdrawal.reconciledAt = new Date();
          await withdrawal.save();
          const payoutWallet = await Wallet.findOne({ phone: req.user.phone });
          if (payoutWallet) {
            markWalletTransactionStatus(
              payoutWallet,
              withdrawal.walletTransactionId,
              withdrawal.status === 'success' ? 'completed' : 'processing',
              {
                payoutId: payoutResp.id,
                payoutStatus: payoutResp.status || null,
                payoutIdempotencyKey: payoutResp.idempotencyKey || null,
              }
            );
            await payoutWallet.save();
          }
          // Emit update
          const io2 = req.app.get('io');
          if (io2) io2.to(req.user.phone).emit('withdrawalUpdated', { withdrawalId: withdrawal._id, status: withdrawal.status });
        }
      } catch (pErr) {
        console.error('Payout initiation failed for withdrawal', withdrawal._id, pErr?.message || pErr);
        await sendOpsAlert('Payout initiation failed', { withdrawalId: withdrawal._id, error: pErr?.message || String(pErr) });

        // Immediate rollback on fatal failure: credit the wallet back if not already rolled back
        try {
          const wallet = await Wallet.findOne({ phone: req.user.phone });
          if (wallet) {
            const rollbackEventId = `payout_failed_rollback:${withdrawal._id.toString()}`;
            const rolledBack = rollbackWithdrawalOnWallet({
              wallet,
              withdrawal,
              rollbackEventId,
              description: `Rollback for failed payout ${withdrawal._id}`,
              source: 'system',
              providerEventId: rollbackEventId,
              metadata: {
                withdrawalId: withdrawal._id,
                failureReason: pErr?.message || String(pErr),
              },
            });
            if (rolledBack) {
              await wallet.save();
              withdrawal.status = 'failed';
              withdrawal.failureReason = pErr?.message || String(pErr);
              withdrawal.reconciledAt = new Date();
              await withdrawal.save();
              const io3 = req.app.get('io');
              if (io3) io3.to(req.user.phone).emit('walletUpdated', { phone: req.user.phone, balance: wallet.balance, availableBalance: wallet.availableBalance, pocketBalance: wallet.pocketBalance, type: 'refund', amount: Number(withdrawal.amount || 0) });
            }
          }
        } catch (rbErr) {
          console.error('Rollback after payout failure also failed', rbErr);
          await sendOpsAlert('Rollback after payout failure failed', { withdrawalId: withdrawal._id, error: rbErr?.message || String(rbErr) });
        }
      }
    })();

    res.json({ 
      success: true, 
      message: "Withdrawal initiated and queued for payout processing.",
      walletBalance: wallet.balance,
      availableBalance: Number(wallet.availableBalance || wallet.balance || 0),
      pocketBalance: Number(wallet.pocketBalance || 0),
      withdrawalAmount: withdrawAmount,
      balanceSource,
      deductedFromAvailable: isContractor ? 0 : deductedFromAvailable,
      deductedFromPocket: isContractor ? withdrawAmount : deductedFromPocket,
      payoutMethod,
      bankAccount: bankAccount?.maskedAccount || null,
      upiId: upiDetails?.maskedUpiId || null,
      accountName: bankAccount?.accountHolderName || null,
      withdrawalId: withdrawal._id,
      status: withdrawal.status,
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ success: false, message: "Error processing withdrawal" });
  }
});

router.get("/withdraw/recent", authenticateToken, async (req, res) => {
  try {
    const payload = await buildWithdrawStatus(req.user.phone);
    return res.json({
      success: true,
      ...payload,
    });
  } catch (err) {
    console.error('Recent withdrawal lookup error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch recent withdrawal' });
  }
});

router.get("/withdraw/status", authenticateToken, async (req, res) => {
  try {
    const payload = await buildWithdrawStatus(req.user.phone);
    return res.json({
      success: true,
      ...payload,
    });
  } catch (err) {
    console.error('Withdrawal status lookup error:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch withdraw status' });
  }
});

// ADD/UPDATE UPI payout method
router.post("/upi/add", authenticateToken, async (req, res) => {
  try {
    if (!(await requirePayoutAccess(req, res))) return;
    const rawUpiId = String(req.body?.upiId || "").trim().toLowerCase();
    const upiRegex = /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/;

    if (!rawUpiId) {
      return res.status(400).json({ success: false, message: "UPI ID is required" });
    }
    if (!upiRegex.test(rawUpiId)) {
      return res.status(400).json({ success: false, message: "Invalid UPI ID format" });
    }

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone, balance: 0 });
    }

    wallet.upiId = rawUpiId;
    wallet.upiMasked = maskUpiId(rawUpiId);
    // Require server-side UPI verification for production; default to 'pending'
    const autoVerifyUpi = String(process.env.SKIP_UPI_VERIFICATION || "false").toLowerCase() === "true";
    wallet.upiIsVerified = !!autoVerifyUpi;
    wallet.upiVerificationStatus = autoVerifyUpi ? "verified" : "pending";
    await wallet.save();

    return res.json({
      success: true,
      message: "UPI ID saved successfully.",
      upi: {
        maskedUpiId: wallet.upiMasked,
        isVerified: wallet.upiIsVerified,
        verificationStatus: wallet.upiVerificationStatus,
      },
    });
  } catch (err) {
    console.error("UPI add error:", err);
    return res.status(500).json({ success: false, message: "Failed to save UPI ID" });
  }
});

// GET UPI payout details
router.get("/upi", authenticateToken, async (req, res) => {
  try {
    forceFreshJson(req, res);
    if (!(await requirePayoutAccess(req, res))) return;
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone, balance: 0 });
      await wallet.save();
    }

    if (!wallet.upiId) {
      return res.json({
        success: true,
        upi: null,
        message: "No UPI ID linked",
      });
    }

    return res.json({
      success: true,
      upi: {
        maskedUpiId: wallet.upiMasked || maskUpiId(wallet.upiId),
        isVerified: Boolean(wallet.upiIsVerified),
        verificationStatus: wallet.upiVerificationStatus || "pending",
      },
    });
  } catch (err) {
    console.error("UPI fetch error:", err);
    return res.status(500).json({ success: false, message: "Error fetching UPI details" });
  }
});

// ========== WEBHOOK ROUTES ==========

// Razorpay webhook for wallet deposits (payment.captured)
router.post("/deposit/webhook", async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      await session.abortTransaction();
      return res.status(500).json({ success: false, message: "Webhook secret not configured" });
    }

    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody || (req.body && typeof req.body === "object"
      ? JSON.stringify(req.body)
      : String(req.body || ""));
    
    // 🔐 CRITICAL: Signature verification MUST pass before any state changes
    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (expected !== signature) {
      // Log invalid signature attempt for fraud detection
      console.error("🔴 WALLET DEPOSIT WEBHOOK: Invalid signature - rejecting");
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: "Invalid webhook signature" });
    }

    const event = req.body?.event;
    if (event !== "payment.captured") {
      await session.commitTransaction();
      return res.status(200).json({ success: true, ignored: true });
    }

    const payment = req.body?.payload?.payment?.entity;
    const paymentId = payment?.id;
    const orderId = payment?.order_id;
    const amount = Number(payment?.amount || 0) / 100;
    const phone = payment?.notes?.phone;
    const type = String(payment?.notes?.type || "").toLowerCase();
    const depositId = String(payment?.notes?.depositId || "").trim();
    const isCashDeposit = type === "cash_deposit";
    const isWalletDeposit = type === "wallet_deposit";
    let cashDepositRecord = null;

    // This endpoint is only for wallet-related deposits.
    // If a job payment webhook reaches here, ACK as ignored to prevent noisy 400 retries.
    if (!isWalletDeposit && !isCashDeposit) {
      await session.commitTransaction();
      return res.status(200).json({ success: true, ignored: true, reason: "non_wallet_deposit_event" });
    }

    if (!paymentId || !phone || amount <= 0 || amount < 100) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: "Invalid wallet deposit webhook payload" });
    }

    if (isCashDeposit) {
      if (!depositId) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: "Missing depositId for pending cash deposit webhook" });
      }
      cashDepositRecord = await CashDeposit.findById(depositId).session(session);
      if (!cashDepositRecord || String(cashDepositRecord.workerPhone) !== String(phone)) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: "Cash deposit webhook record mismatch" });
      }
      if (String(cashDepositRecord.status || "").toLowerCase() !== "pending") {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: "Cash deposit is not pending" });
      }
      if (Math.abs(Number(cashDepositRecord.amount || 0) - amount) > 0.01) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: "Cash deposit amount mismatch" });
      }
    }

    // 🔐 EDGE CASE: Deposit flow - success vs verification failure
    // Check if this payment ID has already been processed
    // If YES → idempotently return success (no duplicate credit)
    // If NO → proceed to credit wallet atomically within transaction
    const existingWallet = await Wallet.findOne({ phone, "transactions.paymentId": paymentId }).session(session);
    if (existingWallet) {
      await session.commitTransaction();
      console.log(`✅ DEPOSIT WEBHOOK IDEMPOTENCY: Payment ${paymentId} already processed`);
      return res.status(200).json({ success: true, duplicate: true, message: "Payment already processed" });
    }

    const walletDoc = await Wallet.findOne({ phone }).session(session);
    if (!walletDoc) {
      // Create wallet if doesn't exist (idempotent upsert will handle this)
      const newWallet = new Wallet({
        phone,
        balance: 0,
        availableBalance: 0,
        pocketBalance: 0,
        transactions: [],
      });
      await newWallet.save({ session });
    }

    let role = String(payment?.notes?.role || "").toLowerCase();
    if (!role) {
      const userDoc = await User.findOne({ phone }).select("role").lean().session(session);
      role = String(userDoc?.role || "worker").toLowerCase();
    }
    const isWorker = role === "worker";
    const isContractor = role === "contractor";
    const targetBalanceField = "availableBalance";
    
    // 🔐 ATOMIC: Credit wallet only after signature verification passes
    // This ensures wallet never credited if callback succeeds but verification fails on retry
    const incOps = isContractor
      ? { pocketBalance: amount }
      : { availableBalance: amount, balance: amount, totalEarned: amount };

    const updatedWallet = await Wallet.findOneAndUpdate(
      { phone, "transactions.paymentId": { $ne: paymentId } },
      {
        $inc: incOps,
        $push: {
          transactions: appendAuditFields({
            type: isCashDeposit ? "cash_deposit" : isContractor ? "pocket_deposit" : "deposit",
            amount,
            openingBalance: Number(walletDoc?.[targetBalanceField] || 0),
            closingBalance: (Number(walletDoc?.[targetBalanceField] || 0) + amount),
            orderId,
            paymentId,
            status: "completed",
            description: isCashDeposit
              ? `Pending cash deposit settled via webhook (${paymentId})`
              : isContractor
                ? `Pocket balance deposit via webhook (${paymentId})`
                : `Worker deposit credited to available via webhook (${paymentId})`,
            source: "webhook",
            provider: "razorpay",
            providerEventId: paymentId,
            idempotencyKey: paymentId,
            metadata: {
              webhookEvent: event,
              balanceType: isCashDeposit ? "available" : isContractor ? "pocket" : "available",
              verifiedAt: new Date(),
            },
          }),
        },
      },
      { new: true, session }
    );

    // If update returns null, payment was already processed (idempotency)
    if (!updatedWallet) {
      await session.commitTransaction();
      console.log(`✅ DEPOSIT WEBHOOK IDEMPOTENCY: Payment ${paymentId} already processed (null result)`);
      return res.status(200).json({ success: true, duplicate: true, message: "Payment already processed" });
    }

    if (isCashDeposit && cashDepositRecord) {
      cashDepositRecord.status = 'completed';
      cashDepositRecord.depositedAt = new Date();
      try {
        await cashDepositRecord.save({ session });
      } catch (saveErr) {
        console.error('Error updating cash deposit record from webhook:', saveErr);
      }
    }

    await session.commitTransaction();

    const io = req.app?.get('io');
    if (io) {
      const socketData = {
        phone,
        balance: updatedWallet.balance,
        availableBalance: Number(updatedWallet.availableBalance || updatedWallet.balance || 0),
        pocketBalance: Number(updatedWallet.pocketBalance || 0),
        type: isCashDeposit ? 'cash_deposit' : 'deposit',
        amount,
        message: isCashDeposit ? `Pending cash deposit settled: ₹${amount}` : `Wallet deposit successful: ₹${amount}`
      };
      
      // ✅ Include depositId for cash deposits so frontend can update that specific card
      if (isCashDeposit && depositId) {
        socketData.depositId = depositId;
        socketData.depositCompleted = true;
      }
      
      io.to(phone).emit('walletUpdated', socketData);
      
      // ✅ Also emit a specific event for cash deposit completion
      if (isCashDeposit && depositId) {
        io.to(phone).emit('cashDepositCompleted', {
          depositId: depositId,
          status: 'completed',
          amount,
          depositedAt: new Date(),
          message: `Cash deposit of ₹${amount} completed successfully`
        });
        console.log(`📤 Emitted cashDepositCompleted for deposit ${depositId} to ${phone} (from webhook)`);
      }
    }

    return res.status(200).json({
      success: true,
      walletBalance: updatedWallet.balance,
      availableBalance: Number(updatedWallet.availableBalance || updatedWallet.balance || 0),
      pocketBalance: Number(updatedWallet.pocketBalance || 0),
    });
  } catch (err) {
    console.error("Deposit webhook error:", err);
    await sendOpsAlert("Deposit webhook processing failed", { error: err && err.message });
    return res.status(500).json({ success: false, message: "Deposit webhook processing failed" });
  }
});

// Razorpay webhook for payout lifecycle events
router.post("/payout/webhook", async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(500).json({ success: false, message: "Webhook secret not configured" });
    }

    const signature = req.headers["x-razorpay-signature"];
    const rawBody = req.rawBody || (req.body && typeof req.body === "object"
      ? JSON.stringify(req.body)
      : String(req.body || ""));
    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(rawBody)
      .digest("hex");

    if (expected !== signature) {
      return res.status(403).json({ success: false, message: "Invalid webhook signature" });
    }

    const event = req.body?.event;
    const payout = req.body?.payload?.payout?.entity;
    if (!payout) return res.status(400).json({ success: false, message: "Invalid payout payload" });

    const payoutId = payout.id;
    const notes = payout.notes || {};
    const withdrawalId = notes.withdrawalId || null;
    const phone = notes.phone || null;

    // Map Razorpay payout events to internal states
    const mappedStatus =
      event === "payout.processed" ? "success" :
      event === "payout.reversed" ? "reversed" :
      event === "payout.rejected" ? "failed" :
      event === "payout.pending" || event === "payout.initiated" || event === "payout.updated" ? "processing" :
      null;

    if (!mappedStatus) return res.status(200).json({ success: true, ignored: true });

    const query = withdrawalId ? { _id: withdrawalId } : { providerPayoutId: payoutId, phone };
    const withdrawal = await Withdrawal.findOne(query);
    if (!withdrawal) return res.status(404).json({ success: false, message: "Withdrawal not found" });

    withdrawal.status = mappedStatus;
    withdrawal.providerPayoutId = payoutId;
    withdrawal.providerEventId = event;
    withdrawal.providerReferenceId = payout?.reference_id || withdrawal.providerReferenceId;
    if (mappedStatus === "failed" || mappedStatus === "reversed") {
      withdrawal.failureReason = payout?.status_details?.description || payout?.status_details?.reason || "payout_failed";
    }
    withdrawal.reconciledAt = new Date();
    await withdrawal.save();

    const walletUpdateStatus = await updateWalletTransactionStatus(
      withdrawal.phone,
      withdrawal.walletTransactionId,
      mappedStatus === "success" ? "completed" : mappedStatus === "processing" ? "processing" : "failed",
      {
        payoutId,
        payoutEvent: event,
        payoutStatus: mappedStatus,
        failureReason: withdrawal.failureReason || null,
      }
    );

    if (!walletUpdateStatus) {
      console.warn(`⚠️ Payout webhook: wallet transaction ${withdrawal.walletTransactionId} not found or status not updated`);
    }

    if (mappedStatus === "failed" || mappedStatus === "reversed") {
      const rollbackEventId = `rollback:${withdrawal._id.toString()}`;
      await rollbackWithdrawalOnWalletAtomic({
        phone: withdrawal.phone,
        withdrawal,
        rollbackEventId,
        description: `Withdrawal rollback for ${withdrawal._id.toString()}`,
        source: "webhook",
        providerEventId: event,
        metadata: {
          payoutEvent: event,
          payoutId,
          balanceSource: String(withdrawal.balanceSource || "available"),
          refundedToAvailable: Number(withdrawal.deductedFromAvailable || 0),
          refundedToPocket: Number(withdrawal.deductedFromPocket || 0),
          failureReason: withdrawal.failureReason || null,
        },
      });
    }

    return res.status(200).json({ success: true, status: mappedStatus });
  } catch (err) {
    console.error("Payout webhook error:", err);
    await sendOpsAlert("Payout webhook processing failed", { error: err && err.message });
    return res.status(500).json({ success: false, message: "Payout webhook processing failed" });
  }
});

// Manual reconciliation endpoint for stuck withdrawals (can be called by cron)
router.post("/reconcile/withdrawals", authenticateToken, async (req, res) => {
  try {
    const staleMinutes = Number(req.body?.staleMinutes || 60);
    const cutoff = new Date(Date.now() - staleMinutes * 60 * 1000);
    const stuck = await Withdrawal.find({
      status: { $in: ["initiated", "processing"] },
      updatedAt: { $lt: cutoff },
    }).limit(500);

    // Mark as processing-retry and increment retry count.
    for (const row of stuck) {
      row.retryCount = Number(row.retryCount || 0) + 1;
      row.status = "processing";
      row.reconciledAt = new Date();
      await row.save();
    }

    return res.json({
      success: true,
      checked: stuck.length,
      message: "Reconciliation pass completed",
    });
  } catch (err) {
    console.error("Reconciliation error:", err);
    await sendOpsAlert("Withdrawal reconciliation failed", { error: err && err.message });
    return res.status(500).json({ success: false, message: "Reconciliation failed" });
  }
});

module.exports = router;
