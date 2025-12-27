const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { authenticateToken } = require('../utils/auth');
const Wallet = require('../models/Wallet');
const Job = require('../models/Jobs');
const NotificationHistory = require('../models/NotificationHistory');
const WorkerEarnings = require('../models/WorkerEarnings');
const ActivityLog = require('../models/ActivityLog');

const router = express.Router();

// Initialize Razorpay with test keys
const keyId = process.env.RAZORPAY_KEY_ID || 'rzp_test_1OfZbdvUlF5zWV';
const keySecret = process.env.RAZORPAY_KEY_SECRET || 'WhhqhokMn6PvdKJBANGNNnBu';

console.log('✅ Razorpay initialized with Key ID:', keyId.substring(0, 15) + '...');

const razorpay = new Razorpay({
  key_id: keyId,
  key_secret: keySecret
});

// ✅ Create Payment Order
router.post('/create-order', authenticateToken, async (req, res) => {
  try {
    const { jobId, amount, workerPhone, workerName } = req.body;

    if (!jobId || !amount || !workerPhone) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    console.log('📝 Creating Razorpay order for amount:', amount, 'with key_id:', process.env.RAZORPAY_KEY_ID);

    // Create short receipt (max 40 chars) - use just last 8 chars of jobId
    const shortJobId = jobId.substring(jobId.length - 8);
    const receipt = `job_${shortJobId}`;

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paise
      currency: 'INR',
      receipt: receipt,
      notes: {
        jobId,
        workerPhone,
        workerName
      }
    });

    console.log('✅ Razorpay order created:', order.id);

    res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_1OfZbdvUlF5zWV'
    });
  } catch (error) {
    console.error('Failed to create Razorpay order:', error);
    res.status(500).json({ success: false, message: 'Failed to create payment order', error: error.message });
  }
});

// ✅ Verify Payment & Update Wallet
router.post('/verify-payment', authenticateToken, async (req, res) => {
  try {
    const { orderId, paymentId, signature, jobId, amount, workerPhone } = req.body;

    // For test mode - skip signature verification if it's a test payment
    const isTestPayment = paymentId && paymentId.includes('test');
    
    if (!isTestPayment) {
      // Verify signature for real payments
      const body = orderId + '|' + paymentId;
      const expectedSignature = crypto
        .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'WhhqhokMn6PvdKJBANGNNnBu')
        .update(body)
        .digest('hex');

      if (expectedSignature !== signature) {
        return res.status(400).json({ success: false, message: 'Invalid payment signature' });
      }
    }

    console.log('✅ Payment verified for order:', orderId);

    // Get job details for earnings calculation
    const job = await Job.findById(jobId);
    if (!job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    // Calculate current week for payout tracking
    const now = new Date();
    const weekNumber = Math.ceil((now.getDate() + new Date(now.getFullYear(), 0, 1).getDay()) / 7);
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    // 1️⃣ Create WorkerEarnings record (tracks individual job earnings)
    const workerEarning = new WorkerEarnings({
      workerPhone: workerPhone,
      jobId: jobId,
      amount: amount,
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
    });
    await workerEarning.save();
    console.log(`💰 WorkerEarnings record created:`, workerEarning._id);

    // 2️⃣ Update worker's wallet (for immediate display of available balance)
    let workerWallet = await Wallet.findOne({ phone: workerPhone });
    if (!workerWallet) {
      workerWallet = new Wallet({ phone: workerPhone, balance: 0 });
    }

    workerWallet.balance += amount;
    workerWallet.transactions.push({
      type: 'payment',
      amount: amount,
      date: new Date(),
      jobId: jobId,
      description: `Payment for: ${job.title}`
    });
    await workerWallet.save();
    console.log(`✅ Worker wallet updated: ${workerPhone} received ₹${amount}`);

    // 3️⃣ Create ActivityLog record
    await ActivityLog.create({
      userPhone: workerPhone,
      action: 'payment_received',
      details: {
        jobId: jobId,
        amount: amount,
        jobTitle: job.title
      },
      timestamp: new Date()
    });

    // 4️⃣ Update job payment status
    const updatedJob = await Job.findByIdAndUpdate(
      jobId,
      { paymentStatus: 'Paid', paymentTime: new Date() },
      { new: true }
    );

    // 5️⃣ Create notification for worker
    const notification = await NotificationHistory.create({
      recipientPhone: workerPhone,
      type: 'payment_received',
      title: 'Payment Received',
      body: `You received ₹${amount} for job: ${updatedJob.title}`,
      isRead: false,
      timestamp: new Date()
    });

    console.log(`📢 Notification created for ${workerPhone}:`, notification._id);

    // Emit socket event to notify worker in real-time
    const io = req.app.get('io');
    if (io) {
      // Find all sockets for this worker and notify them
      const sockets = Array.from(io.sockets.sockets.values());
      let targetSocketFound = false;
      
      sockets.forEach((socket) => {
        // Check both socket.user.phone (from JWT) and socket.data.user.phone
        const socketWorkerPhone = socket.user?.phone || socket.data?.user?.phone;
        if (socketWorkerPhone === workerPhone) {
          socket.emit('walletUpdated', {
            phone: workerPhone,
            balance: workerWallet.balance,
            message: `Payment received: ₹${amount}`
          });
          socket.emit('notificationReceived', {
            recipientPhone: workerPhone,
            notification
          });
          targetSocketFound = true;
          console.log(`📤 Sent wallet & notification events to socket ${socket.id} for worker ${workerPhone}`);
        }
      });
      
      if (!targetSocketFound) {
        console.log(`⚠️ No connected socket found for worker ${workerPhone}, using broadcast`);
        io.emit('walletUpdated', {
          phone: workerPhone,
          balance: workerWallet.balance,
          message: `Payment received: ₹${amount}`
        });
        io.emit('notificationReceived', {
          recipientPhone: workerPhone,
          notification
        });
      }
    }

    console.log(`📬 Notification created for ${workerPhone}:`, notification._id);

    res.status(200).json({
      success: true,
      message: 'Payment verified and wallet updated',
      walletBalance: workerWallet.balance,
      notificationId: notification._id
    });
  } catch (error) {
    console.error('Payment verification failed:', error);
    res.status(500).json({ success: false, message: 'Payment verification failed', error: error.message });
  }
});

module.exports = router;
