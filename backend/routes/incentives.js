const express = require('express');
const router = express.Router();
const verifyToken = require('../utils/auth');
const Worker = require('../models/Worker');
const IncentiveLedger = require('../models/IncentiveLedger');
const Wallet = require('../models/Wallet');

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
router.get('/progress', verifyToken, async (req, res) => {
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

    // ✅ Get gigsData or initialize
    const gigsData = worker.gigsData || {};
    const workHistory = gigsData.workHistory || [];

    // ✅ CRITICAL: All calculations happen ONLY on backend
    // Frontend CANNOT manipulate this
    
    const eligibilityData = calculateEligibility(workHistory);

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
 *   transactionId: "incentive_5d_123456"
 * }
 */
router.post('/claim/:milestoneId', verifyToken, async (req, res) => {
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
    const gigsData = worker.gigsData || {};
    const workHistory = gigsData.workHistory || [];
    const eligibilityData = calculateEligibility(workHistory);

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

/**
 * HELPER: calculateEligibility (O(n) - Current Streak Only)
 * 
 * Production-grade eligibility calculation:
 * - ✅ O(n) time complexity (single pass, not nested loops)
 * - ✅ Current streak only (if stopped, streak resets)
 * - ✅ Minimum 8 hours per day enforcement
 * - ✅ Only paid jobs count
 * - ✅ Any cancellation in window disqualifies
 * 
 * Logic:
 * 1. Filter valid work days (date, hours >= 8, paymentStatus = 'Paid')
 * 2. Sort descending (latest first)
 * 3. Single pass: count consecutive days backwards from today
 * 4. Track cancellations in current streak
 * 
 * Returns:
 * {
 *   consecutiveDays: number,
 *   totalHours: number,
 *   cancellationsInWindow: number,
 *   lastWorkDate: string (YYYY-MM-DD),
 *   eligibleFor5Days: boolean,
 *   eligibleFor10Days: boolean,
 *   eligibleFor20Days: boolean
 * }
 */
function calculateEligibility(workHistory) {
  if (!Array.isArray(workHistory) || workHistory.length === 0) {
    return emptyEligibility();
  }

  try {
    // ✅ Step 1: Filter only valid completed work days
    const validHistory = workHistory
      .filter(h =>
        h.date &&
        h.hours >= 8 &&                      // Minimum 8 hours per day
        h.paymentStatus === 'Paid'           // Only completed/paid gigs
      )
      .map(h => ({
        dateObj: new Date(h.date),
        dateStr: new Date(h.date).toISOString().split('T')[0],
        hours: h.hours,
        cancelled: !!h.cancelled
      }))
      .sort((a, b) => b.dateObj - a.dateObj); // Descending (latest first)

    if (validHistory.length === 0) {
      return emptyEligibility();
    }

    // ✅ Step 2: Count consecutive days backwards from most recent
    let consecutiveDays = 0;
    let cancellationsInWindow = 0;

    for (let i = 0; i < validHistory.length; i++) {
      if (i === 0) {
        // First (most recent) day always counts
        consecutiveDays = 1;
        if (validHistory[i].cancelled) {
          cancellationsInWindow++;
        }
        continue;
      }

      // ✅ Check if previous day (i-1) is exactly 1 day before current day (i)
      const prevDay = validHistory[i - 1].dateObj;
      const currDay = validHistory[i].dateObj;
      const dayDiff = Math.floor((prevDay - currDay) / (1000 * 60 * 60 * 24));

      if (dayDiff === 1) {
        // Consecutive day found
        consecutiveDays++;
        if (validHistory[i].cancelled) {
          cancellationsInWindow++;
        }
      } else {
        // Streak broken (gap > 1 day)
        break;
      }
    }

    // ✅ Step 3: Determine eligibility
    const eligibleFor5Days = consecutiveDays >= 5 && cancellationsInWindow === 0;
    const eligibleFor10Days = consecutiveDays >= 10 && cancellationsInWindow === 0;
    const eligibleFor20Days = consecutiveDays >= 20 && cancellationsInWindow === 0;

    console.log(`✅ Eligibility: ${consecutiveDays} days, ${cancellationsInWindow} cancellations, eligible: [5D:${eligibleFor5Days}, 10D:${eligibleFor10Days}, 20D:${eligibleFor20Days}]`);

    return {
      consecutiveDays,
      totalHours: validHistory.reduce((sum, h) => sum + h.hours, 0),
      cancellationsInWindow,
      lastWorkDate: validHistory[0]?.dateStr || null, // Most recent work date
      eligibleFor5Days,
      eligibleFor10Days,
      eligibleFor20Days
    };
  } catch (err) {
    console.error('❌ Error calculating eligibility:', err);
    return emptyEligibility();
  }
}

/**
 * Empty eligibility for error states
 */
function emptyEligibility() {
  return {
    consecutiveDays: 0,
    totalHours: 0,
    cancellationsInWindow: 0,
    lastWorkDate: null,
    eligibleFor5Days: false,
    eligibleFor10Days: false,
    eligibleFor20Days: false
  };
}

module.exports = router;
