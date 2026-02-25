const express = require('express');
const { authenticateToken } = require('../utils/auth');
const WorkerEarnings = require('../models/WorkerEarnings');
const PayoutBatch = require('../models/PayoutBatch');
const User = require('../models/User');

const router = express.Router();

async function ensureAdmin(req) {
  let role = String(req.user?.role || '').toLowerCase();
  if (!role) {
    const user = await User.findOne({ phone: req.user?.phone }).select('role').lean();
    role = String(user?.role || '').toLowerCase();
    if (role) req.user.role = role;
  }
  return role === 'admin';
}

async function checkAdmin(req, res, next) {
  if (!(await ensureAdmin(req))) {
    return res.status(403).json({ success: false, message: 'Admin access required' });
  }
  return next();
}

function getWeekNumber(date = new Date()) {
  const firstDay = new Date(date.getFullYear(), 0, 1);
  const pastDaysOfYear = (date - firstDay) / 86400000;
  return Math.ceil((pastDaysOfYear + firstDay.getDay() + 1) / 7);
}

router.get('/worker/earnings', authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.user.phone;

    const earnings = await WorkerEarnings.aggregate([
      { $match: { workerPhone } },
      { $group: { _id: '$status', totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]);

    const totalEarnings = await WorkerEarnings.aggregate([
      { $match: { workerPhone } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    const now = new Date();
    const weekNum = getWeekNumber(now);
    const currentWeekEarnings = await WorkerEarnings.find({
      workerPhone,
      'payoutWeek.year': now.getFullYear(),
      'payoutWeek.week': weekNum,
    });

    return res.json({
      success: true,
      earnings: {
        byStatus: earnings.reduce((acc, e) => {
          acc[e._id] = { amount: e.totalAmount, count: e.count };
          return acc;
        }, {}),
        totalEarned: totalEarnings[0]?.total || 0,
        currentWeekAmount: currentWeekEarnings.reduce((sum, e) => sum + e.amount, 0),
        currentWeekCount: currentWeekEarnings.length,
      },
    });
  } catch (error) {
    console.error('Error fetching earnings:', error);
    return res.status(500).json({ success: false, message: 'Error fetching earnings', error: error.message });
  }
});

router.get('/worker/payouts', authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.user.phone;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));

    const payouts = await PayoutBatch.find({ 'workers.workerPhone': workerPhone })
      .sort({ completedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    const total = await PayoutBatch.countDocuments({ 'workers.workerPhone': workerPhone });

    const formattedPayouts = payouts.map((batch) => {
      const workerData = batch.workers.find((w) => w.workerPhone === workerPhone);
      return {
        batchId: batch.batchId,
        week: batch.payoutWeek,
        status: batch.status,
        amount: workerData?.netAmount,
        transactionId: workerData?.transactionId,
        completedAt: batch.completedAt,
        failureReason: workerData?.failureReason,
      };
    });

    return res.json({
      success: true,
      payouts: formattedPayouts,
      pagination: { page, limit, total },
    });
  } catch (error) {
    console.error('Error fetching payouts:', error);
    return res.status(500).json({ success: false, message: 'Error fetching payouts', error: error.message });
  }
});

router.get('/worker/earnings/detailed', authenticateToken, async (req, res) => {
  try {
    const workerPhone = req.user.phone;
    const { status, week } = req.query;

    const query = { workerPhone };
    if (status) query.status = status;
    if (week) {
      const weekNum = parseInt(week, 10);
      const now = new Date();
      query['payoutWeek.year'] = now.getFullYear();
      query['payoutWeek.week'] = weekNum;
    }

    const earnings = await WorkerEarnings.find(query).sort({ earnedAt: -1 }).lean();
    return res.json({ success: true, earnings, count: earnings.length });
  } catch (error) {
    console.error('Error fetching detailed earnings:', error);
    return res.status(500).json({ success: false, message: 'Error fetching earnings', error: error.message });
  }
});

// Admin views (read only)
router.get('/admin/payouts', authenticateToken, checkAdmin, async (req, res) => {
  try {
    const { status, year, week } = req.query;
    const query = {};
    if (status) query.status = status;
    if (year) query['payoutWeek.year'] = parseInt(year, 10);
    if (week) query['payoutWeek.week'] = parseInt(week, 10);

    const batches = await PayoutBatch.find(query)
      .sort({ 'payoutWeek.year': -1, 'payoutWeek.week': -1 })
      .select('-workers')
      .lean();

    return res.json({ success: true, batches, count: batches.length });
  } catch (error) {
    console.error('Error fetching payout batches:', error);
    return res.status(500).json({ success: false, message: 'Error fetching payout batches', error: error.message });
  }
});

router.get('/admin/payouts/:batchId', authenticateToken, checkAdmin, async (req, res) => {
  try {
    const batch = await PayoutBatch.findOne({ batchId: req.params.batchId });
    if (!batch) return res.status(404).json({ success: false, message: 'Payout batch not found' });
    return res.json({ success: true, batch });
  } catch (error) {
    console.error('Error fetching payout batch:', error);
    return res.status(500).json({ success: false, message: 'Error fetching payout batch', error: error.message });
  }
});

// Deprecated mutating endpoints to prevent duplicate payout pipelines.
router.post('/admin/create-payout-batch', authenticateToken, checkAdmin, async (_req, res) => {
  return res.status(410).json({
    success: false,
    message: 'Deprecated endpoint. Use POST /admin/payouts/batches.',
  });
});

router.post('/admin/payouts/:batchId/complete', authenticateToken, checkAdmin, async (_req, res) => {
  return res.status(410).json({
    success: false,
    message: 'Deprecated endpoint. Use PATCH /admin/payouts/:batchId/state with status=success.',
  });
});

router.post('/admin/weekly-settlement/run', authenticateToken, checkAdmin, async (_req, res) => {
  return res.status(410).json({
    success: false,
    message: 'Deprecated endpoint. Use POST /admin/payouts/weekly-settlement/run.',
  });
});

module.exports = router;
