const express = require("express");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { authenticateToken } = require("../utils/auth");
const { isPremiumEntitled } = require("../utils/premiumEntitlement");
const { getPlanEntitlements } = require("../config/premiumEntitlements");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const ActivityLog = require("../models/ActivityLog");
const PremiumSubscription = require("../models/PremiumSubscription");

function createPremiumWalletRouter({ io }) {
  const router = express.Router();

  const PLANS = {
    basic: { id: "basic", name: "Basic", price: 399, durationDays: 30, features: ["Bulk Hiring", "24/7 Instant", "Leaderboard"] },
    pro: { id: "pro", name: "Pro", price: 699, durationDays: 30, features: ["Bulk Hiring", "24/7 Instant", "Leaderboard", "Custom Add-ons"] },
  };

  function getIdempotencyKey(req) {
    const fromHeader = (req.headers["x-idempotency-key"] || "").toString().trim();
    const fromBody = (req.body?.idempotencyKey || "").toString().trim();
    const key = fromHeader || fromBody || null;

    // ✅ FIXED: Validate idempotency key format and uniqueness
    if (key) {
      // Must be alphanumeric with hyphens/underscores, 10-100 chars
      if (!/^[a-zA-Z0-9_-]{10,100}$/.test(key)) {
        throw Object.assign(new Error("Invalid idempotency key format"), { statusCode: 400 });
      }
    }

    return key;
  }

  function makeSubscriptionId(userPhone) {
    const suffix = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    return `sub_${userPhone}_${Date.now()}_${suffix}`;
  }

  function makeInvoiceId(userPhone) {
    const suffix = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    return `inv_${userPhone}_${Date.now()}_${suffix}`;
  }

  function makePremiumTxnId(userPhone) {
    const suffix = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex");
    return `ptx_${userPhone}_${Date.now()}_${suffix}`;
  }

  function normalizePremiumPlan(user) {
    if (!user?.premiumPlan) {
      return { type: "free", status: "free", entitlements: getPlanEntitlements("free") };
    }

    const now = new Date();
    const plan = { ...user.premiumPlan };
    const expiryDate = plan.expiryDate ? new Date(plan.expiryDate) : null;
    const graceUntil = plan.graceUntil ? new Date(plan.graceUntil) : null;

    if (expiryDate && expiryDate > now) {
      plan.status = "active";
    } else if (graceUntil && graceUntil > now) {
      plan.status = "grace";
    } else {
      plan.status = "expired";
    }

    plan.expiryDate = expiryDate;
    plan.graceUntil = graceUntil;
    plan.entitlements = plan.entitlements || getPlanEntitlements(plan.type || "free");
    return plan;
  }

  router.post("/premium/subscribe", authenticateToken, async (req, res) => {
    const session = await mongoose.startSession();
    try {
      const { planId, coupon = null, autoRenew = false } = req.body || {};
      const plan = PLANS[planId];
      const idempotencyKey = getIdempotencyKey(req);

      if (!plan) {
        return res.status(400).json({ success: false, message: "Invalid plan" });
      }
      if (!idempotencyKey) {
        return res.status(400).json({
          success: false,
          message: "Missing idempotency key. Send x-idempotency-key header or idempotencyKey in body.",
        });
      }

      let responsePayload = null;

      await session.withTransaction(async () => {
        const user = await User.findOne({ phone: req.user.phone }).session(session);
        if (!user) {
          throw Object.assign(new Error("User not found"), { statusCode: 404 });
        }
        const isContractor = String(req.user?.role || "").toLowerCase() === "contractor";

        const existingByKey = await PremiumSubscription.findOne({
          userPhone: req.user.phone,
          idempotencyKey,
        }).session(session);

        if (existingByKey) {
          let wallet = await Wallet.findOne({ phone: req.user.phone }).session(session);
          if (!wallet) {
            wallet = new Wallet({ phone: req.user.phone, balance: 0, availableBalance: 0, pocketBalance: 0, transactions: [] });
            await wallet.save({ session });
          }

          responsePayload = {
            success: true,
            idempotent: true,
            message: `Subscription already processed for plan ${existingByKey.plan || existingByKey.planType}`,
            premiumPlan: user.premiumPlan,
            newBalance: isContractor ? Number(wallet.pocketBalance || 0) : Number(wallet.balance || 0),
            newAvailableBalance: Number(wallet.availableBalance ?? wallet.balance ?? 0),
            newPocketBalance: Number(wallet.pocketBalance || 0),
            subscriptionId: existingByKey.subscriptionId,
            premiumTxnId: existingByKey.premiumTxnId,
            walletTxnId: existingByKey.walletTxnId,
          };
          return;
        }

        const activeExisting = await PremiumSubscription.findOne({
          userPhone: req.user.phone,
          isCurrent: true,
          status: { $in: ["active", "grace"] },
          expiryDate: { $gt: new Date() },
        }).session(session);

        if (activeExisting) {
          throw Object.assign(new Error("Active subscription already exists"), { statusCode: 409 });
        }

        let wallet = await Wallet.findOne({ phone: req.user.phone }).session(session);
        if (!wallet) {
          wallet = new Wallet({ phone: req.user.phone, balance: 0, availableBalance: 0, pocketBalance: 0, transactions: [] });
          await wallet.save({ session });
        }

        const rawPocket = Number(wallet.pocketBalance || 0);
        const rawAvailable = Number(wallet.availableBalance || wallet.balance || 0);
        const spendableBalance = isContractor ? rawPocket : rawAvailable;

        if (spendableBalance < plan.price) {
          throw Object.assign(
            new Error(`Insufficient balance. You have Rs ${spendableBalance}, but plan costs Rs ${plan.price}`),
            { statusCode: 400 }
          );
        }

        await PremiumSubscription.updateMany(
          { userPhone: req.user.phone, isCurrent: true },
          { $set: { isCurrent: false } },
          { session }
        );

        const now = new Date();
        const expiryDate = new Date(now.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
        // ✅ FIXED: Set 7-day grace period after expiry
        const graceUntil = new Date(expiryDate.getTime() + 7 * 24 * 60 * 60 * 1000);
        const renewalAt = new Date(expiryDate);
        const subscriptionId = makeSubscriptionId(req.user.phone);
        const premiumTxnId = makePremiumTxnId(req.user.phone);
        const invoiceId = makeInvoiceId(req.user.phone);
        const tax = 0;
        const walletTxnObjectId = new mongoose.Types.ObjectId();

        const subscription = await PremiumSubscription.create(
          [
            {
              subscriptionId,
              userPhone: req.user.phone,
              userName: user.name || "",
              premiumTxnId,
              eventType: "subscription_started",
              plan: planId,
              planType: planId,
              amount: plan.price,
              price: plan.price,
              currency: "INR",
              tax,
              coupon,
              status: "active",
              source: "wallet",
              autoRenew: Boolean(autoRenew),
              provider: "internal",
              gatewayOrderId: null,
              gatewayPaymentId: null,
              gatewaySubscriptionId: null,
              providerSubId: null,
              invoiceId,
              walletTxnId: String(walletTxnObjectId),
              idempotencyKey,
              startAt: now,
              endAt: expiryDate,
              renewalAt,
              startedAt: now,
              expiryDate,
              cancelAt: null,
              graceUntil, // ✅ FIXED: Include grace period
              failureReason: null,
              metadata: {
                source: "app",
                actorPhone: req.user.phone,
                role: req.user?.role || null,
                entitlements: getPlanEntitlements(planId),
              },
              isCurrent: true,
            },
          ],
          { session, ordered: true }
        );

        const createdSub = subscription[0];
        const chargedWallet = await Wallet.findOneAndUpdate(
          isContractor
            ? { phone: req.user.phone, pocketBalance: { $gte: plan.price } }
            : { phone: req.user.phone, availableBalance: { $gte: plan.price } },
          {
            $inc: isContractor ? { pocketBalance: -plan.price } : { availableBalance: -plan.price, balance: -plan.price },
            $push: {
              transactions: {
                _id: walletTxnObjectId,
                type: "premium_subscription",
                amount: plan.price,
                date: now,
                description: `Premium ${planId} subscription`,
                idempotencyKey: `${req.user.phone}:${idempotencyKey}`,
                status: "completed",
                openingBalance: spendableBalance,
                closingBalance: spendableBalance - plan.price,
                source: "app",
                provider: "internal",
                providerEventId: createdSub.subscriptionId,
                metadata: {
                  subscriptionId: createdSub.subscriptionId,
                  premiumTxnId: createdSub.premiumTxnId,
                  invoiceId: createdSub.invoiceId,
                  currency: createdSub.currency,
                  planType: planId,
                  source: "wallet",
                  walletTxnId: String(walletTxnObjectId),
                  deductedFrom: isContractor ? "pocketBalance" : "availableBalance",
                },
              },
            },
          },
          { new: true, session }
        );

        if (!chargedWallet) {
          throw Object.assign(
            new Error(`Insufficient balance. You have Rs ${spendableBalance}, but plan costs Rs ${plan.price}`),
            { statusCode: 400 }
          );
        }

        wallet = chargedWallet;
        const closingBalance = isContractor ? Number(wallet.pocketBalance || 0) : Number(wallet.balance || 0);
        const planEntitlements = getPlanEntitlements(planId);

        user.premiumPlan = {
          type: planId,
          price: plan.price,
          startDate: now,
          expiryDate,
          autoRenew: Boolean(autoRenew),
          subscriptionId: createdSub.subscriptionId,
          provider: createdSub.provider,
          providerSubId: createdSub.providerSubId,
          invoiceId: createdSub.invoiceId,
          currency: createdSub.currency,
          tax: createdSub.tax,
          coupon: createdSub.coupon,
          status: createdSub.status, // ✅ FIXED: Use status from subscription
          cancelAt: createdSub.cancelAt,
          graceUntil, // ✅ FIXED: Include grace period
          failureReason: createdSub.failureReason,
          renewalAt,
          entitlements: planEntitlements,
        };
        await user.save({ session });

        await ActivityLog.create(
          [
            {
              userId: req.user.phone,
              phone: req.user.phone,
              action: "premium_subscription",
              description: `Subscribed to ${planId} plan for Rs ${plan.price}`,
              status: "success",
              metadata: {
                subscriptionId: createdSub.subscriptionId,
                premiumTxnId: createdSub.premiumTxnId,
                walletTxnId: createdSub.walletTxnId,
                invoiceId: createdSub.invoiceId,
                idempotencyKey,
                source: "wallet",
              },
            },
            {
              userId: req.user.phone,
              phone: req.user.phone,
              action: "premium_activated",
              description: `Premium activated (${planId})`,
              status: "success",
              metadata: {
                planType: planId,
                subscriptionId: createdSub.subscriptionId,
                premiumTxnId: createdSub.premiumTxnId,
                expiryDate,
              },
            },
          ],
          { session, ordered: true }
        );

        responsePayload = {
          success: true,
          message: `Successfully subscribed to ${planId} plan`,
          premiumPlan: user.premiumPlan,
          newBalance: closingBalance,
          newAvailableBalance: Number(wallet.availableBalance ?? wallet.balance ?? 0),
          newPocketBalance: Number(wallet.pocketBalance || 0),
          subscriptionId: createdSub.subscriptionId,
          premiumTxnId: createdSub.premiumTxnId,
          walletTxnId: createdSub.walletTxnId,
          invoiceId: createdSub.invoiceId,
          entitlements: planEntitlements,
        };
      });

      if (responsePayload?.success) {
        io.to(req.user.phone).emit("premiumSubscriptionUpdate", {
          contractorPhone: req.user.phone,
          contractorName: req.user.name,
          eventType: "subscription_started",
          planType: responsePayload.premiumPlan?.type,
          status: responsePayload.premiumPlan?.status,
          subscriptionId: responsePayload.subscriptionId,
          expiryDate: responsePayload.premiumPlan?.expiryDate,
          graceUntil: responsePayload.premiumPlan?.graceUntil || null,
          entitlements: responsePayload.entitlements || responsePayload.premiumPlan?.entitlements || null,
          premiumPlan: responsePayload.premiumPlan || null,
          timestamp: new Date(),
        });

        io.to(req.user.phone).emit("walletUpdated", {
          phone: req.user.phone,
          balance: responsePayload.newBalance,
          availableBalance: Number(responsePayload.newAvailableBalance || 0),
          pocketBalance: Number(responsePayload.newPocketBalance || 0),
          source: "premium_subscription",
        });
      }

      return res.json(responsePayload || { success: false, message: "Subscription failed" });
    } catch (err) {
      const code = err.statusCode || 500;
      return res.status(code).json({ success: false, message: err.message || "Subscription failed" });
    } finally {
      session.endSession();
    }
  });

  router.get("/premium/status", authenticateToken, async (req, res) => {
    try {
      const user = await User.findOne({ phone: req.user.phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const normalizedPlan = normalizePremiumPlan(user);
      const isActive = isPremiumEntitled({ ...user.toObject(), premiumPlan: normalizedPlan });

      if (user.premiumPlan && normalizedPlan.status !== user.premiumPlan.status) {
        user.premiumPlan.status = normalizedPlan.status;
        user.premiumPlan.graceUntil = normalizedPlan.graceUntil || null;
        await user.save();
      }

      const currentSubscription = await PremiumSubscription.findOne({
        userPhone: req.user.phone,
        isCurrent: true,
      })
        .sort({ createdAt: -1 })
        .lean();

      return res.json({
        success: true,
        premiumPlan: normalizedPlan.type || "free",
        isActive,
        premiumDetails: normalizedPlan,
        subscription: currentSubscription || null,
        entitlements: normalizedPlan.entitlements,
      });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to check status" });
    }
  });

  router.post("/premium/cancel", authenticateToken, async (req, res) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const user = await User.findOne({ phone: req.user.phone }).session(session);
        if (!user) {
          throw Object.assign(new Error("User not found"), { statusCode: 404 });
        }

        await PremiumSubscription.updateMany(
          { userPhone: req.user.phone, isCurrent: true },
          { $set: { isCurrent: false } },
          { session }
        );

        const now = new Date();
        const premiumTxnId = makePremiumTxnId(req.user.phone);
        const cancelSnapshot = {
          subscriptionId: makeSubscriptionId(req.user.phone),
          userPhone: req.user.phone,
          userName: user.name || "",
          premiumTxnId,
          eventType: "subscription_cancelled",
          plan: "free",
          planType: "free",
          amount: 0,
          price: 0,
          currency: "INR",
          tax: 0,
          coupon: null,
          status: "cancelled",
          source: "wallet",
          autoRenew: false,
          provider: "internal",
          gatewayOrderId: null,
          gatewayPaymentId: null,
          gatewaySubscriptionId: null,
          providerSubId: null,
          invoiceId: null,
          walletTxnId: null,
          idempotencyKey: null,
          startAt: now,
          endAt: null,
          renewalAt: null,
          startedAt: now,
          expiryDate: null,
          cancelAt: now,
          graceUntil: null,
          failureReason: null,
          metadata: { source: "app", actorPhone: req.user.phone },
          isCurrent: true,
        };

        await PremiumSubscription.create([cancelSnapshot], { session, ordered: true });

        user.premiumPlan = {
          type: "free",
          price: 0,
          startDate: null,
          expiryDate: null,
          autoRenew: false,
          subscriptionId: null,
          provider: "internal",
          providerSubId: null,
          invoiceId: null,
          currency: "INR",
          tax: 0,
          coupon: null,
          status: "inactive", // ✅ FIXED: Set status to inactive
          cancelAt: now,
          graceUntil: null, // ✅ FIXED: Clear grace period on cancellation
          failureReason: null,
          renewalAt: null,
          entitlements: getPlanEntitlements("free"),
        };
        await user.save({ session });

        await ActivityLog.create(
          [
            {
              userId: req.user.phone,
              phone: req.user.phone,
              action: "premium_cancelled",
              description: "Premium plan cancelled",
              status: "success",
              metadata: { premiumTxnId },
            },
          ],
          { session, ordered: true }
        );
      });

      io.to(req.user.phone).emit("premiumSubscriptionUpdate", {
        contractorPhone: req.user.phone,
        contractorName: req.user.name,
        planType: "free",
        subscriptionId: null,
        expiryDate: null,
        graceUntil: null,
        status: "inactive",
        eventType: "premium_cancelled",
        entitlements: getPlanEntitlements("free"),
        premiumPlan: {
          type: "free",
          status: "inactive",
          expiryDate: null,
          graceUntil: null,
          entitlements: getPlanEntitlements("free"),
        },
        timestamp: new Date(),
      });

      return res.json({ success: true, message: "Premium plan cancelled" });
    } catch (err) {
      const code = err.statusCode || 500;
      return res.status(code).json({ success: false, message: err.message || "Failed to cancel plan" });
    } finally {
      session.endSession();
    }
  });

  router.get("/wallet/balance", authenticateToken, async (req, res) => {
    try {
      let wallet = await Wallet.findOne({ phone: req.user.phone });
      if (!wallet) {
        wallet = new Wallet({ phone: req.user.phone, balance: 0, availableBalance: 0, pocketBalance: 0, transactions: [] });
        await wallet.save();
      }

      const isContractor = String(req.user?.role || "").toLowerCase() === "contractor";
      const displayBalance = isContractor ? Number(wallet.pocketBalance || 0) : Number(wallet.availableBalance ?? wallet.balance ?? 0);
      return res.json({
        success: true,
        balance: displayBalance,
        availableBalance: Number(wallet.availableBalance ?? wallet.balance ?? 0),
        pocketBalance: Number(wallet.pocketBalance || 0),
      });
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
      const plans = Object.values(PLANS).map((plan) => ({
        ...plan,
        popular: plan.id === "pro",
        entitlements: getPlanEntitlements(plan.id),
      }));
      return res.json({ success: true, plans });
    } catch (err) {
      return res.status(500).json({ success: false, message: "Failed to load plans" });
    }
  });

  return router;
}

module.exports = { createPremiumWalletRouter };
