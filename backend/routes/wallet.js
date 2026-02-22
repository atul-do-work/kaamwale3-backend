// routes/wallet.js
const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const { authenticateToken } = require("../utils/auth");
const Wallet = require("../models/Wallet");
const BankAccount = require("../models/BankAccount");
const Withdrawal = require("../models/Withdrawal");
const { sendOpsAlert } = require("../utils/opsAlert");

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

// ========== GET ROUTES ==========

// GET wallet
router.get("/", authenticateToken, async (req, res) => {
  try {
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone, balance: 0 });
      await wallet.save();
    }
    res.json({ success: true, wallet });
  } catch (err) {
    console.error('Wallet fetch error:', err);
    res.status(500).json({ success: false, message: "Error fetching wallet" });
  }
});

// GET transactions
router.get("/transactions", authenticateToken, async (req, res) => {
  try {
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      return res.json({ success: true, transactions: [] });
    }
    
    const formattedTransactions = wallet.transactions.map((t) => ({
      id: t._id,
      type: t.type === "deposit" || t.type === "credit" ? "credit" : t.type === "refund" ? "refund" : "debit",
      description: t.description || `${t.type.charAt(0).toUpperCase() + t.type.slice(1)}`,
      amount: t.amount,
      date: new Date(t.date).toLocaleDateString("en-IN"),
      status: "completed",
    }));
    
    res.json({ success: true, transactions: formattedTransactions });
  } catch (err) {
    console.error('Transactions fetch error:', err);
    res.status(500).json({ success: false, message: "Error fetching transactions" });
  }
});

// ✅ GET bank account details
router.get("/bank-account", authenticateToken, async (req, res) => {
  try {
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

    const { amount } = req.body;
    
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
        type: 'wallet_deposit',
        amount: depositAmount // Store amount in notes for server-side verification
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
    const { orderId, paymentId, signature } = req.body;

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

    // 🔐 STEP 3: CRITICAL IDEMPOTENCY CHECK
    // Check if this exact paymentId was already processed
    // This prevents race conditions and double-crediting
    const existingTransaction = await Wallet.findOne(
      {
        phone: req.user.phone,
        'transactions.paymentId': paymentId
      },
      { 'transactions.$': 1 }
    );

    if (existingTransaction) {
      console.warn(`⚠️ IDEMPOTENCY: Payment already processed - paymentId: ${paymentId}`);
      // Return success to client (already credited)
      return res.json({
        success: true,
        message: "Payment already processed",
        walletBalance: existingTransaction.balance,
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
    const openingBalance = Number(existingWalletBeforeUpdate.balance || 0);
    const closingBalance = openingBalance + depositAmount;

    const wallet = await Wallet.findOneAndUpdate(
      {
        phone: req.user.phone
      },
      {
        $inc: { balance: depositAmount }, // Atomically increment balance
        $push: {
          transactions: appendAuditFields({
            type: 'deposit',
            amount: depositAmount,
            openingBalance,
            closingBalance,
            paymentId,
            orderId,
            status: 'completed',
            description: `Wallet deposit via Razorpay (${paymentId})`,
            source: 'app',
            provider: 'razorpay',
            providerEventId: paymentId,
            metadata: { verifiedBy: 'deposit/verify' },
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

    // ✅ EMIT WALLET UPDATE to specific user only (via Socket.IO room)
    const io = req.app.get('io');
    if (io) {
      io.to(req.user.phone).emit('walletUpdated', {
        phone: req.user.phone,
        balance: wallet.balance,
        type: 'deposit',
        amount: depositAmount,
        message: `Deposit successful: ₹${depositAmount}`
      });
      console.log(`📤 Emitted walletUpdated for deposit to ${req.user.phone}`);
    }

    res.json({
      success: true,
      message: 'Deposit successful',
      walletBalance: wallet.balance,
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

// ✅ WITHDRAW to bank account (requires bank account)
router.post("/withdraw", authenticateToken, withdrawLimiter, async (req, res) => {
  try {
    const { amount } = req.body;
    
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

    // 🔐 STEP 3: Verify bank account
    const bankAccount = await BankAccount.findOne({ phone: req.user.phone });
    
    if (!bankAccount) {
      return res.status(400).json({ 
        success: false, 
        message: "Please add a bank account before withdrawing",
        requiresBankAccount: true
      });
    }

    if (!bankAccount.isVerified) {
      return res.status(400).json({ 
        success: false, 
        message: `Bank account verification status: ${bankAccount.verificationStatus}. Please wait for verification.`,
        verificationStatus: bankAccount.verificationStatus
      });
    }

    // 🔐 STEP 4: ATOMIC OPERATION - Prevent race condition
    // Use findOneAndUpdate to atomically check balance and deduct in one operation
    // This prevents two simultaneous requests from both passing the balance check
    const existingWalletBeforeWithdraw = await Wallet.findOne({ phone: req.user.phone });
    if (!existingWalletBeforeWithdraw) {
      return res.status(404).json({ success: false, message: "Wallet not found. Please login again." });
    }
    const openingBalance = Number(existingWalletBeforeWithdraw.balance || 0);
    const closingBalance = openingBalance - withdrawAmount;

    const wallet = await Wallet.findOneAndUpdate(
      {
        phone: req.user.phone,
        balance: { $gte: withdrawAmount } // Only proceed if balance is sufficient
      },
      {
        $inc: { balance: -withdrawAmount }, // Atomically decrement balance
        $push: {
          transactions: appendAuditFields({
            type: "withdraw",
            amount: withdrawAmount,
            openingBalance,
            closingBalance,
            status: "initiated", // pending until payout callback
            description: `Withdrawal to bank account ${bankAccount.maskedAccount}`,
            source: "app",
            provider: "razorpay",
            metadata: { bankMasked: bankAccount.maskedAccount },
          })
        }
      },
      { new: true } // Return updated document
    );

    // If wallet is undefined, it means balance check failed (race condition prevented)
    if (!wallet) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    const latestTransaction = wallet.transactions[wallet.transactions.length - 1];
    const withdrawal = await Withdrawal.create({
      phone: req.user.phone,
      amount: withdrawAmount,
      status: 'initiated',
      walletTransactionId: latestTransaction?._id || null,
      provider: 'razorpay',
      bankSnapshot: {
        accountHolderName: bankAccount.accountHolderName,
        maskedAccount: bankAccount.maskedAccount,
        ifscCode: bankAccount.ifscCode,
        bankName: bankAccount.bankName,
        accountType: bankAccount.accountType,
      },
    });

    console.log(`✅ Withdrawal initiated: ${req.user.phone}, Amount: ₹${withdrawAmount}, Account: ${bankAccount.maskedAccount}`);

    // ✅ EMIT WALLET UPDATE to specific user only (via Socket.IO room)
    const io = req.app.get('io');
    if (io) {
      io.to(req.user.phone).emit('walletUpdated', {
        phone: req.user.phone,
        balance: wallet.balance,
        type: 'withdraw',
        amount: withdrawAmount,
        message: `Withdrawal initiated: ₹${withdrawAmount} to ${bankAccount.bankName}`
      });
      console.log(`📤 Emitted walletUpdated for withdrawal to ${req.user.phone}`);
    }

    // TODO: Trigger Razorpay Payouts API for actual bank transfer and update withdrawal status.
    // This endpoint now stores an explicit withdrawal ledger record for reconciliation/rollback.

    res.json({ 
      success: true, 
      message: "Withdrawal initiated and queued for payout processing.",
      walletBalance: wallet.balance,
      withdrawalAmount: withdrawAmount,
      bankAccount: bankAccount.maskedAccount,
      accountName: bankAccount.accountHolderName,
      withdrawalId: withdrawal._id,
      status: withdrawal.status,
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ success: false, message: "Error processing withdrawal" });
  }
});

// ========== WEBHOOK ROUTES ==========

// Razorpay webhook for wallet deposits (payment.captured)
router.post("/deposit/webhook", async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(500).json({ success: false, message: "Webhook secret not configured" });
    }

    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(JSON.stringify(req.body))
      .digest("hex");

    if (expected !== signature) {
      return res.status(403).json({ success: false, message: "Invalid webhook signature" });
    }

    const event = req.body?.event;
    if (event !== "payment.captured") {
      return res.status(200).json({ success: true, ignored: true });
    }

    const payment = req.body?.payload?.payment?.entity;
    const paymentId = payment?.id;
    const orderId = payment?.order_id;
    const amount = Number(payment?.amount || 0) / 100;
    const phone = payment?.notes?.phone;
    const type = payment?.notes?.type;

    if (!paymentId || !phone || type !== "wallet_deposit" || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid webhook payload" });
    }

    // Idempotency: if payment already present, ACK success
    const existing = await Wallet.findOne({ phone, "transactions.paymentId": paymentId });
    if (existing) {
      return res.status(200).json({ success: true, duplicate: true });
    }

    const walletDoc = await Wallet.findOne({ phone });
    if (!walletDoc) {
      return res.status(404).json({ success: false, message: "Wallet not found for webhook user" });
    }
    const openingBalance = Number(walletDoc.balance || 0);
    const closingBalance = openingBalance + amount;

    const updatedWallet = await Wallet.findOneAndUpdate(
      { phone, "transactions.paymentId": { $ne: paymentId } },
      {
        $inc: { balance: amount },
        $push: {
          transactions: appendAuditFields({
            type: "deposit",
            amount,
            openingBalance,
            closingBalance,
            orderId,
            paymentId,
            status: "completed",
            description: `Wallet deposit via webhook (${paymentId})`,
            source: "webhook",
            provider: "razorpay",
            providerEventId: paymentId,
            metadata: { webhookEvent: event },
          }),
        },
      },
      { new: true }
    );

    if (!updatedWallet) {
      return res.status(200).json({ success: true, duplicate: true });
    }

    return res.status(200).json({ success: true, walletBalance: updatedWallet.balance });
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
    const expected = crypto
      .createHmac("sha256", webhookSecret)
      .update(JSON.stringify(req.body))
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

    // Rollback wallet on failed/reversed payout if not already rolled back
    if (mappedStatus === "failed" || mappedStatus === "reversed") {
      const wallet = await Wallet.findOne({ phone: withdrawal.phone });
      if (wallet) {
        const rollbackEventId = `rollback:${withdrawal._id.toString()}`;
        const alreadyRolledBack = wallet.transactions.some(
          (tx) => tx.providerEventId === rollbackEventId
        );
        if (!alreadyRolledBack) {
          const openingBalance = Number(wallet.balance || 0);
          const closingBalance = openingBalance + Number(withdrawal.amount || 0);
          wallet.balance = closingBalance;
          wallet.transactions.push(
            appendAuditFields({
              type: "refund",
              amount: Number(withdrawal.amount || 0),
              openingBalance,
              closingBalance,
              status: "completed",
              description: `Withdrawal rollback for ${withdrawal._id.toString()}`,
              source: "webhook",
              provider: "razorpay",
              providerEventId: rollbackEventId,
              metadata: { payoutEvent: event, payoutId },
            })
          );
          await wallet.save();
        }
      }
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
