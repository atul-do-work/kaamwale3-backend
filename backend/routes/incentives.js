const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authenticateToken } = require('../utils/auth');
const Worker = require('../models/Worker');
const IncentiveLedger = require('../models/IncentiveLedger');
const Wallet = require('../models/Wallet');
const GigHistory = require('../models/GigHistory');
const { calculateEligibility } = require('../services/incentiveEligibilityService');

router.get('/progress', authenticateToken, async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const worker = await Worker.findOne({ phone });
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    const events = await GigHistory.find({ workerPhone: phone })
      .sort({ eventTime: -1 })
      .limit(365)
      .lean();
    const eligibilityData = calculateEligibility(events);

    const claimedMilestones = await IncentiveLedger.find({
      phone,
      'walletCredit.status': 'credited'
    }).select('milestoneId').lean();

    const claimedIds = claimedMilestones.map((m) => m.milestoneId);

    const availableMilestones = [];
    if (eligibilityData.eligibleFor5Days && !claimedIds.includes('5days')) availableMilestones.push('5days');
    if (eligibilityData.eligibleFor10Days && !claimedIds.includes('10days')) availableMilestones.push('10days');
    if (eligibilityData.eligibleFor20Days && !claimedIds.includes('20days')) availableMilestones.push('20days');

    return res.json({
      success: true,
      consecutiveDays: eligibilityData.consecutiveDays,
      totalHours: eligibilityData.totalHours,
      cancellationsInWindow: eligibilityData.cancellationsInWindow,
      eligibleFor5Days: eligibilityData.eligibleFor5Days,
      eligibleFor10Days: eligibilityData.eligibleFor10Days,
      eligibleFor20Days: eligibilityData.eligibleFor20Days,
      unlockedMilestones: [
        eligibilityData.eligibleFor5Days ? '5days' : null,
        eligibilityData.eligibleFor10Days ? '10days' : null,
        eligibilityData.eligibleFor20Days ? '20days' : null,
      ].filter(Boolean),
      claimedMilestones: claimedIds,
      availableMilestones,
      lastWorkDate: eligibilityData.lastWorkDate || null,
      calculatedAt: new Date(),
    });
  } catch (err) {
    console.error('Error in /incentives/progress:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to calculate incentive progress',
      error: err.message,
    });
  }
});

router.post('/claim/:milestoneId', authenticateToken, async (req, res) => {
  const session = await mongoose.startSession();
  try {
    const phone = req.user?.phone;
    const { milestoneId } = req.params;

    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    if (!['5days', '10days', '20days'].includes(milestoneId)) {
      return res.status(400).json({ success: false, message: 'Invalid milestone ID' });
    }

    const worker = await Worker.findOne({ phone });
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    const events = await GigHistory.find({ workerPhone: phone })
      .sort({ eventTime: -1 })
      .limit(365)
      .lean();
    const eligibilityData = calculateEligibility(events);

    let rewardAmount = 0;
    if (milestoneId === '5days' && eligibilityData.eligibleFor5Days) rewardAmount = 50;
    if (milestoneId === '10days' && eligibilityData.eligibleFor10Days) rewardAmount = 150;
    if (milestoneId === '20days' && eligibilityData.eligibleFor20Days) rewardAmount = 300;

    if (!rewardAmount) {
      return res.status(403).json({
        success: false,
        message: `Not eligible for ${milestoneId} milestone`,
        consecutiveDays: eligibilityData.consecutiveDays,
        requiredDays: parseInt(milestoneId, 10),
      });
    }

    let walletUpdateResult = null;
    let responsePayload = null;

    await session.withTransaction(async () => {
      const alreadyClaimed = await IncentiveLedger.findOne({
        phone,
        milestoneId,
        'walletCredit.status': 'credited',
      }).session(session);

      if (alreadyClaimed) {
        const existingWallet = await Wallet.findOne({ phone }).select('availableBalance balance').session(session);
        responsePayload = {
          success: true,
          message: 'Reward already claimed',
          isDuplicate: true,
          rewardAmount,
          claimedAt: alreadyClaimed.createdAt || alreadyClaimed.updatedAt,
          walletBalance: Number(existingWallet?.availableBalance ?? existingWallet?.balance ?? 0),
        };
        return;
      }

      const ledgerDocs = await IncentiveLedger.create(
        [{
          phone,
          workerName: worker.name || 'Unknown',
          milestoneId,
          rewardAmount,
          eligibilityData: {
            consecutiveDays: eligibilityData.consecutiveDays,
            totalHours: eligibilityData.totalHours,
            cancellationsInWindow: eligibilityData.cancellationsInWindow,
            lastWorkDate: eligibilityData.lastWorkDate,
            verifiedAt: new Date(),
          },
          walletCredit: { status: 'processing' },
          claimedBy: req.headers['user-agent'] || 'unknown',
          ipAddress: req.ip,
        }],
        { session }
      );

      const ledgerDoc = ledgerDocs[0];

      walletUpdateResult = await Wallet.findOneAndUpdate(
        { phone },
        {
          $inc: { balance: rewardAmount, availableBalance: rewardAmount, totalEarned: rewardAmount },
          $push: {
            transactions: {
              type: 'incentive_reward',
              amount: rewardAmount,
              incentiveId: ledgerDoc._id.toString(),
              milestoneId,
              date: new Date(),
              description: `Incentive reward for ${milestoneId} milestone (Rs ${rewardAmount})`,
              status: 'completed',
              source: 'app',
              provider: 'internal',
              providerEventId: `incentive:${ledgerDoc._id.toString()}`,
              idempotencyKey: `incentive:${phone}:${milestoneId}`,
              metadata: { source: 'incentive' },
            },
          },
        },
        { new: true, upsert: true, session }
      );

      if (!walletUpdateResult) {
        throw new Error('Wallet transaction failed');
      }

      const latestTx = walletUpdateResult.transactions[walletUpdateResult.transactions.length - 1];
      await IncentiveLedger.updateOne(
        { _id: ledgerDoc._id },
        {
          $set: {
            'walletCredit.status': 'credited',
            'walletCredit.walletTransactionId': latestTx?._id?.toString(),
            'walletCredit.creditedAt': new Date(),
          },
        },
        { session }
      );

      responsePayload = {
        success: true,
        message: 'Reward claimed and credited to wallet',
        rewardAmount,
        newWalletBalance: Number(walletUpdateResult.availableBalance ?? walletUpdateResult.balance ?? 0),
        transactionId: ledgerDoc._id.toString(),
        claimedAt: new Date(),
      };
    });

    if (global.io && walletUpdateResult) {
      global.io.emit(`wallet:rewarded:${phone}`, {
        rewardAmount,
        milestoneId,
        newBalance: Number(walletUpdateResult.availableBalance ?? walletUpdateResult.balance ?? 0),
        timestamp: new Date(),
      });
    }

    console.log(`Incentive reward credited: ${phone} (${milestoneId}) Rs ${rewardAmount}`);
    return res.json(responsePayload);
  } catch (err) {
    if (err && err.code === 11000) {
      try {
        const phone = req.user?.phone;
        const { milestoneId } = req.params;
        const existingClaim = await IncentiveLedger.findOne({ phone, milestoneId, 'walletCredit.status': 'credited' });
        if (existingClaim) {
          const existingWallet = await Wallet.findOne({ phone }).select('availableBalance balance');
          return res.json({
            success: true,
            message: 'Reward already claimed',
            isDuplicate: true,
            rewardAmount: existingClaim.rewardAmount,
            claimedAt: existingClaim.createdAt || existingClaim.updatedAt,
            walletBalance: Number(existingWallet?.availableBalance ?? existingWallet?.balance ?? 0),
          });
        }
      } catch (dupErr) {
        console.error('Duplicate claim handling failed:', dupErr);
      }
    }

    console.error('Error in /incentives/claim:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to claim reward',
      error: err.message,
    });
  } finally {
    session.endSession();
  }
});

module.exports = router;
