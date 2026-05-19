const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const { authenticateToken } = require('../utils/auth');
const Worker = require('../models/Worker');
const IncentiveLedger = require('../models/IncentiveLedger');
const Wallet = require('../models/Wallet');
const WorkerEarnings = require('../models/WorkerEarnings');
const GigHistory = require('../models/GigHistory');
const Job = require('../models/Jobs');
const {
  calculateEligibility,
  MILESTONE_REWARDS,
  MILESTONE_IDS,
  buildClaimStatusByMilestone,
  emitIncentiveUpdatedEvent,
} = require('../services/incentiveEligibilityService');

const normalizePhoneDigits = (value) => String(value || '').replace(/\D/g, '').slice(-10);
const setNoStore = (req, res) => {
  if (req?.headers) {
    delete req.headers['if-none-match'];
    delete req.headers['if-modified-since'];
  }
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
};
const buildPhoneOr = (field, phone) => {
  const raw = String(phone || '').trim();
  const digits = normalizePhoneDigits(raw);
  const variants = Array.from(new Set([raw, digits].filter(Boolean)));
  return [
    { [field]: { $in: variants } },
    ...(digits ? [{ [field]: { $regex: `${digits}$` } }] : []),
  ];
};

async function hydrateEventsWithPaidJobs(phone, events) {
  const baseEvents = Array.isArray(events) ? [...events] : [];
  if (!phone) return baseEvents;
  const phoneDigits = normalizePhoneDigits(phone);
  const samePhone = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return false;
    const rawDigits = normalizePhoneDigits(raw);
    return (!!phoneDigits && rawDigits === phoneDigits) || raw === String(phone || '').trim();
  };

  const completedEventJobIds = new Set(
    baseEvents
      .filter((e) => String(e?.eventType || '') === 'job_completed' && e?.jobId)
      .map((e) => String(e.jobId))
  );

  const paidJobs = await Job.find({
    $or: [
      ...buildPhoneOr('acceptedBy', phone),
      ...buildPhoneOr('acceptedWorker.phone', phone),
      ...buildPhoneOr('acceptedWorkers.phone', phone),
    ],
  })
    .select('_id title contractorPhone contractorName status paymentStatus paymentTime hoursWorked timeSpentMinutes createdAt acceptedBy acceptedWorker acceptedWorkers')
    .lean();

  for (const job of paidJobs) {
    const jobId = String(job?._id || '');
    if (!jobId || completedEventJobIds.has(jobId)) continue;

    const paidWorkerEntry = Array.isArray(job?.acceptedWorkers)
      ? job.acceptedWorkers.find((w) =>
          samePhone(w?.phone || w?.workerPhone) &&
          String(w?.paymentStatus || '').toLowerCase() === 'paid'
        )
      : null;
    const isSingleWorkerPaid =
      samePhone(job?.acceptedBy || job?.acceptedWorker?.phone) &&
      String(job?.paymentStatus || '').toLowerCase() === 'paid';
    if (!paidWorkerEntry && !isSingleWorkerPaid) continue;

    const timeSpentMinutes = Number(job?.timeSpentMinutes || 0);
    const derivedHours = Number(job?.hoursWorked || (timeSpentMinutes > 0 ? timeSpentMinutes / 60 : 0));
    baseEvents.push({
      workerPhone: phone,
      jobId,
      eventType: 'job_completed',
      eventTime: paidWorkerEntry?.paymentTime || job?.paymentTime || job?.createdAt || new Date(),
      hoursWorked: Math.round(derivedHours * 10) / 10,
      timeSpentMinutes,
      status: job?.status || '',
      paymentStatus: 'paid',
      metadata: { source: 'jobs-fallback' },
    });
  }

  return baseEvents;
}

async function persistEligibilityAuditSnapshot(worker, eligibilityData) {
  if (!worker || !eligibilityData) return;
  const toAllowedLower = (value, allowed, fallback) => {
    const normalized = String(value || '').trim().toLowerCase();
    return allowed.has(normalized) ? normalized : fallback;
  };

  if (Array.isArray(worker.recentGigs) && worker.recentGigs.length > 0) {
    for (const gig of worker.recentGigs) {
      if (!gig) continue;
      if (gig.paymentStatus !== undefined && gig.paymentStatus !== null) {
        gig.paymentStatus = toAllowedLower(gig.paymentStatus, new Set(['paid', 'pending', 'failed']), 'pending');
      }
      if (gig.status !== undefined && gig.status !== null) {
        gig.status = toAllowedLower(gig.status, new Set(['accepted', 'completed', 'cancelled', 'pending']), 'pending');
      }
    }
  }

  const rows = Array.isArray(eligibilityData.dailyQualificationTrail)
    ? eligibilityData.dailyQualificationTrail.slice(0, 35)
    : [];

  worker.gigsData = worker.gigsData || {};
  worker.gigsData.workHistory = rows.map((r) => ({
    date: r?.date ? new Date(`${r.date}T00:00:00.000Z`) : new Date(),
    hours: Number(r?.hoursWorked || 0),
    jobsCompleted: Number(r?.jobsCompleted || 0),
    declinesCount: Number(r?.declinesCount || 0),
    hasCompletedJob: Boolean(r?.hasCompletedJob),
    meetsMinimumHours: Boolean(r?.meetsMinimumHours),
    meetsNoDeclines: Boolean(r?.meetsNoDeclines),
    qualified: Boolean(r?.qualified),
    cancelled: Number(r?.declinesCount || 0) > 0,
    snapshotAt: new Date(),
  }));
  worker.gigsData.lastUpdated = new Date();
  await worker.save({ validateModifiedOnly: true });
}

router.get('/progress', authenticateToken, async (req, res) => {
  try {
    setNoStore(req, res);
    const phone = req.user?.phone;
    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }

    const worker = await Worker.findOne({ $or: buildPhoneOr('phone', phone) });
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    const events = await GigHistory.find({ $or: buildPhoneOr('workerPhone', phone) })
      .sort({ eventTime: -1 })
      .limit(365)
      .lean();
    const hydratedEvents = await hydrateEventsWithPaidJobs(phone, events);
    const eligibilityData = calculateEligibility(hydratedEvents);
    await persistEligibilityAuditSnapshot(worker, eligibilityData);

    const ledgerRecords = await IncentiveLedger.find({
      phone,
      milestoneId: { $in: MILESTONE_IDS },
    }).lean();

    const claimStatusByMilestone = buildClaimStatusByMilestone(eligibilityData, ledgerRecords);
    const claimedIds = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'claimed');
    const availableMilestones = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'available');
    const pendingMilestones = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'processing');
    const failedMilestones = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'failed');

    return res.json({
      success: true,
      consecutiveDays: eligibilityData.consecutiveDays,
      totalHours: eligibilityData.totalHours,
      cancellationsInWindow: eligibilityData.cancellationsInWindow,
      requiredDailyHours: eligibilityData.requiredDailyHours || 8,
      requiredDaysFor5: eligibilityData.requiredDaysFor5 || 5,
      dailyQualificationTrail: eligibilityData.dailyQualificationTrail || [],
      fiveDayWindow: eligibilityData.fiveDayWindow || null,
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
      pendingMilestones,
      failedMilestones,
      claimStatusByMilestone,
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
  try {
    const phone = req.user?.phone;
    const { milestoneId } = req.params;

    if (!phone) {
      return res.status(401).json({ success: false, message: 'Not authenticated' });
    }
    if (!['5days', '10days', '20days'].includes(milestoneId)) {
      return res.status(400).json({ success: false, message: 'Invalid milestone ID' });
    }

    const worker = await Worker.findOne({ $or: buildPhoneOr('phone', phone) });
    if (!worker) {
      return res.status(404).json({ success: false, message: 'Worker not found' });
    }

    const events = await GigHistory.find({ $or: buildPhoneOr('workerPhone', phone) })
      .sort({ eventTime: -1 })
      .limit(365)
      .lean();
    const hydratedEvents = await hydrateEventsWithPaidJobs(phone, events);
    const eligibilityData = calculateEligibility(hydratedEvents);
    await persistEligibilityAuditSnapshot(worker, eligibilityData);

    const rewardAmount = MILESTONE_REWARDS[milestoneId] || 0;
    const eligibleFlag = milestoneId === '5days'
      ? eligibilityData.eligibleFor5Days
      : milestoneId === '10days'
      ? eligibilityData.eligibleFor10Days
      : milestoneId === '20days'
      ? eligibilityData.eligibleFor20Days
      : false;

    if (!rewardAmount || !eligibleFlag) {
      return res.status(403).json({
        success: false,
        message: `Not eligible for ${milestoneId} milestone`,
        consecutiveDays: eligibilityData.consecutiveDays,
        requiredDays: parseInt(milestoneId, 10),
      });
    }

    let walletUpdateResult = null;
    let responsePayload = null;

    // NOTE: Unique index on IncentiveLedger(phone,milestoneId) should be created at app startup/migration

    // Attempt atomic upsert: create ledger document only if not exists.
    const now = new Date();
    const ledgerUpsertDoc = {
      phone,
      workerName: worker.name || 'Unknown',
      milestoneId,
      rewardAmount,
      eligibilityData: {
        consecutiveDays: eligibilityData.consecutiveDays,
        totalHours: eligibilityData.totalHours,
        cancellationsInWindow: eligibilityData.cancellationsInWindow,
        requiredDailyHours: eligibilityData.requiredDailyHours || 8,
        requiredDaysFor5: eligibilityData.requiredDaysFor5 || 5,
        fiveDayWindow: {
          daysMetMinimumHours: Number(eligibilityData.fiveDayWindow?.daysMetMinimumHours || 0),
          allDaysHaveMinHours: Boolean(eligibilityData.fiveDayWindow?.allDaysHaveMinHours),
          startDate: eligibilityData.fiveDayWindow?.startDate || null,
          endDate: eligibilityData.fiveDayWindow?.endDate || null,
          failedDates: Array.isArray(eligibilityData.fiveDayWindow?.failedDates) ? eligibilityData.fiveDayWindow.failedDates : [],
          failureReason: eligibilityData.fiveDayWindow?.failureReason || null,
        },
        dailyQualificationTrail: Array.isArray(eligibilityData.dailyQualificationTrail)
          ? eligibilityData.dailyQualificationTrail.slice(0, 35)
          : [],
        lastWorkDate: eligibilityData.lastWorkDate,
        verifiedAt: now,
      },
      walletCredit: { status: 'processing' },
      claimedBy: req.headers['user-agent'] || 'unknown',
      ipAddress: req.ip,
      createdAt: now,
    };

    let upsertResult;
    try {
      upsertResult = await IncentiveLedger.collection.findOneAndUpdate(
        { phone, milestoneId },
        { $setOnInsert: ledgerUpsertDoc },
        { upsert: true, returnDocument: 'after' }
      );
    } catch (upsertErr) {
      // Duplicate key or other errors mean another request likely inserted concurrently
      if (upsertErr && upsertErr.code === 11000) {
        const existing = await IncentiveLedger.findOne({ phone, milestoneId }).select('walletCredit rewardAmount createdAt updatedAt').lean();
        const existingWallet = await Wallet.findOne({ phone }).select('availableBalance balance').lean();
        const alreadyCredited = existing?.walletCredit?.status === 'credited';
        return res.json({
          success: alreadyCredited,
          message: alreadyCredited ? 'Reward already claimed' : 'Reward claim already in progress',
          isDuplicate: true,
          rewardAmount: existing?.rewardAmount || rewardAmount,
          claimedAt: existing?.createdAt || existing?.updatedAt,
          walletBalance: Number(existingWallet?.availableBalance ?? existingWallet?.balance ?? 0),
        });
      }
      throw upsertErr;
    }

    const ledgerDoc = upsertResult.value;
    // If the upsert returned an existing document (already had a ledger), treat as duplicate
    const wasInserted = !upsertResult.lastErrorObject || upsertResult.lastErrorObject.updatedExisting === false;
    if (!wasInserted) {
      const existingWallet = await Wallet.findOne({ phone }).select('availableBalance balance').lean();
      const alreadyCredited = ledgerDoc?.walletCredit?.status === 'credited';
      responsePayload = {
        success: alreadyCredited,
        message: alreadyCredited ? 'Reward already claimed' : 'Reward claim already in progress',
        isDuplicate: true,
        rewardAmount: ledgerDoc.rewardAmount || rewardAmount,
        claimedAt: ledgerDoc.createdAt || ledgerDoc.updatedAt,
        walletBalance: Number(existingWallet?.availableBalance ?? existingWallet?.balance ?? 0),
      };
      return res.json(responsePayload);
    }

    // Proceed to credit wallet. If this fails, mark ledger as failed and bubble error.
    try {
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
              metadata: { source: 'incentive', balanceType: 'available' },
            },
          },
        },
        { new: true, upsert: true }
      );

      if (!walletUpdateResult) {
        // mark ledger as failed
        await IncentiveLedger.updateOne({ _id: ledgerDoc._id }, { $set: { 'walletCredit.status': 'failed', 'walletCredit.failedAt': new Date() } });
        throw new Error('Wallet transaction failed');
      }

      const latestTx = walletUpdateResult.transactions[walletUpdateResult.transactions.length - 1];
      await IncentiveLedger.updateOne({ _id: ledgerDoc._id }, { $set: { 'walletCredit.status': 'credited', 'walletCredit.walletTransactionId': latestTx?._id?.toString(), 'walletCredit.creditedAt': new Date() } });

      // ✅ Create WorkerEarnings entry for incentive reward (for analytics and weekly payouts)
      try {
        const idempotencyKeyEarnings = `incentive_earnings:${phone}:${milestoneId}`;
        const consecutiveDays = ledgerDoc?.eligibilityData?.consecutiveDays || eligibilityData.consecutiveDays;
        await WorkerEarnings.findOneAndUpdate(
          { workerPhone: phone, idempotencyKey: idempotencyKeyEarnings },
          {
            workerPhone: phone,
            jobId: null,
            amount: rewardAmount,
            currency: 'INR',
            status: 'earned',
            source: 'app',
            provider: 'internal',
            earnedAt: new Date(),
            contractorName: 'System Incentive',
            jobTitle: `Incentive Reward - ${milestoneId} milestone`,
            notes: `Milestone incentive reward for ${milestoneId} (${consecutiveDays} consecutive days)`,
            idempotencyKey: idempotencyKeyEarnings,
            metadata: {
              milestoneId,
              incentiveId: ledgerDoc._id.toString(),
              source: 'incentive',
              consecutiveDays,
            },
          },
          { upsert: true, new: true }
        );
      } catch (workerEarningsErr) {
        console.error('Failed to create WorkerEarnings entry for incentive:', workerEarningsErr);
        // Log error but don't fail the entire request - wallet credit is primary
      }

      responsePayload = {
        success: true,
        message: 'Reward claimed and credited to wallet',
        rewardAmount,
        newWalletBalance: Number(walletUpdateResult.availableBalance ?? walletUpdateResult.balance ?? 0),
        transactionId: ledgerDoc._id.toString(),
        claimedAt: new Date(),
      };
    } catch (errCredit) {
      console.error('Wallet credit failed after ledger upsert:', errCredit);
      return res.status(500).json({ success: false, message: 'Failed to credit wallet', error: String(errCredit && errCredit.message) });
    }

    if (global.io && walletUpdateResult) {
      global.io.emit(`wallet:rewarded:${phone}`, {
        rewardAmount,
        milestoneId,
        newBalance: Number(walletUpdateResult.availableBalance ?? walletUpdateResult.balance ?? 0),
        timestamp: new Date(),
      });
    }

    emitIncentiveUpdatedEvent(phone, {
      type: 'claim_completed',
      milestoneId,
      rewardAmount,
      status: 'claimed',
    });

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
    // no-op: not using mongoose sessions here to keep idempotent upsert flow simple
  }
});

module.exports = router;
