const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const { authenticateToken } = require('../utils/auth');
const Wallet = require('../models/Wallet');
const Job = require('../models/Jobs');
const NotificationHistory = require('../models/NotificationHistory');

const router = express.Router();

// Initialize Razorpay with test keys
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_1OfZbdvUlF5zWV',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'WhhqhokMn6PvdKJBANGNNnBu'
});

// ✅ Create Payment Order
router.post('/create-order', authenticateToken, async (req, res) => {
  try {
    const { jobId, amount, workerPhone, workerName } = req.body;

    if (!jobId || !amount || !workerPhone) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100), // Convert to paise
      currency: 'INR',
      receipt: `job_${jobId}_${Date.now()}`,
      notes: {
        jobId,
        workerPhone,
        workerName
      }
    });

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

    // Verify signature
    const body = orderId + '|' + paymentId;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'WhhqhokMn6PvdKJBANGNNnBu')
      .update(body)
      .digest('hex');

    if (expectedSignature !== signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    // Payment verified ✅
    // Update worker's wallet
    let workerWallet = await Wallet.findOne({ phone: workerPhone });
    if (!workerWallet) {
      workerWallet = new Wallet({ phone: workerPhone, balance: 0 });
    }

    workerWallet.balance += amount;
    workerWallet.transactions.push({
      type: 'payment',
      amount: amount,
      date: new Date()
    });
    await workerWallet.save();

    // Update job payment status
    const job = await Job.findByIdAndUpdate(
      jobId,
      { paymentStatus: 'Paid' },
      { new: true }
    );

    // Create notification for worker
    await NotificationHistory.create({
      recipientPhone: workerPhone,
      type: 'payment_received',
      title: 'Payment Received',
      body: `You received ₹${amount} for job: ${job.title}`,
      read: false,
      timestamp: new Date()
    });

    res.status(200).json({
      success: true,
      message: 'Payment verified and wallet updated',
      walletBalance: workerWallet.balance
    });
  } catch (error) {
    console.error('Payment verification failed:', error);
    res.status(500).json({ success: false, message: 'Payment verification failed', error: error.message });
  }
});

module.exports = router;
