const express = require('express');
const { authenticateToken } = require('../utils/auth');
const WorkerEarnings = require('../models/WorkerEarnings');
const PayoutBatch = require('../models/PayoutBatch');
const Wallet = require('../models/Wallet');
const NotificationHistory = require('../models/NotificationHistory');
const ActivityLog = require('../models/ActivityLog');
const User = require('../models/User');

const router = express.Router();

// ✅ Helper: Get week number
function getWeekNumber(date = new Date()) {
  const firstDay = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date - firstDay) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDay.getDay() + 1) / 7);
}

// ✅ Helper: Get week start and end dates
function getWeekDates(year, week) {
  const simple = new Date(year, 0, 1 + (week - 1) * 7);
  const dow = simple.getDay();
  const ISOweekStart = simple;
  if (dow <= 4) ISOweekStart.setDate(simple.getDate() - simple.getDay() + 1);
  else ISOweekStart.setDate(simple.getDate() + 8 - simple.getDay());
  
  const weekStart = new Date(ISOweekStart);
  const weekEnd = new Date(ISOweekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  
  return { weekStart, weekEnd };
}

// ========== WORKER ROUTES ==========

// ✅ GET: Worker's earnings summary
router.get('/worker/earnings', authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.user.phone;

    const earnings = await WorkerEarnings.aggregate([
      { $match: { workerPhone } },
      {
        $group: {
          _id: '$status',
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 }
        }
      }
    ]);

    const totalEarnings = await WorkerEarnings.aggregate([
      { $match: { workerPhone } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    // Get current week earnings
    const now = new Date();
    const weekNum = getWeekNumber(now);
    const currentWeekEarnings = await WorkerEarnings.find({
      workerPhone,
      'payoutWeek.year': now.getFullYear(),
      'payoutWeek.week': weekNum
    });

    res.json({
      success: true,
      earnings: {
        byStatus: earnings.reduce((acc, e) => {
          acc[e._id] = { amount: e.totalAmount, count: e.count };
          return acc;
        }, {}),
        totalEarned: totalEarnings[0]?.total || 0,
        currentWeekAmount: currentWeekEarnings.reduce((sum, e) => sum + e.amount, 0),
        currentWeekCount: currentWeekEarnings.length
      }
    });
  } catch (error) {
    console.error('❌ Error fetching earnings:', error);
    res.status(500).json({ success: false, message: 'Error fetching earnings', error: error.message });
  }
});

// ✅ GET: Worker's payout history
router.get('/worker/payouts', authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.user.phone;
    const { page = 1, limit = 10 } = req.query;

    const payouts = await PayoutBatch.find(
      { 'workers.workerPhone': workerPhone }
    )
    .sort({ completedAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit));

    const total = await PayoutBatch.countDocuments({ 'workers.workerPhone': workerPhone });

    // Format response with only this worker's details
    const formattedPayouts = payouts.map(batch => {
      const workerData = batch.workers.find(w => w.workerPhone === workerPhone);
      return {
        batchId: batch.batchId,
        week: batch.payoutWeek,
        status: batch.status,
        amount: workerData?.netAmount,
        transactionId: workerData?.transactionId,
        completedAt: batch.completedAt,
        failureReason: workerData?.failureReason
      };
    });

    res.json({
      success: true,
      payouts: formattedPayouts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total
      }
    });
  } catch (error) {
    console.error('❌ Error fetching payouts:', error);
    res.status(500).json({ success: false, message: 'Error fetching payouts', error: error.message });
  }
});

// ✅ GET: Worker's individual earnings (per job)
router.get('/worker/earnings/detailed', authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.user.phone;
    const { status, week } = req.query;

    let query = { workerPhone };
    if (status) query.status = status;
    if (week) {
      const weekNum = parseInt(week);
      const now = new Date();
      query['payoutWeek.year'] = now.getFullYear();
      query['payoutWeek.week'] = weekNum;
    }

    const earnings = await WorkerEarnings.find(query)
      .sort({ earnedAt: -1 })
      .lean();

    res.json({
      success: true,
      earnings,
      count: earnings.length
    });
  } catch (error) {
    console.error('❌ Error fetching detailed earnings:', error);
    res.status(500).json({ success: false, message: 'Error fetching earnings', error: error.message });
  }
});

// ========== ADMIN ROUTES (PAYOUT MANAGEMENT) ==========

// ✅ POST: Create weekly payout batch
router.post('/admin/create-payout-batch', authenticateToken, async (req, res) => {
  try {
    // Check if user is admin (add admin check based on your auth system)
    const { year, week } = req.body;

    if (!year || !week) {
      return res.status(400).json({ success: false, message: 'Year and week are required' });
    }

    // Check if batch already exists
    const batchId = `PAYOUT_${year}_W${String(week).padStart(2, '0')}`;
    const existingBatch = await PayoutBatch.findOne({ batchId });
    if (existingBatch) {
      return res.status(400).json({ success: false, message: 'Payout batch for this week already exists' });
    }

    // Get all earnings for the week that are 'earned' or 'payout_requested'
    const weekEarnings = await WorkerEarnings.find({
      'payoutWeek.year': year,
      'payoutWeek.week': week,
      status: { $in: ['earned', 'payout_requested'] }
    });

    if (weekEarnings.length === 0) {
      return res.status(400).json({ success: false, message: 'No earnings found for this week' });
    }

    // Group by worker
    const workerEarningsMap = {};
    let totalAmount = 0;

    for (const earning of weekEarnings) {
      if (!workerEarningsMap[earning.workerPhone]) {
        workerEarningsMap[earning.workerPhone] = {
          workerPhone: earning.workerPhone,
          earningsAmount: 0,
          deductions: 0,
          netAmount: 0,
          jobs: []
        };
      }
      workerEarningsMap[earning.workerPhone].earningsAmount += earning.amount;
      workerEarningsMap[earning.workerPhone].jobs.push(earning._id);
      totalAmount += earning.amount;
    }

    // Get worker names and bank details
    const workers = [];
    for (const [workerPhone, data] of Object.entries(workerEarningsMap)) {
      const user = await User.findOne({ phone: workerPhone }, 'name').lean();
      workers.push({
        workerPhone,
        workerName: user?.name || 'Unknown',
        earningsAmount: data.earningsAmount,
        deductions: data.deductions,
        netAmount: data.earningsAmount - data.deductions,
        status: 'pending',
        bankDetails: {} // To be filled by worker or admin
      });
    }

    // Create payout batch
    const { weekStart, weekEnd } = getWeekDates(year, week);
    const batch = new PayoutBatch({
      batchId,
      payoutWeek: { year, week, startDate: weekStart, endDate: weekEnd },
      status: 'pending',
      totalAmount: totalAmount,
      totalWorkers: workers.length,
      workers,
      createdAt: new Date(),
      processedBy: req.user.phone
    });

    await batch.save();

    // Log activity
    await ActivityLog.create({
      userPhone: req.user.phone,
      action: 'payout_batch_created',
      details: { batchId, totalAmount, totalWorkers: workers.length },
      timestamp: new Date()
    });

    console.log(`✅ Payout batch created: ${batchId}, Amount: ₹${totalAmount}, Workers: ${workers.length}`);

    res.json({
      success: true,
      batch: {
        batchId,
        status: batch.status,
        totalAmount,
        totalWorkers: workers.length,
        week: batch.payoutWeek
      }
    });
  } catch (error) {
    console.error('❌ Error creating payout batch:', error);
    res.status(500).json({ success: false, message: 'Error creating payout batch', error: error.message });
  }
});

// ✅ GET: Admin view all payout batches
router.get('/admin/payouts', authenticateToken, async (req, res) => {
  try {
    const { status, year, week } = req.query;

    let query = {};
    if (status) query.status = status;
    if (year) query['payoutWeek.year'] = parseInt(year);
    if (week) query['payoutWeek.week'] = parseInt(week);

    const batches = await PayoutBatch.find(query)
      .sort({ 'payoutWeek.year': -1, 'payoutWeek.week': -1 })
      .select('-workers') // Exclude detailed worker info for list view
      .lean();

    res.json({
      success: true,
      batches,
      count: batches.length
    });
  } catch (error) {
    console.error('❌ Error fetching payout batches:', error);
    res.status(500).json({ success: false, message: 'Error fetching payout batches', error: error.message });
  }
});

// ✅ GET: Admin view single payout batch details
router.get('/admin/payouts/:batchId', authenticateToken, async (req, res) => {
  try {
    const batch = await PayoutBatch.findOne({ batchId: req.params.batchId });

    if (!batch) {
      return res.status(404).json({ success: false, message: 'Payout batch not found' });
    }

    res.json({
      success: true,
      batch
    });
  } catch (error) {
    console.error('❌ Error fetching payout batch:', error);
    res.status(500).json({ success: false, message: 'Error fetching payout batch', error: error.message });
  }
});

// ✅ POST: Admin mark payout as completed (TEST MODE)
router.post('/admin/payouts/:batchId/complete', authenticateToken, async (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = await PayoutBatch.findOne({ batchId });
    if (!batch) {
      return res.status(404).json({ success: false, message: 'Payout batch not found' });
    }

    // Update batch status
    batch.status = 'completed';
    batch.completedAt = new Date();
    
    // Mark all workers as success (in test mode)
    batch.workers.forEach(worker => {
      worker.status = 'success';
      worker.transactionId = `TXN_TEST_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    });

    await batch.save();

    // Update WorkerEarnings status
    const week = batch.payoutWeek;
    await WorkerEarnings.updateMany(
      {
        'payoutWeek.year': week.year,
        'payoutWeek.week': week.week,
        status: { $in: ['earned', 'payout_requested'] }
      },
      { status: 'payout_completed' }
    );

    // Create notifications for all workers
    for (const worker of batch.workers) {
      await NotificationHistory.create({
        recipientPhone: worker.workerPhone,
        type: 'payout_completed',
        title: 'Payout Completed',
        body: `You received ₹${worker.netAmount} in your bank account. Transaction ID: ${worker.transactionId}`,
        isRead: false,
        timestamp: new Date()
      });
    }

    // Log activity
    await ActivityLog.create({
      userPhone: req.user.phone,
      action: 'payout_batch_completed',
      details: {
        batchId,
        totalAmount: batch.totalAmount,
        totalWorkers: batch.totalWorkers
      },
      timestamp: new Date()
    });

    console.log(`✅ Payout batch completed: ${batchId}, Amount: ₹${batch.totalAmount}`);

    res.json({
      success: true,
      message: 'Payout batch completed successfully',
      batch: {
        batchId,
        status: batch.status,
        totalAmount: batch.totalAmount,
        totalWorkers: batch.totalWorkers,
        completedAt: batch.completedAt
      }
    });
  } catch (error) {
    console.error('❌ Error completing payout batch:', error);
    res.status(500).json({ success: false, message: 'Error completing payout batch', error: error.message });
  }
});

module.exports = router;
