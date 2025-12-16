// routes/wallet.js
const express = require("express");
const router = express.Router();
const { authenticateToken } = require("../utils/auth"); // ✅ Destructure from object
const Wallet = require("../models/Wallet");

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
    
    // Format transactions for frontend
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

// DEPOSIT
router.post("/deposit", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Invalid amount" });

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      wallet = new Wallet({ phone: req.user.phone, balance: 0 });
    }

    wallet.balance += Number(amount);
    wallet.transactions.push({ type: "deposit", amount, date: new Date() });
    await wallet.save();

    res.json({ success: true, wallet, message: "Deposit successful" });
  } catch (err) {
    console.error('Deposit error:', err);
    res.status(500).json({ success: false, message: "Error processing deposit" });
  }
});

// WITHDRAW
router.post("/withdraw", authenticateToken, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ success: false, message: "Invalid amount" });

    let wallet = await Wallet.findOne({ phone: req.user.phone });
    if (!wallet) {
      return res.status(404).json({ success: false, message: "Wallet not found" });
    }
    
    if (wallet.balance < amount) return res.status(400).json({ success: false, message: "Insufficient balance" });

    wallet.balance -= Number(amount);
    wallet.transactions.push({ type: "withdraw", amount, date: new Date() });
    await wallet.save();

    res.json({ success: true, wallet, message: "Withdrawal successful" });
  } catch (err) {
    console.error('Withdraw error:', err);
    res.status(500).json({ success: false, message: "Error processing withdrawal" });
  }
});

module.exports = router;
