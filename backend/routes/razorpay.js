const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const mongoose = require('mongoose');
const { authenticateToken } = require('../utils/auth');
const Wallet = require('../models/Wallet');
const Job = require('../models/Jobs');
const NotificationHistory = require('../models/NotificationHistory');
const WorkerEarnings = require('../models/WorkerEarnings');
const ActivityLog = require('../models/ActivityLog');
const { sendOpsAlert } = require('../utils/opsAlert');

const router = express.Router();

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

// ✅ Create Payment Order
router.post('/create-order', authenticateToken, async (req, res) => {
  try {
    const { jobId, amount, workerPhone, workerName } = req.body;

    if (!jobId || !amount || !workerPhone) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // 🔐 STEP 1: Type safety - validate amount
    const orderAmount = Number(amount);
    if (isNaN(orderAmount) || orderAmount <= 0 || orderAmount > 500000) {
      return res.status(400).json({ success: false, message: 'Invalid amount. Must be between ₹1-₹5,00,000' });
    }

    console.log('📝 Creating Razorpay order for amount:', orderAmount, 'INR');

    // Create short receipt (max 40 chars) - use just last 8 chars of jobId
    const shortJobId = jobId.substring(jobId.length - 8);
    const receipt = `job_${shortJobId}`;

    // 🔐 STEP 2: Create Razorpay order with amount stored in notes for verification
    const order = await razorpay.orders.create({
      amount: Math.round(orderAmount * 100), // Convert to paise
      currency: 'INR',
      receipt: receipt,
      notes: {
        jobId,
        workerPhone,
        workerName,
        amount: orderAmount  // Store amount for later verification
      }
    });

    console.log('✅ Razorpay order created:', order.id);

    res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID  // 🔐 Never fallback to test keys
    });
  } catch (error) {
    console.error('Failed to create Razorpay order:', error);
    res.status(500).json({ success: false, message: 'Failed to create payment order', error: error.message });
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

    console.log('✅ Payment signature verified for order:', orderId);

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

    console.log('✅ Razorpay validation complete. Amount:', actualAmount, 'INR');

    // 🔐 CRITICAL: Verify payment notes match request (prevent job/worker mismatch fraud)
    if (!payment.notes || payment.notes.jobId !== jobId) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment job mismatch. Payment created for different job.'
      });
    }

    if (payment.notes.workerPhone !== workerPhone) {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Payment worker mismatch. Payment created for different worker.'
      });
    }

    console.log('✅ Payment notes verified: jobId and workerPhone match');

    // Get job details
    const job = await Job.findById(jobId).session(session);
    if (!job) {
      await session.abortTransaction();
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    // 🔐 CRITICAL: Verify contractor identity (prevent unauthorized payment)
    if (job.contractorPhone !== req.user.phone) {
      await session.abortTransaction();
      return res.status(403).json({
        success: false,
        message: 'Unauthorized. You are not the contractor for this job.'
      });
    }

    console.log('✅ Contractor identity verified:', req.user.phone);

    // 🔐 CRITICAL: Check if job is already paid (prevent double payment)
    if (job.paymentStatus === 'Paid') {
      await session.abortTransaction();
      return res.status(400).json({
        success: false,
        message: 'Job already paid. This payment has already been processed.'
      });
    }

    console.log('✅ Job payment status verified: not yet paid');

    // Calculate current week for payout tracking
    const now = new Date();
    const weekNumber = Math.ceil((now.getDate() + new Date(now.getFullYear(), 0, 1).getDay()) / 7);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    // 🔐 STEP 6: ATOMIC wallet update - prevents duplicate credits
    const updatedWallet = await Wallet.findOneAndUpdate(
      {
        phone: workerPhone,
        'transactions.paymentId': { $ne: paymentId }  // Only update if paymentId NOT present
      },
      {
        $inc: { balance: actualAmount },
        $push: {
          transactions: {
            type: 'payment',
            amount: actualAmount,
            paymentId,  // 🔐 Unique identifier for idempotency
            orderId,    // 🔐 Audit trail
            jobId,
            date: new Date(),
            description: `Payment for: ${job.title}`
          }
        }
      },
      { new: true, session }
    );

    // If wallet is null → duplicate payment (idempotency triggered)
    if (!updatedWallet) {
      // Payment already processed - check existing wallet
      const existingWallet = await Wallet.findOne({ phone: workerPhone }).session(session);
      await session.commitTransaction();
      return res.status(200).json({
        success: true,
        message: 'Payment already processed',
        walletBalance: existingWallet?.balance || 0,
        isDuplicate: true
      });
    }

    // 🔐 STEP 7: Create WorkerEarnings record (transactional)
    const workerEarning = await WorkerEarnings.create(
      [{
        workerPhone,
        jobId,
        amount: actualAmount,
        status: 'earned',
        earnedAt: new Date(),
        payoutWeek: {
          year: now.getFullYear(),
          week: weekNumber,
          startDate: weekStart,
          endDate: weekEnd
        },
        contractorName: job.contractorName,
        contractorPhone: job.contractorPhone,
        jobTitle: job.title
      }],
      { session }
    );
    console.log(`💰 WorkerEarnings record created:`, workerEarning[0]._id);

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
    const updatedJobFromWebhook = await Job.findByIdAndUpdate(
      jobId,
      { paymentStatus: 'Paid', paymentTime: new Date() },
      { new: true, session }
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
    console.log(`📢 Notification created for ${workerPhone}:`, notification[0]._id);

    // Commit transaction
    await session.commitTransaction();

    // 🔐 STEP 11: Emit socket events using room-based architecture
    const io = req.app.get('io');
    if (io) {
      io.to(workerPhone).emit('walletUpdated', {
        phone: workerPhone,
        balance: updatedWallet.balance,
        message: `Payment received: ₹${actualAmount}`
      });
      io.to(workerPhone).emit('notificationReceived', {
        recipientPhone: workerPhone,
        notification: notification[0]
      });
      // ✅ CRITICAL: Emit full job object so worker job card updates with Paid status
      io.to(workerPhone).emit('jobUpdated', updatedJobFromWebhook);
      // ✅ Emit to contractor too so their job list shows payment complete
      io.to(job.contractorPhone).emit('jobUpdated', updatedJobFromWebhook);
      console.log(`📤 Emitted wallet, notification, and jobUpdated events for payment: ${paymentId}`);
    }

    res.status(200).json({
      success: true,
      message: 'Payment verified and wallet updated',
      walletBalance: updatedWallet.balance,
      notificationId: notification[0]._id
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Payment verification failed:', error);
    res.status(500).json({
      success: false,
      message: 'Payment verification failed',
      error: error.message
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
    const crypto = require('crypto');
    const webhookSignature = req.headers['x-razorpay-signature'];

    // Validate webhook signature (Razorpay authenticity check)
    // CRITICAL: Webhook secret is different from API key secret
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      console.error('🚨 CRITICAL: RAZORPAY_WEBHOOK_SECRET not configured');
      // Don't crash, just acknowledge (Razorpay will retry)
      return res.status(200).json({ received: true });
    }

    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== webhookSignature) {
      console.error('🔴 WEBHOOK SIGNATURE MISMATCH - Unauthorized webhook call');
      await session.abortTransaction();
      return res.status(403).json({ success: false, message: 'Invalid webhook signature' });
    }

    console.log('✅ Webhook signature verified');

    // Extract event type and payment data
    const event = req.body.event;
    const payment = req.body.payload?.payment?.entity;

    // Only process payment.captured events
    if (event !== 'payment.captured') {
      console.log(`⚠️ Webhook event ignored: ${event} (only payment.captured processed)`);
      await session.commitTransaction();
      return res.status(200).json({ received: true, ignored: true });
    }

    if (!payment) {
      console.error('🔴 Payment data missing from webhook');
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid webhook payload' });
    }

    const { id: paymentId, status, amount, notes, order_id: orderId } = payment;

    // Validate payment status
    if (status !== 'captured') {
      console.log(`⚠️ Payment status is not captured: ${status}`);
      await session.commitTransaction();
      return res.status(200).json({ received: true });
    }

    // Extract data from webhook
    const workerPhone = notes?.workerPhone || notes?.phone;
    const jobId = notes?.jobId;
    const actualAmount = amount / 100; // Convert from paise

    if (!workerPhone || !jobId) {
      console.error('🔴 Missing workerPhone or jobId in payment notes');
      await session.abortTransaction();
      return res.status(400).json({ success: false, message: 'Invalid payment notes' });
    }

    console.log(`💰 Webhook processing payment: ${paymentId}, Amount: ₹${actualAmount}, Worker: ${workerPhone}`);

    // Get job details
    const job = await Job.findById(jobId).session(session);
    if (!job) {
      console.warn(`⚠️ Job not found for webhook payment: ${jobId}`);
      await session.commitTransaction();
      return res.status(200).json({ received: true, message: 'Job not found' });
    }

    // Check if job already paid
    if (job.paymentStatus === 'Paid') {
      console.log(`⚠️ Job already paid (idempotency): ${jobId}`);
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
        $inc: { balance: actualAmount },
        $push: {
          transactions: {
            type: 'payment',
            amount: actualAmount,
            paymentId,  // 🔐 Unique identifier prevents duplicate credits
            orderId,
            jobId,
            date: new Date(),
            description: `Payment for: ${job.title} (via webhook)`
          }
        }
      },
      { new: true, session }
    );

    // If wallet is null, payment already processed (idempotency)
    if (!updatedWallet) {
      console.log(`⚠️ WEBHOOK IDEMPOTENCY: Payment already processed for paymentId: ${paymentId}`);
      await session.commitTransaction();
      return res.status(200).json({ received: true, message: 'Payment already processed' });
    }

    // Create WorkerEarnings record (transactional)
    const now = new Date();
    const weekNumber = Math.ceil((now.getDate() + new Date(now.getFullYear(), 0, 1).getDay()) / 7);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    await WorkerEarnings.create(
      [{
        workerPhone,
        jobId,
        amount: actualAmount,
        status: 'earned',
        earnedAt: new Date(),
        payoutWeek: {
          year: now.getFullYear(),
          week: weekNumber,
          startDate: weekStart,
          endDate: weekEnd
        },
        contractorName: job.contractorName,
        contractorPhone: job.contractorPhone,
        jobTitle: job.title
      }],
      { session }
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
    const updatedJobFromWebhook = await Job.findByIdAndUpdate(
      jobId,
      { paymentStatus: 'Paid', paymentTime: new Date() },
      { new: true, session }
    );

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

    console.log(`✅ Webhook payment processed successfully: ${paymentId}`);

    // Emit socket event to notify worker (if connected)
    const io = req.app.get('io');
    if (io) {
      io.to(workerPhone).emit('walletUpdated', {
        phone: workerPhone,
        balance: updatedWallet.balance,
        message: `Payment received via webhook: ₹${actualAmount}`
      });
      io.to(workerPhone).emit('notificationReceived', {
        recipientPhone: workerPhone,
        notification
      });
      // ✅ CRITICAL: Emit full job object so worker job card updates with Paid status
      io.to(workerPhone).emit('jobUpdated', updatedJobFromWebhook);
      // ✅ Emit to contractor too so their job list shows payment complete
      io.to(job.contractorPhone).emit('jobUpdated', updatedJobFromWebhook);
      console.log(`📤 Emitted wallet, notification, and jobUpdated events via webhook: ${paymentId}`);
    }

    // Return 200 OK to Razorpay (acknowledges receipt)
    res.status(200).json({
      success: true,
      message: 'Webhook processed successfully',
      paymentId
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Webhook processing error:', error);
    await sendOpsAlert('Razorpay payment webhook failed', { error: error && error.message });
    
    // Return non-2xx so Razorpay retries webhook delivery.
    res.status(500).json({
      success: false,
      message: 'Webhook processing failed, retry expected'
    });
  } finally {
    session.endSession();
  }
});

module.exports = router;
