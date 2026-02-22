const express = require("express");
const { authenticateToken } = require("../utils/auth");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const ActivityLog = require("../models/ActivityLog");

function createPremiumWalletRouter({ io }) {
  const router = express.Router();

  router.post("/premium/subscribe", authenticateToken, async (req, res) => {
    try {
      const { planId } = req.body;
      const user = await User.findOne({ phone: req.user.phone });

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const planPrice = planId === "basic" ? 399 : planId === "pro" ? 699 : 0;
      if (!planPrice) {
        return res.status(400).json({ success: false, message: "Invalid plan" });
      }

      let wallet = await Wallet.findOne({ phone: req.user.phone });
      if (!wallet) {
        wallet = new Wallet({ phone: req.user.phone, balance: 0, transactions: [] });
        await wallet.save();
      }

      if (wallet.balance < planPrice) {
        return res.status(400).json({
          success: false,
          message: `Insufficient balance. You have ₹${wallet.balance}, but plan costs ₹${planPrice}`,
        });
      }

      wallet.balance -= planPrice;
      wallet.transactions.push({
        type: "premium_subscription",
        amount: planPrice,
        planId,
        date: new Date(),
      });
      await wallet.save();

      const startDate = new Date();
      const endDate = new Date(startDate.getTime() + 30 * 24 * 60 * 60 * 1000);
      user.premiumPlan = {
        type: planId,
        price: planPrice,
        startDate,
        expiryDate: endDate,
        autoRenew: false,
      };
      await user.save();

      await ActivityLog.create({
        userId: req.user.phone,
        phone: req.user.phone,
        action: "premium_subscription",
        description: `Subscribed to ${planId} plan for ₹${planPrice}`,
        status: "success",
      });

      io.emit("premiumSubscriptionUpdate", {
        contractorPhone: req.user.phone,
        contractorName: user.name,
        planType: planId,
        timestamp: new Date(),
      });

      return res.json({
        success: true,
        message: `Successfully subscribed to ${planId} plan`,
        premiumPlan: user.premiumPlan,
        newBalance: wallet.balance,
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Subscription failed" });
    }
  });

  router.get("/premium/status", authenticateToken, async (req, res) => {
    try {
      const user = await User.findOne({ phone: req.user.phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const now = new Date();
      const isActive = user.premiumPlan?.expiryDate && user.premiumPlan.expiryDate > now;
      return res.json({
        success: true,
        premiumPlan: user.premiumPlan?.type || "free",
        isActive,
        premiumDetails: user.premiumPlan,
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to check status" });
    }
  });

  router.post("/premium/cancel", authenticateToken, async (req, res) => {
    try {
      const user = await User.findOne({ phone: req.user.phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      user.premiumPlan = {
        type: "free",
        price: 0,
        startDate: null,
        expiryDate: null,
        autoRenew: false,
      };
      await user.save();

      await ActivityLog.create({
        userId: req.user.phone,
        phone: req.user.phone,
        action: "premium_cancelled",
        description: "Premium plan cancelled",
        status: "success",
      });

      return res.json({ success: true, message: "Premium plan cancelled" });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to cancel plan" });
    }
  });

  router.get("/wallet/balance", authenticateToken, async (req, res) => {
    try {
      let wallet = await Wallet.findOne({ phone: req.user.phone });
      if (!wallet) {
        wallet = new Wallet({ phone: req.user.phone, balance: 0, transactions: [] });
        await wallet.save();
      }

      return res.json({ success: true, balance: wallet.balance });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to get balance" });
    }
  });

  router.get("/wallet/transactions", authenticateToken, async (req, res) => {
    try {
      const wallet = await Wallet.findOne({ phone: req.user.phone });
      if (!wallet) {
        return res.json({ success: true, transactions: [] });
      }

      const sortedTransactions = wallet.transactions.sort((a, b) => new Date(b.date) - new Date(a.date));
      const formattedTransactions = sortedTransactions.map((t) => {
        const transactionDate = new Date(t.date);
        const day = String(transactionDate.getDate()).padStart(2, "0");
        const month = String(transactionDate.getMonth() + 1).padStart(2, "0");
        const year = transactionDate.getFullYear();
        const dateStr = `${day}/${month}/${year}`;

        let hours = transactionDate.getHours();
        const minutes = String(transactionDate.getMinutes()).padStart(2, "0");
        const seconds = String(transactionDate.getSeconds()).padStart(2, "0");
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        hours = hours ? hours : 12;
        const hoursStr = String(hours).padStart(2, "0");
        const timeStr = `${hoursStr}:${minutes}:${seconds} ${ampm}`;

        return {
          id: t._id,
          type: t.type === "deposit" || t.type === "credit" ? "credit" : t.type === "refund" ? "refund" : "debit",
          description: t.description || `${t.type.charAt(0).toUpperCase() + t.type.slice(1)}`,
          amount: t.amount,
          date: `${dateStr} ${timeStr}`,
          status: "completed",
        };
      });

      return res.json({ success: true, transactions: formattedTransactions });
    } catch (err) {
      console.error("Transactions fetch error:", err);
      return res.status(500).json({ success: false, message: "Error fetching transactions" });
    }
  });

  router.get("/premium/plans", async (req, res) => {
    try {
      const plans = [
        {
          id: "basic",
          name: "Basic",
          price: 399,
          features: ["Bulk Hiring", "24/7 Instant", "Leaderboard"],
          popular: false,
        },
        {
          id: "pro",
          name: "Pro",
          price: 699,
          features: ["Bulk Hiring", "24/7 Instant", "Leaderboard", "Custom Add-ons"],
          popular: true,
        },
      ];
      return res.json({ success: true, plans });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to load plans" });
    }
  });

  router.post("/premium/add-ons", authenticateToken, async (req, res) => {
    try {
      const { addOns } = req.body;
      const user = await User.findOne({ phone: req.user.phone });

      if (!user || user.premiumPlan?.type === "free") {
        return res.status(400).json({
          success: false,
          message: "Must have active premium plan to add custom add-ons",
        });
      }

      return res.json({ success: true, message: "Custom add-ons feature coming soon" });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to add custom add-ons" });
    }
  });

  router.get("/leaderboard", async (req, res) => {
    try {
      const { limit = 10 } = req.query;
      const filter = { role: "contractor", points: { $gt: 0 } };
      if (req.user?.phone) {
        filter.phone = { $ne: req.user.phone };
      }

      const topUsers = await User.find(filter)
        .select("name phone profilePhoto points")
        .sort({ points: -1 })
        .limit(parseInt(limit, 10));

      return res.json({
        success: true,
        leaderboard: topUsers.map((user) => ({
          _id: user._id,
          phone: user.phone,
          name: user.name,
          profilePhoto: user.profilePhoto,
          points: user.points || 0,
        })),
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to fetch leaderboard" });
    }
  });

  return router;
}

module.exports = { createPremiumWalletRouter };
