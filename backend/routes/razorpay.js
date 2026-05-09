const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
const { authenticateToken } = require('../utils/auth');
const Wallet = require('../models/Wallet');
const Job = require('../models/Jobs');
const User = require('../models/User');
const WorkerModel = require('../models/Worker');
const NotificationHistory = require('../models/NotificationHistory');
const WorkerEarnings = require('../models/WorkerEarnings');
const ActivityLog = require('../models/ActivityLog');
const JobEventLog = require('../models/JobEventLog');
const { createGigHistoryEvent } = require('../services/gigHistoryService');
const { updateGigDataOnCompletion } = require('../utils/gigsDataTracker');
const { normalizePhoneNumber } = require('../utils/dataNormalization');
const { sendOpsAlert } = require('../utils/opsAlert');
const { buildLogContext, info, warn, error } = require('../utils/logContext');

async function setWorkerOfflineByPhone(phone) {
  if (!phone) return;
  const normalizedPhone = String(phone).trim();
  try {
    await User.findOneAndUpdate(
      { phone: normalizedPhone },
      { $set: { isAvailable: false, updatedAt: new Date() } }
    );
  } catch (err) {
    console.error('Error marking user offline after payment:', err);
  }
  try {
    await WorkerModel.findOneAndUpdate(
      { phone: normalizedPhone },
      { $set: { isAvailable: false, updatedAt: new Date() } }
    );
  } catch (err) {
    console.error('Error marking worker offline after payment:', err);
  }
}

const router = express.Router();

function computeFinalJobStatusForPaid(currentStatus) {
  const terminal = new Set(["cancelled", "expired", "completed"]);
  if (terminal.has(String(currentStatus || "").toLowerCase())) {
    return currentStatus;
  }
  return "completed";
}

function isBulkWorkerAlreadyPaid(job, workerPhone) {
  if (!job || !workerPhone || !Array.isArray(job.acceptedWorkers)) return false;
  const normalizedWorkerPhone = normalizePhoneNumber(workerPhone);
  const target = job.acceptedWorkers.find((w) => normalizePhoneNumber(w?.phone) === normalizedWorkerPhone);
  return String(target?.paymentStatus || "").toLowerCase() === "paid";
}

function buildJobPaymentUpdate(job, workerPhone, paymentTime) {
  const update = {
    paymentTime,
  };

  if (job.bulkHiring && workerPhone && Array.isArray(job.acceptedWorkers)) {
    const normalizedWorkerPhone = normalizePhoneNumber(workerPhone);
    const allPaidAfter = job.acceptedWorkers.length > 0 &&
      job.acceptedWorkers.every((w) =>
        normalizePhoneNumber(w?.phone) === normalizedWorkerPhone ||
        String(w?.paymentStatus || "").toLowerCase() === "paid"
      );

    update.paymentStatus = allPaidAfter ? "paid" : (job.paymentStatus || "pending");
    update.status = allPaidAfter ? computeFinalJobStatusForPaid(job.status) : job.status;
    update["acceptedWorkers.$[worker].paymentStatus"] = "paid";
    update["acceptedWorkers.$[worker].paymentMode"] = "razorpay";
    update["acceptedWorkers.$[worker].paymentTime"] = paymentTime;

    return {
      update,
      arrayFilters: [{ "worker.phone": normalizedWorkerPhone }],
    };
  }

  update.paymentStatus = "paid";
  update.status = computeFinalJobStatusForPaid(job.status);
  return { update, arrayFilters: undefined };
}

// 🔐 ENFORCE Razorpay keys - fail fast if missing (no fallback to test keys)
if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
  console.error('🚨 FATAL: RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET not configured');
  throw new Error('Razorpay keys are required. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables.');
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

console.log('✅ Razorpay initialized with Key ID:', process.env.RAZORPAY_KEY_ID.substring(0, 15) + '...');

if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
  console.error('🚨 FATAL: RAZORPAY_WEBHOOK_SECRET not configured');
  throw new Error('Razorpay webhook secret is required. Set RAZORPAY_WEBHOOK_SECRET environment variable.');
}

// ✅ Create Payment Order
router.post('/create-order', authenticateToken, async (req, res) => {
  try {
    const { jobId, workerPhone, workerName } = req.body;

    if (!jobId || !workerPhone) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Load canonical job amount and enforce ownership
    const job = await Job.findById(jobId).lean();
    if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

    // Only contractor (or admin) may create payment orders for the job
    const requesterPhone = String(req.user?.phone || '');
    const requesterRole = String(req.user?.role || '').toLowerCase();
    if (normalizePhoneNumber(requesterPhone) !== normalizePhoneNumber(job.contractorPhone) && requesterRole !== 'admin') {
      return res.status(403).json({ success: false, message: 'Forbidden: you are not the contractor for this job' });
    }

    // Prevent creating orders for already-paid jobs (or already-paid worker in bulk flow)
    const alreadyPaid = job.bulkHiring && workerPhone
      ? isBulkWorkerAlreadyPaid(job, workerPhone)
      : String(job.paymentStatus || '').toLowerCase() === 'paid';
    if (alreadyPaid) {
      return res.status(400).json({ success: false, message: 'Job already paid' });
    }

    // 🔐 Validate attendance precondition: worker must be marked "Present" before payment can be initiated
    if (job.bulkHiring && workerPhone) {
      const normalizedWorkerPhone = normalizePhoneNumber(workerPhone);
      const targetWorker = (job.acceptedWorkers || []).find((w) =>
        normalizePhoneNumber(w?.phone) === normalizedWorkerPhone
      );
      if (!targetWorker) {
        return res.status(404).json({ success: false, message: 'Worker not found on this bulk job' });
      }
      if (String(targetWorker.attendanceStatus || "").toLowerCase() !== "present") {
        return res.status(400).json({ success: false, message: 'Payment allowed only for PRESENT workers. Mark attendance first.' });
      }
    } else {
      // For non-bulk jobs, validate overall job attendance
      if (String(job.attendanceStatus || "").toLowerCase() !== "present") {
        return res.status(400).json({ success: false, message: 'Payment allowed only for PRESENT workers. Mark attendance first.' });
      }
    }

    // Use server-side canonical amount (prevent client-controlled amount)
    const orderAmount = Number(job.amount || 0);
    if (isNaN(orderAmount) || orderAmount <= 0 || orderAmount > 500000) {
      return res.status(400).json({ success: false, message: 'Invalid job amount configured' });
    }

    info('📝 Creating Razorpay order (server-verified amount)', buildLogContext(req, {
      amount: orderAmount,
      jobId,
      workerPhone,
    }));

    // Create short receipt (max 40 chars) - use just last 8 chars of jobId
    const shortJobId = jobId.substring(jobId.length - 8);
    const receipt = `job_${shortJobId}`;

    // 🔐 STEP 2: Create Razorpay order with server-side amount and contractor identity in notes
    const order = await razorpay.orders.create({
      amount: Math.round(orderAmount * 100), // Convert to paise
      currency: 'INR',
      receipt: receipt,
      notes: {
        jobId,
        workerPhone,
        workerName,
        amount: orderAmount, // Authoritative amount
        contractorPhone: requesterPhone
      }
    });

    info('✅ Razorpay order created', buildLogContext(req, {
      orderId: order.id,
      jobId,
      workerPhone,
      amount: orderAmount,
    }));

    res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID  // 🔐 Never fallback to test keys
    });
  } catch (err) {
    error('Failed to create Razorpay order', buildLogContext(req, { error: err?.message || String(err) }));
    res.status(500).json({ success: false, message: 'Failed to create payment order', error: err?.message || String(err) });
  }
});

// ✅ Verify Payment & Update Wallet - ENTERPRISE FINTECH GRADE
router.post('/verify-payment', authenticateToken, async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { orderId, paymentId, signature, jobId, workerPhone } = req.body;

    // Validate required fields
    if (!orderId || !paymentId || !signature || !jobId || !workerPhone) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // 🔐 STEP 1: ALWAYS verify signature (no test mode bypass)
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(orderId + '|' + paymentId)
      .digest('hex');

    if (expectedSignature !== signature) {
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    info('✅ Payment signature verified', buildLogContext(req, { orderId, paymentId, jobId, workerPhone }));

    // 🔐 STEP 2: Fetch payment from Razorpay API (never trust client amount)
    const payment = await razorpay.payments.fetch(paymentId);

    // 🔐 STEP 3: Validate payment status is CAPTURED (not just authorized)
    if (payment.status !== 'captured') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Payment not captured. Current status: ${payment.status}`
      });
    }

    // Get actual amount from Razorpay (authoritative source)
    const actualAmount = payment.amount / 100;

    // 🔐 STEP 4: Validate amount range
    if (actualAmount <= 0 || actualAmount > 500000) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment amount out of valid range'
      });
    }

    // 🔐 STEP 5: Fetch and validate order from Razorpay
    const order = await razorpay.orders.fetch(orderId);

    if (order.status !== 'paid') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: `Order not paid. Current status: ${order.status}`
      });
    }

    if (order.id !== orderId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Order ID mismatch'
      });
    }

    info('✅ Razorpay validation complete', buildLogContext(req, { orderId, paymentId, jobId, workerPhone, amount: actualAmount }));

    // 🔐 CRITICAL: Verify payment notes match request (prevent job/worker mismatch fraud)
    if (!payment.notes || payment.notes.jobId !== jobId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment job mismatch. Payment created for different job.'
      });
    }

    if (normalizePhoneNumber(payment.notes.workerPhone) !== normalizePhoneNumber(workerPhone)) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment worker mismatch. Payment created for different worker.'
      });
    }

    info('✅ Payment notes verified', buildLogContext(req, { orderId, paymentId, jobId, workerPhone }));

    // Get job details
    const job = await Job.findById(jobId).session(session);
    if (!job) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    // 🔐 CRITICAL: Verify contractor identity (prevent unauthorized payment)
    if (normalizePhoneNumber(job.contractorPhone) !== normalizePhoneNumber(req.user.phone)) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: 'Unauthorized. You are not the contractor for this job.'
      });
    }

    info('✅ Contractor identity verified', buildLogContext(req, { orderId, paymentId, jobId, workerPhone, contractorPhone: req.user.phone }));

    // 🔐 Idempotent success: if the same bulk worker payment has already been marked as paid, return success
    const duplicatePayment = job.bulkHiring && workerPhone
      ? isBulkWorkerAlreadyPaid(job, workerPhone)
      : String(job.paymentStatus || "").toLowerCase() === 'paid';

    if (duplicatePayment) {
      const existingWallet = await Wallet.findOne({ phone: workerPhone }).session(session);
      await session.commitTransaction();
      return res.status(200).json({
        success: true,
        message: 'Payment already processed',
        walletBalance: existingWallet?.balance || 0,
        availableBalance: Number(existingWallet?.availableBalance ?? existingWallet?.balance ?? 0),
        pocketBalance: Number(existingWallet?.pocketBalance || 0),
        isDuplicate: true,
      });
    }

    info('✅ Job payment status verified: not yet paid', buildLogContext(req, { orderId, paymentId, jobId, workerPhone }));

    // Calculate current week for payout tracking (Monday-Sunday week)
    const now = new Date();
    const weekStart = new Date(now);
    const dayOfWeek = weekStart.getDay(); // 0=Sunday, 1=Monday...
    const diffToMonday = (dayOfWeek + 6) % 7; // Days to subtract to get to Monday
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    
    // Calculate ISO week number (1-53)
    const getWeekNumber = (date) => {
      const firstDay = new Date(date.getFullYear(), 0, 1);
      const pastDaysOfYear = (date - firstDay) / 86400000;
      return Math.ceil((pastDaysOfYear + firstDay.getDay() + 1) / 7);
    };
    const weekNumber = getWeekNumber(now);

    // 🔐 NEW: Validate captured amount equals server-side job amount (paise)
    try {
      const expectedPaise = Math.round(Number(job.amount || 0) * 100);
      if (payment.amount !== expectedPaise) {
        await session.abortTransaction();
        return res.status(400).json({ success: false, message: 'Payment amount mismatch', expectedPaise, receivedPaise: payment.amount });
      }
    } catch (matchErr) {
      // If job.amount missing or invalid, abort
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid job amount for verification' });
    }

    // 🔐 STEP 6: ATOMIC wallet update - prevents duplicate credits
    const updatedWallet = await Wallet.findOneAndUpdate(
      {
        phone: workerPhone,
        'transactions.paymentId': { $ne: paymentId }  // Only update if paymentId NOT present
      },
      {
        $setOnInsert: { phone: workerPhone },
        $inc: { balance: actualAmount, availableBalance: actualAmount, totalEarned: actualAmount },
        $push: {
          transactions: {
            type: 'payment',
            amount: actualAmount,
            paymentId,  // 🔐 Unique identifier for idempotency
            orderId,    // 🔐 Audit trail
            jobId,
            date: new Date(),
            description: `Payment for: ${job.title}`,
            metadata: { balanceType: "available" }
          }
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, session }
    );

    // If updatedWallet is null -> idempotency or other failure (upsert avoids missing-wallet case)
    if (!updatedWallet) {
      // Payment may already be processed - check existing wallet for observability
      const existingWallet = await Wallet.findOne({ phone: workerPhone }).session(session);
      await session.commitTransaction();
      return res.status(200).json({
        success: true,
        message: 'Payment already processed or wallet unavailable',
        walletBalance: existingWallet?.balance || 0,
        availableBalance: Number(existingWallet?.availableBalance ?? existingWallet?.balance ?? 0),
        pocketBalance: Number(existingWallet?.pocketBalance || 0),
        isDuplicate: true,
      });
    }

    // 🔐 STEP 7: Create WorkerEarnings record (transactional)
    const workerEarning = await WorkerEarnings.findOneAndUpdate(
      { workerPhone, jobId },
      {
        $setOnInsert: {
          workerPhone,
          jobId,
          amount: actualAmount,
          currency: 'INR',
          status: 'earned',
          source: 'app',
          provider: 'razorpay',
          orderId,
          paymentId,
          providerEventId: paymentId,
          idempotencyKey: paymentId,
          earnedAt: new Date(),
          payoutWeek: {
            year: now.getFullYear(),
            week: weekNumber,
            startDate: weekStart,
            endDate: weekEnd
          },
          contractorName: job.contractorName,
          contractorPhone: job.contractorPhone,
          jobTitle: job.title,
          metadata: {
            createdFrom: 'verify-payment',
            amount: actualAmount,
          }
        }
      },
      { new: true, upsert: true, session }
    );
      info('💰 WorkerEarnings upserted', buildLogContext(req, { orderId, paymentId, jobId, workerPhone, workerEarningId: workerEarning?._id }));

    // 🔐 STEP 8: Create ActivityLog record (transactional)
    await ActivityLog.create(
      [{
        userId: workerPhone,
        phone: workerPhone,
        action: 'payment_received',
        description: `Received ₹${actualAmount} for job: ${job.title}`,
        jobId,
        status: 'success'
      }],
      { session }
    );

    // 🔐 STEP 9: Update job payment status (transactional)
    const paymentTime = new Date();
    const acceptedAtTime = job.acceptedAt ? new Date(job.acceptedAt) : null;
    const computedTimeSpentMinutes =
      acceptedAtTime && !Number.isNaN(acceptedAtTime.getTime())
        ? Math.max(0, Math.round((paymentTime.getTime() - acceptedAtTime.getTime()) / 60000))
        : Number(job.timeSpentMinutes || 0);
    const computedHoursWorked = Math.round(((computedTimeSpentMinutes || 0) / 60) * 10) / 10;

    const { update: paymentUpdate, arrayFilters } = buildJobPaymentUpdate(job, workerPhone, paymentTime);
    paymentUpdate.timeSpentMinutes = computedTimeSpentMinutes;
    paymentUpdate.hoursWorked = computedHoursWorked;

    const updatedJobFromWebhook = await Job.findByIdAndUpdate(
      jobId,
      paymentUpdate,
      { new: true, session, arrayFilters }
    );


    await JobEventLog.create(
      [{
        jobId: updatedJobFromWebhook._id,
        eventType: 'payment_captured',
        actorType: 'contractor',
        actorPhone: req.user.phone,
        oldState: { status: job.status, paymentStatus: job.paymentStatus },
        newState: { status: updatedJobFromWebhook.status, paymentStatus: updatedJobFromWebhook.paymentStatus, paymentTime: updatedJobFromWebhook.paymentTime },
        source: 'app',
        idempotencyKey: paymentId,
        provider: 'razorpay',
        providerEventId: paymentId,
        metadata: {
          orderId,
          paymentId,
          amount: actualAmount,
          paymentCapturedAt: updatedJobFromWebhook.paymentTime,
          actor: req.user.phone || 'contractor',
          source: 'app',
          idempotencyKey: paymentId,
        }
      }],
      { session }
    );

    // 🔐 STEP 10: Create notification (transactional)
    const notification = await NotificationHistory.create(
      [{
        recipientPhone: workerPhone,
        type: 'payment_received',
        title: 'Payment Received',
        body: `You received ₹${actualAmount} for job: ${job.title}`,
        isRead: false,
        timestamp: new Date()
      }],
      { session }
    );
      info('📢 Notification created', buildLogContext(req, { orderId, paymentId, jobId, workerPhone, notificationId: notification?.[0]?._id }));

    // Commit transaction
    await session.commitTransaction();

    // Ensure worker is marked offline after payment is credited
    try {
      await setWorkerOfflineByPhone(workerPhone);
    } catch (setOfflineErr) {
      console.error('Error marking worker offline after verified payment:', setOfflineErr);
    }

    // 🔐 STEP 11: Emit socket events using room-based architecture
    const io = req.app.get('io');
    if (io) {
      io.to(workerPhone).emit('walletUpdated', {
        phone: workerPhone,
        type: 'payment',
        amount: actualAmount,
        balance: updatedWallet.balance,
        availableBalance: Number(updatedWallet.availableBalance || updatedWallet.balance || 0),
        pocketBalance: Number(updatedWallet.pocketBalance || 0),
        message: `Payment received: ₹${actualAmount}`
      });
      io.to(workerPhone).emit('notificationReceived', {
        recipientPhone: workerPhone,
        notification: notification[0]
      });
      io.to(workerPhone).emit('workerStatusUpdate', {
        isAvailable: false,
        phone: workerPhone,
        source: 'payment',
        jobId,
        timestamp: new Date(),
      });
      // ✅ CRITICAL: Emit full job object so worker job card updates with Paid status
      io.to(workerPhone).emit('jobUpdated', updatedJobFromWebhook);
      // ✅ Emit to contractor too so their job list shows payment complete
      io.to(job.contractorPhone).emit('jobUpdated', updatedJobFromWebhook);
      info('📤 Emitted wallet, notification, jobUpdated, and workerStatusUpdate events', buildLogContext(req, { orderId, paymentId, jobId, workerPhone }));
    }

    res.status(200).json({
      success: true,
      message: 'Payment verified and wallet updated',
      walletBalance: updatedWallet.balance,
      availableBalance: Number(updatedWallet.availableBalance || updatedWallet.balance || 0),
      pocketBalance: Number(updatedWallet.pocketBalance || 0),
      notificationId: notification[0]._id
    });

  } catch (err) {
    await session.abortTransaction();
    error('Payment verification failed', buildLogContext(req, { orderId: req.body?.orderId, paymentId: req.body?.paymentId, jobId: req.body?.jobId, workerPhone: req.body?.workerPhone, error: err?.message || String(err) }));
    res.status(500).json({
      success: false,
      message: 'Payment verification failed',
      error: err?.message || String(err)
    });
  } finally {
    session.endSession();
  }
});

// ✅ RAZORPAY WEBHOOK - Independent payment verification (CRITICAL FOR RESILIENCE)
// Called directly by Razorpay when payment.captured event occurs
// Does NOT require client authorization - Razorpay calls this server-to-server
// This ensures payment is credited even if client app crashes
router.post('/webhook', async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const webhookSignature = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

    if (!webhookSignature) {
      error('🔴 WEBHOOK SIGNATURE MISSING', buildLogContext(req));
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Missing webhook signature' });
    }

    const body = req.rawBody || (req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body || ''));
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== webhookSignature) {
      error('🔴 WEBHOOK SIGNATURE MISMATCH - Unauthorized webhook call', buildLogContext(req));
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Invalid webhook signature' });
    }

    info('✅ Webhook signature verified', buildLogContext(req));

    const payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(body);
    const event = payload.event;
    const payment = payload.payload?.payment?.entity;

    // Only process payment.captured events
    if (event !== 'payment.captured') {
      warn('⚠️ Webhook event ignored (only payment.captured processed)', buildLogContext(req, { event }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, ignored: true });
    }

    if (!payment) {
      error('🔴 Payment data missing from webhook', buildLogContext(req, { event }));
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid webhook payload' });
    }

    const { id: paymentId, status, amount, notes, order_id: orderId } = payment;

    // Validate payment status
    if (status !== 'captured') {
      warn('⚠️ Payment status is not captured', buildLogContext(req, { paymentId, orderId, status, idempotencyKey: paymentId }));
      await session.commitTransaction();
      return res.status(200).json({ received: true });
    }

    // Extract data from webhook
    const workerPhone = notes?.workerPhone || notes?.phone;
    const jobId = notes?.jobId;
    const actualAmount = amount / 100; // Convert from paise

    // Wallet deposits are handled by /wallet/deposit/webhook route.
    if (String(notes?.type || "").toLowerCase() === "wallet_deposit") {
      info('ℹ️ Ignoring wallet deposit event on payment webhook', buildLogContext(req, { paymentId, orderId, idempotencyKey: paymentId }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, ignored: "wallet_deposit" });
    }

    if (!workerPhone || !jobId) {
      warn('⚠️ Ignoring payment webhook without workerPhone/jobId notes', buildLogContext(req, { paymentId, orderId, idempotencyKey: paymentId }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, ignored: "missing_job_notes" });
    }

    info('💰 Webhook processing payment', buildLogContext(req, { paymentId, orderId, jobId, workerPhone, amount: actualAmount, idempotencyKey: paymentId }));

    // Get job details
    const job = await Job.findById(jobId).session(session);
    if (!job) {
      warn('⚠️ Job not found for webhook payment', buildLogContext(req, { paymentId, orderId, jobId, workerPhone, idempotencyKey: paymentId }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, message: 'Job not found' });
    }

    // 🔐 CRITICAL: Webhook deduplication using provider event ID (paymentId)
    if (job.processedWebhookEvents && job.processedWebhookEvents.includes(paymentId)) {
      info('⚠️ WEBHOOK DEDUPLICATION: Event already processed', buildLogContext(req, { paymentId, orderId, jobId, workerPhone, idempotencyKey: paymentId }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, message: 'Event already processed' });
    }

    // Verify contractor identity embedded in order notes (defense-in-depth)
    const noteContractor = String(notes?.contractorPhone || "").trim();
    if (noteContractor && String(job.contractorPhone || "") !== noteContractor) {
      warn('⚠️ Webhook contractor mismatch - ignoring', buildLogContext(req, { paymentId, orderId, jobId, noteContractor, jobContractor: job.contractorPhone }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, ignored: 'contractor_mismatch' });
    }

    // Validate captured amount equals server-side job amount
    try {
      const expectedPaise = Math.round(Number(job.amount || 0) * 100);
      if (payment.amount !== expectedPaise) {
        warn('⚠️ Webhook amount mismatch - ignoring', buildLogContext(req, { paymentId, orderId, jobId, expectedPaise, receivedPaise: payment.amount }));
        await session.commitTransaction();
        return res.status(200).json({ received: true, ignored: 'amount_mismatch' });
      }
    } catch (amtErr) {
      warn('⚠️ Webhook amount validation failed', buildLogContext(req, { paymentId, orderId, jobId, error: amtErr?.message || String(amtErr) }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, ignored: 'amount_validation_failed' });
    }

    // Check if job already paid for this worker in bulk flow
    const duplicatePayment = job.bulkHiring && workerPhone
      ? isBulkWorkerAlreadyPaid(job, workerPhone)
      : String(job.paymentStatus || "").toLowerCase() === 'paid';

    if (duplicatePayment) {
      info('⚠️ Job already paid (idempotency)', buildLogContext(req, { paymentId, orderId, jobId, workerPhone, idempotencyKey: paymentId }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, message: 'Job already paid' });
    }

    // 🔐 CRITICAL: ATOMIC wallet update with idempotency via paymentId
    const updatedWallet = await Wallet.findOneAndUpdate(
      {
        phone: workerPhone,
        'transactions.paymentId': { $ne: paymentId }  // Only update if paymentId NOT already present
      },
      {
        $setOnInsert: { phone: workerPhone },
        $inc: { balance: actualAmount, availableBalance: actualAmount, totalEarned: actualAmount },
        $push: {
          transactions: {
            type: 'payment',
            amount: actualAmount,
            paymentId,  // 🔐 Unique identifier prevents duplicate credits
            orderId,
            jobId,
            date: new Date(),
            description: `Payment for: ${job.title} (via webhook)`,
            metadata: { balanceType: "available" }
          }
        }
      },
      { new: true, upsert: true, setDefaultsOnInsert: true, session }
    );

    // If wallet is null, payment already processed (idempotency)
    if (!updatedWallet) {
      info('⚠️ WEBHOOK IDEMPOTENCY: Payment already processed or wallet unavailable', buildLogContext(req, { paymentId, orderId, jobId, workerPhone, idempotencyKey: paymentId }));
      await session.commitTransaction();
      return res.status(200).json({ received: true, message: 'Payment already processed' });
    }

    // Create WorkerEarnings record (transactional)
    // Calculate current week for payout tracking (Monday-Sunday week)
    const now = new Date();
    const weekStart = new Date(now);
    const dayOfWeek = weekStart.getDay(); // 0=Sunday, 1=Monday...
    const diffToMonday = (dayOfWeek + 6) % 7; // Days to subtract to get to Monday
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);
    
    // Calculate ISO week number (1-53)
    const getWeekNumber = (date) => {
      const firstDay = new Date(date.getFullYear(), 0, 1);
      const pastDaysOfYear = (date - firstDay) / 86400000;
      return Math.ceil((pastDaysOfYear + firstDay.getDay() + 1) / 7);
    };
    const weekNumber = getWeekNumber(now);

    await WorkerEarnings.findOneAndUpdate(
      { workerPhone, jobId },
      {
        $setOnInsert: {
          workerPhone,
          jobId,
          amount: actualAmount,
          currency: 'INR',
          status: 'earned',
          source: 'webhook',
          provider: 'razorpay',
          orderId,
          paymentId,
          providerEventId: paymentId,
          idempotencyKey: paymentId,
          earnedAt: new Date(),
          payoutWeek: {
            year: now.getFullYear(),
            week: weekNumber,
            startDate: weekStart,
            endDate: weekEnd
          },
          contractorName: job.contractorName,
          contractorPhone: job.contractorPhone,
          jobTitle: job.title,
          metadata: {
            createdFrom: 'payment-webhook',
            amount: actualAmount,
          }
        }
      },
      { new: true, upsert: true, session }
    );

    // Create ActivityLog record
    await ActivityLog.create(
      [{
        userId: workerPhone,
        phone: workerPhone,
        action: 'payment_received_webhook',
        description: `Received ₹${actualAmount} for job: ${job.title} (via Razorpay webhook)`,
        jobId,
        status: 'success'
      }],
      { session }
    );

    // Update job payment status
    const webhookPaymentTime = new Date();
    const webhookAcceptedAt = job.acceptedAt ? new Date(job.acceptedAt) : null;
    const webhookTimeSpentMinutes =
      webhookAcceptedAt && !Number.isNaN(webhookAcceptedAt.getTime())
        ? Math.max(0, Math.round((webhookPaymentTime.getTime() - webhookAcceptedAt.getTime()) / 60000))
        : Number(job.timeSpentMinutes || 0);
    const webhookHoursWorked = Math.round(((webhookTimeSpentMinutes || 0) / 60) * 10) / 10;

    const { update: paymentUpdate, arrayFilters } = buildJobPaymentUpdate(job, workerPhone, webhookPaymentTime);
    paymentUpdate.timeSpentMinutes = webhookTimeSpentMinutes;
    paymentUpdate.hoursWorked = webhookHoursWorked;
    paymentUpdate.$addToSet = { processedWebhookEvents: paymentId }; // Track processed webhook event

    const updatedJobFromWebhook = await Job.findByIdAndUpdate(
      jobId,
      paymentUpdate,
      { new: true, session, arrayFilters }
    );


    await JobEventLog.create(
      [{
        jobId: updatedJobFromWebhook._id,
        eventType: 'payment_captured_webhook',
        actorType: 'webhook',
        oldState: { status: job.status, paymentStatus: job.paymentStatus },
        newState: { status: updatedJobFromWebhook.status, paymentStatus: updatedJobFromWebhook.paymentStatus, paymentTime: updatedJobFromWebhook.paymentTime },
        source: 'webhook',
        idempotencyKey: paymentId,
        provider: 'razorpay',
        providerEventId: paymentId,
        metadata: {
          orderId,
          paymentId,
          amount: actualAmount,
          webhookTime: new Date(),
          actor: 'webhook',
          source: 'webhook',
          idempotencyKey: paymentId,
        }
      }],
      { session }
    );

    // Keep worker incentive/gig history in sync for webhook-only payment finalization path.
    try {
      if (workerPhone && updatedJobFromWebhook) {
        await createGigHistoryEvent({
          workerPhone,
          workerName: updatedJobFromWebhook.acceptedWorker?.name || workerPhone,
          jobId: updatedJobFromWebhook._id,
          jobTitle: updatedJobFromWebhook.title,
          contractorPhone: updatedJobFromWebhook.contractorPhone,
          contractorName: updatedJobFromWebhook.contractorName,
          eventType: 'job_completed',
          status: updatedJobFromWebhook.status,
          paymentStatus: updatedJobFromWebhook.paymentStatus,
          hoursWorked: Number(updatedJobFromWebhook.hoursWorked || webhookHoursWorked || 0),
          timeSpentMinutes: Number(updatedJobFromWebhook.timeSpentMinutes || webhookTimeSpentMinutes || 0),
          eventTime: updatedJobFromWebhook.paymentTime || webhookPaymentTime,
          metadata: { source: 'payment-webhook', paymentId, orderId },
        });

        await updateGigDataOnCompletion(workerPhone, {
          _id: updatedJobFromWebhook._id,
          title: updatedJobFromWebhook.title,
          amount: Number(updatedJobFromWebhook.amount || actualAmount || 0),
          workerType: updatedJobFromWebhook.workerType,
          contractorName: updatedJobFromWebhook.contractorName,
          hoursWorked: Number(updatedJobFromWebhook.hoursWorked || webhookHoursWorked || 0),
          timeSpentMinutes: Number(updatedJobFromWebhook.timeSpentMinutes || webhookTimeSpentMinutes || 0),
        });
      }
    } catch (gigErr) {
      warn('Webhook gig completion sync failed', buildLogContext(req, { jobId, workerPhone, paymentId, error: gigErr?.message || String(gigErr) }));
    }

    // Create notification
    const notification = await NotificationHistory.create(
      [{
        recipientPhone: workerPhone,
        type: 'payment_received',
        title: 'Payment Received',
        body: `You received ₹${actualAmount} for job: ${job.title}`,
        isRead: false,
        timestamp: new Date()
      }],
      { session }
    );

    // Commit transaction
    await session.commitTransaction();

    try {
      await setWorkerOfflineByPhone(workerPhone);
    } catch (setOfflineErr) {
      console.error('Error marking worker offline after webhook payment:', setOfflineErr);
    }

    info('✅ Webhook payment processed successfully', buildLogContext(req, { paymentId, orderId, jobId, workerPhone, amount: actualAmount, idempotencyKey: paymentId }));

    // Emit socket event to notify worker (if connected)
    const io = req.app.get('io');
    if (io) {
      io.to(workerPhone).emit('walletUpdated', {
        phone: workerPhone,
        type: 'payment',
        amount: actualAmount,
        balance: updatedWallet.balance,
        availableBalance: Number(updatedWallet.availableBalance || updatedWallet.balance || 0),
        pocketBalance: Number(updatedWallet.pocketBalance || 0),
        message: `Payment received via webhook: ₹${actualAmount}`
      });
      io.to(workerPhone).emit('notificationReceived', {
        recipientPhone: workerPhone,
        notification
      });
      io.to(workerPhone).emit('workerStatusUpdate', {
        isAvailable: false,
        phone: workerPhone,
        source: 'payment_webhook',
        jobId,
        timestamp: new Date(),
      });
      // ✅ CRITICAL: Emit full job object so worker job card updates with Paid status
      io.to(workerPhone).emit('jobUpdated', updatedJobFromWebhook);
      // ✅ Emit to contractor too so their job list shows payment complete
      io.to(job.contractorPhone).emit('jobUpdated', updatedJobFromWebhook);
      info('📤 Emitted wallet/notification/jobUpdated via webhook', buildLogContext(req, { paymentId, orderId, jobId, workerPhone, idempotencyKey: paymentId }));
    }

    // Return 200 OK to Razorpay (acknowledges receipt)
    res.status(200).json({
      success: true,
      message: 'Webhook processed successfully',
      paymentId
    });

  } catch (err) {
    await session.abortTransaction();
    error('Webhook processing error', buildLogContext(req, {
      paymentId: req.body?.payload?.payment?.entity?.id || null,
      orderId: req.body?.payload?.payment?.entity?.order_id || null,
      jobId: req.body?.payload?.payment?.entity?.notes?.jobId || null,
      workerPhone: req.body?.payload?.payment?.entity?.notes?.workerPhone || null,
      idempotencyKey: req.body?.payload?.payment?.entity?.id || null,
      error: err?.message || String(err),
    }));
    await sendOpsAlert('Razorpay payment webhook failed', { error: err && (err.message || String(err)) });
    
    // Return non-2xx so Razorpay retries webhook delivery.
    res.status(500).json({
      success: false,
      message: 'Webhook processing failed, retry expected'
    });
  } finally {
    session.endSession();
  }
});

// Reconciliation-safe payment status endpoint for clients after gateway callback/webhook races.
router.get('/payment-status/:jobId', authenticateToken, async (req, res) => {
  try {
    const jobId = String(req.params.jobId || "").trim();
    const workerPhone = String(req.query.workerPhone || "").trim();
    if (!jobId) {
      return res.status(400).json({ success: false, message: "jobId is required" });
    }

    const job = await Job.findById(jobId).lean();
    if (!job) {
      return res.status(404).json({ success: false, message: "Job not found" });
    }

    const requesterPhone = String(req.user?.phone || "");
    const normalizedRequesterPhone = normalizePhoneNumber(requesterPhone);
    const canAccess =
      normalizedRequesterPhone &&
      (
        normalizedRequesterPhone === normalizePhoneNumber(job.contractorPhone) ||
        normalizedRequesterPhone === normalizePhoneNumber(job.acceptedBy) ||
        (Array.isArray(job.acceptedWorkers) && job.acceptedWorkers.some((w) => normalizePhoneNumber(w?.phone) === normalizedRequesterPhone))
      );
    if (!canAccess && String(req.user?.role || "").toLowerCase() !== "admin") {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    let isPaid = String(job.paymentStatus || "").toLowerCase() === "paid";
    let workerPaymentStatus = null;
    if (workerPhone) {
      const normalizedWorkerPhone = normalizePhoneNumber(workerPhone);
      if (Array.isArray(job.acceptedWorkers) && job.acceptedWorkers.length > 0) {
        const target = job.acceptedWorkers.find((w) => normalizePhoneNumber(w?.phone) === normalizedWorkerPhone);
        if (target) {
          workerPaymentStatus = target.paymentStatus || null;
          isPaid = String(target.paymentStatus || "").toLowerCase() === "paid";
          return res.json({
            success: true,
            jobId: job._id,
            status: job.status,
            paymentStatus: job.paymentStatus,
            paymentMode: job.paymentMode || null,
            paymentTime: job.paymentTime || null,
            isPaid,
            workerPaymentStatus,
            workerPaymentMode: target.paymentMode || null,
            workerPaymentTime: target.paymentTime || null,
            workerAttendanceStatus: target.attendanceStatus || null,
            workerAttendanceTime: target.attendanceTime || null,
            workerRating: target.rating || null,
            walletTransactions: await Wallet.aggregate([
              { $match: { phone: normalizedWorkerPhone, "transactions.jobId": job._id } },
              { $unwind: "$transactions" },
              { $match: { "transactions.jobId": job._id } },
              { $sort: { "transactions.date": -1 } },
              {
                $project: {
                  _id: 0,
                  walletPhone: "$phone",
                  orderId: "$transactions.orderId",
                  paymentId: "$transactions.paymentId",
                  status: "$transactions.status",
                  date: "$transactions.date",
                  providerEventId: "$transactions.providerEventId",
                  idempotencyKey: "$transactions.idempotencyKey",
                },
              },
              { $limit: 5 },
            ]),
          });
        }
      }
    }

    // Attach most recent wallet tx IDs for observability/debugging.
    const walletTx = await Wallet.aggregate([
      { $match: { "transactions.jobId": job._id } },
      { $unwind: "$transactions" },
      { $match: { "transactions.jobId": job._id } },
      { $sort: { "transactions.date": -1 } },
      {
        $project: {
          _id: 0,
          walletPhone: "$phone",
          orderId: "$transactions.orderId",
          paymentId: "$transactions.paymentId",
          status: "$transactions.status",
          date: "$transactions.date",
          providerEventId: "$transactions.providerEventId",
          idempotencyKey: "$transactions.idempotencyKey",
        },
      },
      { $limit: 5 },
    ]);

    return res.json({
      success: true,
      jobId: job._id,
      status: job.status,
      paymentStatus: job.paymentStatus,
      paymentMode: job.paymentMode || null,
      paymentTime: job.paymentTime || null,
      isPaid,
      workerPaymentStatus,
      walletTransactions: walletTx,
    });
  } catch (error) {
    console.error("payment-status error:", error);
    return res.status(500).json({ success: false, message: "Failed to fetch payment status" });
  }
});

module.exports = router;


