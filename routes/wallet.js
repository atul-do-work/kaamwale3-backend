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
    const { amount } = req.body;
    
    if (!amount || amount < 100) {
      return res.status(400).json({ success: false, message: "Minimum deposit is ₹100" });
    }
    
    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_RsQNKDLMYY0pMB',
      key_secret: process.env.RAZORPAY_KEY_SECRET || 'gEmds37w05xlxtfcwYcdTWUi'
    });

    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `deposit_${req.user.phone}_${Date.now()}`,
      notes: {
        phone: req.user.phone,
        type: 'wallet_deposit'
      }
    });

    console.log(`💰 Deposit order created: ${order.id}, Amount: ₹${amount}`);

    res.json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_RsQNKDLMYY0pMB'
    });
  } catch (err) {
    console.error('Deposit order creation error:', err);
    res.status(500).json({ success: false, message: "Failed to create deposit order" });
  }
});

// ✅ VERIFY & COMPLETE DEPOSIT
router.post("/deposit/verify", authenticateToken, async (req, res) => {
  try {
    const { orderId, paymentId, signature, amount } = req.body;
    const crypto = require('crypto');

    // Verify signature
    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'gEmds37w05xlxtfcwYcdTWUi')
      .update(body)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    console.log(`✅ Deposit verified for order: ${orderId}`);

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone, balance: 0 });
    }

    wallet.balance += Number(amount);
    wallet.transactions.push({
      type: 'deposit',
      amount: Number(amount),
      date: new Date(),
      description: `Wallet deposit via Razorpay`
    });
    await wallet.save();

    console.log(`✅ Wallet updated: ${req.user.phone} deposited ₹${amount}`);

    res.json({
      success: true,
      message: 'Deposit successful',
      walletBalance: wallet.balance
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
    res.status(500).json({ success: false, message: "Error adding bank account" });
  }
});

// ========== WITHDRAWAL ROUTES ==========

// ✅ WITHDRAW to bank account (requires bank account)
router.post("/withdraw", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ success: false, message: "Invalid amount" });
    }

    if (amount < 100) {
      return res.status(400).json({ success: false, message: "Minimum withdrawal is ₹100" });
    }

    // Check if bank account exists and is verified
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

    // Check wallet balance
    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }
    
    if (wallet.balance < amount) {
      return res.status(400).json({ success: false, message: "Insufficient balance" });
    }

    // Deduct from wallet
    wallet.balance -= Number(amount);
    wallet.transactions.push({ 
      type: "withdraw", 
      amount: Number(amount), 
      date: new Date(),
      description: `Withdrawal to bank account ending in ${bankAccount.maskedAccount.slice(-4)}`
    });
    await wallet.save();

    console.log(`✅ Withdrawal initiated: ${req.user.phone}, Amount: ₹${amount}, Account: ${bankAccount.maskedAccount}`);

    // In production, you would:
    // 1. Call Razorpay Payouts API or similar
    // 2. Create withdrawal record in database
    // 3. Send notification to user
    // For now, we're just deducting from wallet

    res.json({ 
      success: true, 
      message: "Withdrawal initiated. Amount will be transferred to your bank account within 2-4 hours.",
      walletBalance: wallet.balance,
      withdrawalAmount: amount,
      bankAccount: bankAccount.maskedAccount
    });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ success: false, message: "Error processing withdrawal" });
  }
});

module.exports = router;
