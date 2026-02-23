const express = require('express');
const router = express.Router();
const { authenticateToken } = require('../utils/auth');
const Worker = require('../models/Worker');
const IncentiveLedger = require('../models/IncentiveLedger');
const Wallet = require('../models/Wallet');
const GigHistory = require('../models/GigHistory');
const { calculateEligibility } = require('../services/incentiveEligibilityService');

/**
 * GET /incentives/progress
 * 
 * Returns backend-calculated incentive eligibility for the authenticated worker
 * 
 * Response:
 * {
 *   consecutiveDays: 6,
 *   totalHours: 48,
 *   cancellationsInWindow: 0,
 *   eligibleFor5Days: true,
 *   eligibleFor10Days: false,
 *   eligibleFor20Days: false,
 *   unlockedMilestones: ["5days"],
 *   claimedMilestones: [],
 *   availableMilestones: ["5days"],
 *   lastWorkDate: "2026-02-18"
 * }
 */
router.get('/progress', authenticateToken, async (req, res) => {
  try {
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    // ✅ Fetch worker document with complete gigs data
    const worker = await Worker.findOne({ phone });
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    const events = await GigHistory.find({ workerPhone: phone })
      .sort({ eventTime: -1 })
      .limit(365)
      .lean();
    const eligibilityData = calculateEligibility(events);

    // ✅ Fetch claimed milestones (to hide claim button if already claimed)
    const claimedMilestones = await IncentiveLedger.find({
      phone,
      'walletCredit.status': 'credited'
    }).select('milestoneId').lean();

    const claimedIds = claimedMilestones.map(m => m.milestoneId);

    // ✅ Determine available milestones (eligible AND not yet claimed)
    const availableMilestones = [];
    if (eligibilityData.eligibleFor5Days && !claimedIds.includes('5days')) {
      availableMilestones.push('5days');
    }
    if (eligibilityData.eligibleFor10Days && !claimedIds.includes('10days')) {
      availableMilestones.push('10days');
    }
    if (eligibilityData.eligibleFor20Days && !claimedIds.includes('20days')) {
      availableMilestones.push('20days');
    }

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
        eligibilityData.eligibleFor20Days ? '20days' : null
      ].filter(Boolean),
      claimedMilestones: claimedIds,
      availableMilestones,
      lastWorkDate: eligibilityData.lastWorkDate || null,
      calculatedAt: new Date()
    });
  } catch (err) {
    console.error('❌ Error in /incentives/progress:', err);
    return res.status(500).json({ 
      success: false, 
      message: 'Failed to calculate incentive progress',
      error: err.message 
    });
  }
});

/**
 * POST /incentives/claim/:milestoneId
 * 
 * Claim a milestone reward (₹50 / ₹150 / ₹300)
 * 
 * Flow:
 * 1. Verify user is eligible for this milestone
 * 2. Check if already claimed (idempotent)
 * 3. Create IncentiveLedger entry (unique constraint prevents duplicates)
 * 4. Credit wallet atomically
 * 5. Return success
 * 
 * Params: milestoneId = "5days" | "10days" | "20days"
 * 
 * Response:
 * {
 *   success: true,
 *   message: "Reward claimed and credited to wallet",
 *   rewardAmount: 50,
 *   newWalletBalance: 1250,
 *   transactionId: "incentile_5d_123456"
 * }
 */
router.post('/claim/:milestoneId', authenticateToken, async (req, res) => {
  try {
    const phone = req.user?.phone;
    const { milestoneId } = req.params;

    // ✅ Input validation
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    if (!['5days', '10days', '20days'].includes(milestoneId)) {
      return res.status(400).json({ success: false, message: 'Invalid milestone ID' });
    }

    // ✅ Fetch worker
    const worker = await Worker.findOne({ phone });
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    // ✅ Recalculate eligibility on backend (can't trust client)
    const events = await GigHistory.find({ workerPhone: phone })
      .sort({ eventTime: -1 })
      .limit(365)
      .lean();
    const eligibilityData = calculateEligibility(events);

    // ✅ Verify user is eligible for this milestone
    let isEligible = false;
    let rewardAmount = 0;

    if (milestoneId === '5days' && eligibilityData.eligibleFor5Days) {
      isEligible = true;
      rewardAmount = 50;
    } else if (milestoneId === '10days' && eligibilityData.eligibleFor10Days) {
      isEligible = true;
      rewardAmount = 150;
    } else if (milestoneId === '20days' && eligibilityData.eligibleFor20Days) {
      isEligible = true;
      rewardAmount = 300;
    }

    if (!isEligible) {
      return res.status(403).json({ 
        success: false, 
        message: `Not eligible for ${milestoneId} milestone`,
        consecutiveDays: eligibilityData.consecutiveDays,
        requiredDays: parseInt(milestoneId)
      });
    }

    // ✅ Check if already claimed (idempotent)
    const alreadyClaimed = await IncentiveLedger.findOne({
      phone,
      milestoneId,
      'walletCredit.status': 'credited'
    });

    if (alreadyClaimed) {
      return res.json({
        success: true,
        message: 'Reward already claimed',
        isDuplicate: true,
        rewardAmount,
        claimedAt: alreadyClaimed.claimedAt,
        walletBalance: (await Wallet.findOne({ phone }))?.balance || 0
      });
    }

    // ✅ Create IncentiveLedger entry (unique constraint enforces single claim)
    const ledgerEntry = new IncentiveLedger({
      phone,
      workerName: worker.name || 'Unknown',
      milestoneId,
      rewardAmount,
      eligibilityData: {
        consecutiveDays: eligibilityData.consecutiveDays,
        totalHours: eligibilityData.totalHours,
        cancellationsInWindow: eligibilityData.cancellationsInWindow,
        lastWorkDate: eligibilityData.lastWorkDate,
        verifiedAt: new Date()
      },
      walletCredit: {
        status: 'pending'
      },
      claimedBy: req.headers['user-agent'] || 'unknown',
      ipAddress: req.ip
    });

    let savedLedger;
    try {
      savedLedger = await ledgerEntry.save();
    } catch (err) {
      if (err.code === 11000) {
        // ✅ Duplicate key error - user already claimed this milestone
        const existingClaim = await IncentiveLedger.findOne({ phone, milestoneId });
        if (existingClaim && existingClaim.walletCredit?.status === 'credited') {
          return res.json({
            success: true,
            message: 'Reward already claimed',
            isDuplicate: true,
            rewardAmount,
            claimedAt: existingClaim.claimedAt,
            walletBalance: (await Wallet.findOne({ phone }))?.balance || 0
          });
        }
        throw err;
      }
      throw err;
    }

    // ✅ Credit wallet atomically (same pattern as payment verification)
    const walletUpdateResult = await Wallet.findOneAndUpdate(
      { phone },
      {
        $inc: { balance: rewardAmount },
        $push: {
          transactions: {
            type: 'incentive_reward',
            amount: rewardAmount,
            incentiveId: savedLedger._id.toString(),
            milestoneId,
            date: new Date(),
            description: `Incentive reward for ${milestoneId} milestone (₹${rewardAmount})`,
            status: 'completed'
          }
        }
      },
      { new: true, upsert: true }
    );

    if (!walletUpdateResult) {
      // ✅ Wallet credit failed - mark as failed in ledger
      await IncentiveLedger.updateOne(
        { _id: savedLedger._id },
        { 
          'walletCredit.status': 'failed',
          'walletCredit.error': 'Wallet update failed'
        }
      );

      return res.status(500).json({
        success: false,
        message: 'Failed to credit wallet',
        error: 'Wallet transaction failed'
      });
    }

    // ✅ Mark ledger as credited (idempotency achieved)
    await IncentiveLedger.updateOne(
      { _id: savedLedger._id },
      {
        'walletCredit.status': 'credited',
        'walletCredit.walletTransactionId': walletUpdateResult.transactions[walletUpdateResult.transactions.length - 1]?._id?.toString(),
        'walletCredit.creditedAt': new Date()
      }
    );

    // ✅ Emit socket event (for real-time UI update)
    if (global.io) {
      global.io.emit(`wallet:rewarded:${phone}`, {
        rewardAmount,
        milestoneId,
        newBalance: walletUpdateResult.balance,
        timestamp: new Date()
      });
    }

    console.log(`✅ Incentive Reward: ${phone} (${milestoneId}) ₹${rewardAmount} credited`);

    return res.json({
      success: true,
      message: 'Reward claimed and credited to wallet',
      rewardAmount,
      newWalletBalance: walletUpdateResult.balance,
      transactionId: savedLedger._id.toString(),
      claimedAt: new Date()
    });
  } catch (err) {
    console.error('❌ Error in /incentives/claim:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to claim reward',
      error: err.message
    });
  }
});

module.exports = router;
