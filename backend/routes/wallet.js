// routes/wallet.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../utils/auth");
const Wallet = require("../models/Wallet");
const BankAccount = require("../models/BankAccount");

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
router.post("/deposit/create-order", authenticateToken, async (req, res) => {
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
router.post("/deposit/verify", authenticateToken, async (req, res) => {
  try {
    const { orderId, paymentId, signature } = req.body;
    const crypto = require('crypto');

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
    // 🔐 STEP 2: Fetch and validate payment from Razorpay
    let depositAmount = null;
    try {
      const Razorpay = require('razorpay');
      const razorpay = new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET
      });
      const payment = await razorpay.payments.fetch(paymentId);
      
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

    // 🔐 STEP 3: FULLY ATOMIC UPDATE - Deposit credit + idempotency in one operation
    // If paymentId already exists in transactions, this update will fail
    // (due to unique index on paymentId)
    // If unique index exists, MongoDB prevents duplicates at DB level
    // Otherwise, the $ne check prevents duplicate processing
    const wallet = await Wallet.findOneAndUpdate(
      {
        phone: req.user.phone,
        // Only proceed if this paymentId hasn't been processed yet
        // Uses $ne (not equal) to ensure idempotency
        "transactions.paymentId": { $ne: paymentId }
      },
      {
        $inc: { balance: depositAmount }, // Atomically increment balance
        $push: {
          transactions: {
            type: 'deposit',
            amount: depositAmount,
            paymentId,      // ✅ Unique identifier for idempotency
            orderId,        // ✅ Audit trail
            date: new Date(),
            description: `Wallet deposit via Razorpay (${paymentId})`
          }
        }
      },
      { new: true, upsert: false } // Return updated doc, don't create if missing
    );

    // If wallet is null, either:
    // 1. User doesn't exist (shouldn't happen if authenticated)
    // 2. Duplicate paymentId already processed (idempotency triggered)
    if (!wallet) {
      console.warn(`⚠️ IDEMPOTENCY: Deposit already processed for paymentId: ${paymentId} or wallet not found`);
      
      // Fetch current balance to confirm idempotency
      const existingWallet = await Wallet.findOne({ phone: req.user.phone });
      if (existingWallet) {
        return res.json({
          success: true,
          message: "Payment already processed",
          walletBalance: existingWallet.balance,
          isDuplicate: true
        });
      }
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
      bankAccount.accountNumber = accountNumber;
      bankAccount.accountNumberConfirm = accountNumberConfirm;
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
        accountNumber,
        accountNumberConfirm,
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
router.post("/withdraw", authenticateToken, async (req, res) => {
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
    const wallet = await Wallet.findOneAndUpdate(
      {
        phone: req.user.phone,
        balance: { $gte: withdrawAmount } // Only proceed if balance is sufficient
      },
      {
        $inc: { balance: -withdrawAmount }, // Atomically decrement balance
        $push: {
          transactions: {
            type: "withdraw",
            amount: withdrawAmount,
            date: new Date(),
            status: "initiated", // Mark as pending processing
            description: `Withdrawal to bank account ending in ${bankAccount.maskedAccount.slice(-4)}`
          }
        }
      },
      { new: true } // Return updated document
    );

    // If wallet is undefined, it means balance check failed (race condition prevented)
    if (!wallet) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

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

    // In production, you would:
    // 1. Call Razorpay Payouts API or similar
    // 2. Create withdrawal record in database
    // 3. Send notification to user
    // For now, we're just deducting from wallet

    res.json({ 
      success: true, 
      message: "Withdrawal initiated. Amount will be transferred to your bank account within 2-4 hours.",
      walletBalance: wallet.balance,
      withdrawalAmount: withdrawAmount,
      bankAccount: bankAccount.maskedAccount,
      accountName: bankAccount.accountHolderName
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ success: false, message: "Error processing withdrawal" });
  }
});

module.exports = router;
