const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { authenticateToken } = require('../utils/auth');

// Models
const User = require('../models/User');
const Worker = require('../models/Worker');
const Job = require('../models/Jobs');
const Wallet = require('../models/Wallet');
const BankAccount = require('../models/BankAccount');
const VerificationDocument = require('../models/VerificationDocument');
const ActivityLog = require('../models/ActivityLog');
const ContractorStats = require('../models/ContractorStats');
const CancellationLog = require('../models/CancellationLog');
const CityLeaderboard = require('../models/CityLeaderboard');
const SupportTicket = require('../models/SupportTicket');
const PremiumSubscription = require('../models/PremiumSubscription');
const ReconciliationRun = require('../models/ReconciliationRun');
const District = require('../models/City'); // File is City.js, exports as "District" model for GeoJSON import
const GigHistory = require('../models/GigHistory');
const IncentiveLedger = require('../models/IncentiveLedger');
const PayoutBatch = require('../models/PayoutBatch');
const WorkerEarnings = require('../models/WorkerEarnings');
const JobEventLog = require('../models/JobEventLog');
const OpsAlert = require('../models/OpsAlert');
const { runWeeklyWalletSettlement } = require('../services/weeklyWalletSettlement');

// Middleware to check admin role
const checkAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
};

const isValidPhone = (phone) => /^\d{10}$/.test(String(phone || '').trim());
const parsePagination = (req, defaultLimit = 100, maxLimit = 1000) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || defaultLimit, 1), maxLimit);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;
    return { limit, page, skip };
};

const toObjectIdOrNull = (value) => {
    if (!value) return null;
    return mongoose.Types.ObjectId.isValid(String(value)) ? new mongoose.Types.ObjectId(String(value)) : null;
};

const generateRef = (prefix) => `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

const safeText = (value, maxLen = 500) => String(value || '').trim().slice(0, maxLen);

const adminAdjustments = new Map(); // in-memory adjustment history (move to Mongo for production durability)
const adminDisputes = new Map();
const reportSchedules = new Map();

const buildCsv = (rows = []) => {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const escape = (v) => {
        const text = String(v ?? '');
        if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
        return text;
    };
    const body = rows.map((r) => headers.map((h) => escape(r[h])).join(','));
    return [headers.join(','), ...body].join('\n');
};

const getWeekRange = () => {
    const now = new Date();
    const day = now.getUTCDay() || 7; // Sun=7
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    start.setUTCDate(start.getUTCDate() - (day - 1));
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end };
};

const computeLeaderboardBreakdown = ({ avgRating, totalJobsPosted, daysActive, completionRate }) => {
    const weights = {
        rating: 0.5,
        jobsPosted: 0.1667,
        daysActive: 0.1667,
        completionRate: 0.1667,
    };
    const normalizedRating = (Number(avgRating || 0) / 5) * 100;
    const normalizedJobsPosted = Math.min(Number(totalJobsPosted || 0), 100);
    const normalizedDaysActivePct = (Math.min(Number(daysActive || 0), 365) / 365) * 100;
    const normalizedCompletionRate = Math.max(0, Math.min(Number(completionRate || 0), 100));
    const weighted = {
        rating: Number((weights.rating * normalizedRating).toFixed(2)),
        jobsPosted: Number((weights.jobsPosted * normalizedJobsPosted).toFixed(2)),
        daysActive: Number((weights.daysActive * normalizedDaysActivePct).toFixed(2)),
        completionRate: Number((weights.completionRate * normalizedCompletionRate).toFixed(2)),
    };
    return {
        weights,
        normalized: {
            rating: Number(normalizedRating.toFixed(2)),
            jobsPosted: Number(normalizedJobsPosted.toFixed(2)),
            daysActivePercent: Number(normalizedDaysActivePct.toFixed(2)),
            completionRate: Number(normalizedCompletionRate.toFixed(2)),
        },
        weighted,
        finalScore: Number((weighted.rating + weighted.jobsPosted + weighted.daysActive + weighted.completionRate).toFixed(2)),
    };
};

const logAdminAudit = async ({ req, action, phone, description, before, after, metadata }) => {
    await ActivityLog.create({
        userId: req.user.id || req.user._id || 'admin',
        phone: phone || (req.user.phone || 'admin'),
        action: action || 'admin_action',
        description: safeText(description || action || 'admin_action', 1000),
        status: 'success',
        metadata: {
            actorPhone: req.user.phone || null,
            actorRole: req.user.role || null,
            before: before || null,
            after: after || null,
            ...(metadata || {}),
        },
        timestamp: new Date(),
    });
};

const buildWorkerGigSummary = (jobs, phone) => {
    const workerJobs = jobs.filter((j) => {
        const inBulk = Array.isArray(j.acceptedWorkers) && j.acceptedWorkers.some((w) => w.phone === phone);
        return j.acceptedBy === phone || inBulk;
    });

    // Bug #3 Fix: Check per-worker payment status in bulk jobs
    const completed = workerJobs.filter((j) => {
        if (j.acceptedBy === phone && !Array.isArray(j.acceptedWorkers)) {
            return String(j.paymentStatus || '').toLowerCase() === 'paid';
        }
        if (Array.isArray(j.acceptedWorkers)) {
            return j.acceptedWorkers.some(w => w.phone === phone && String(w.paymentStatus || '').toLowerCase() === 'paid');
        }
        return false;
    }).length;
    const cancelled = workerJobs.filter((j) => j.status === 'cancelled' || j.isCancelled === true).length;
    const pending = workerJobs.filter((j) => {
        if (j.acceptedBy === phone && !Array.isArray(j.acceptedWorkers)) {
            return String(j.paymentStatus || '').toLowerCase() !== 'paid' && j.status !== 'cancelled';
        }
        if (Array.isArray(j.acceptedWorkers)) {
            return j.acceptedWorkers.some(w => w.phone === phone && String(w.paymentStatus || '').toLowerCase() !== 'paid' && j.status !== 'cancelled');
        }
        return false;
    }).length;
    const earnings = workerJobs.reduce((sum, j) => {
        if (j.acceptedBy === phone && !Array.isArray(j.acceptedWorkers)) {
            if (String(j.paymentStatus || '').toLowerCase() === 'paid') {
                return sum + (Number(j.amount) || 0);
            }
        }
        if (Array.isArray(j.acceptedWorkers)) {
            const workerPaid = j.acceptedWorkers.some(w => w.phone === phone && String(w.paymentStatus || '').toLowerCase() === 'paid');
            if (workerPaid) {
                return sum + (Number(j.amount) || 0);
            }
        }
        return sum;
    }, 0);

    return {
        totalJobs: workerJobs.length,
        completedJobs: completed,
        cancelledJobs: cancelled,
        pendingJobs: pending,
        totalEarnings: earnings
    };
};

const computeCurrentConsecutiveDays = (records = []) => {
    const completedByDay = new Map();
    const cancellations = [];
    for (const r of records) {
        const d = new Date(r.eventTime || r.createdAt || Date.now());
        const day = d.toISOString().slice(0, 10);
        if (r.eventType === 'job_completed') {
            completedByDay.set(day, (completedByDay.get(day) || 0) + (Number(r.hoursWorked) || 0));
        }
        if (r.eventType === 'job_declined_offer' || r.eventType === 'job_cancelled_by_worker') {
            cancellations.push(day);
        }
    }

    const workDays = Array.from(completedByDay.entries())
        .filter(([, hours]) => hours >= 8)
        .map(([day]) => new Date(`${day}T00:00:00.000Z`))
        .sort((a, b) => b - a);

    if (!workDays.length) return { consecutiveDays: 0, cancellationsInStreak: 0 };

    let consecutive = 1;
    for (let i = 1; i < workDays.length; i++) {
        const diff = Math.floor((workDays[i - 1] - workDays[i]) / 86400000);
        if (diff === 1) consecutive += 1;
        else break;
    }

    const latest = workDays[0];
    const start = new Date(latest);
    start.setUTCDate(start.getUTCDate() - (consecutive - 1));
    const cancelsInStreak = cancellations.filter((day) => {
        const d = new Date(`${day}T00:00:00.000Z`);
        return d >= start && d <= latest;
    }).length;

    return { consecutiveDays: consecutive, cancellationsInStreak: cancelsInStreak };
};

// ============================
// REGISTER - Create new admin user
// ============================
router.post('/register', async (req, res) => {
    try {
        const { phone, name, email, password, role } = req.body;

        // Validation
        if (!phone || !name || !password || !role) {
            return res.status(400).json({ success: false, message: 'Phone, name, password, and role are required' });
        }

        if (phone.length !== 10 || !/^\d{10}$/.test(phone)) {
            return res.status(400).json({ success: false, message: 'Invalid phone number' });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ phone });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'User already exists with this phone number' });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create new user
        const newUser = new User({
            phone,
            name,
            email: email || '',
            password: hashedPassword,
            role: role || 'admin',
            createdAt: new Date(),
            updatedAt: new Date()
        });

        await newUser.save();

        // Log activity if role is admin
        if (role === 'admin') {
            await ActivityLog.create({
                userId: newUser._id.toString(),
                phone: phone,
                action: 'admin_created',
                description: `New admin user created: ${name} (${phone})`,
                timestamp: new Date()
            });
        }

        res.json({
            success: true,
            message: 'User registered successfully',
            user: {
                phone,
                name,
                role
            }
        });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// DASHBOARD - Overview stats
// ============================
router.get('/dashboard', authenticateToken, checkAdmin, async (req, res) => {
    try {
        // Basic counts
        const totalUsers = await User.countDocuments({ role: 'contractor' });
        const totalWorkers = await Worker.countDocuments();
        const totalJobs = await Job.countDocuments();
        const completedJobs = await Job.countDocuments({ status: 'completed', paymentStatus: 'paid' });
        
        const wallets = await Wallet.find().select('balance');
        const totalWalletBalance = wallets.reduce((sum, w) => sum + (w.balance || 0), 0);
        
        const verifiedUsers = await User.countDocuments({ 'verificationStatus': 'approved' });
        
        // Job Status Breakdown
        const jobsByStatus = await Job.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        
        // Payment Status Breakdown
        const paymentBreakdown = await Job.aggregate([
            { $group: { _id: '$paymentStatus', count: { $sum: 1 } } }
        ]);
        
        // Average job amount
        const avgJobAmount = await Job.aggregate([
            { $group: { _id: null, avg: { $avg: '$amount' }, total: { $sum: '$amount' } } }
        ]);
        
        // Worker availability
        const availableWorkers = await User.countDocuments({ role: 'worker', isAvailable: true });
        const unavailableWorkers = await User.countDocuments({ role: 'worker', isAvailable: false });
        
        // Verified workers
        const verifiedWorkers = await Worker.countDocuments({ isVerified: true });
        
        // Workers with ratings > 4.5
        const topRatedWorkers = await Worker.countDocuments({ avgRating: { $gte: 4.5 } });
        
        // Recent jobs (last 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentJobs = await Job.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
        
        // Recent users (last 7 days)
        const recentUsers = await User.countDocuments({ createdAt: { $gte: sevenDaysAgo } });
        
        // Support tickets status
        const ticketsByStatus = await SupportTicket.aggregate([
            { $group: { _id: '$status', count: { $sum: 1 } } }
        ]);
        
        // Open tickets
        const openTickets = await SupportTicket.countDocuments({ status: { $in: ['open', 'under_review', 'waiting_user_response'] } });
        
        // Average worker rating
        const avgWorkerRating = await Worker.aggregate([
            { $group: { _id: null, avg: { $avg: '$performanceMetrics.averageRating' } } }
        ]);
        
        // Worker skills distribution
        const skillsDistribution = await Worker.aggregate([
            { $unwind: '$skills' },
            { $group: { _id: '$skills', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 }
        ]);
        
        // Cities with most activity
        const citiesActivity = await User.aggregate([
            { $match: { city: { $exists: true, $ne: null } } },
            { $group: { _id: '$city', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 }
        ]);
        
        // Bank accounts verification status
        const bankAccountsStatus = await BankAccount.aggregate([
            { $group: { _id: '$verificationStatus', count: { $sum: 1 } } }
        ]);
        
        // Total pending verification documents
        const pendingDocuments = await VerificationDocument.countDocuments({ 
            'documents': { $elemMatch: { verificationStatus: 'pending' } }
        });
        
        // Platform revenue (paid jobs amount)
        const platformRevenue = await Job.aggregate([
            { $match: { paymentStatus: 'paid' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);

        res.json({
            success: true,
            stats: {
                // Core metrics
                totalUsers,
                totalWorkers,
                totalJobs,
                completedJobs,
                totalWalletBalance,
                verifiedUsers,
                
                // Job analytics
                jobsByStatus: jobsByStatus.reduce((acc, item) => {
                    acc[item._id || 'unknown'] = item.count;
                    return acc;
                }, {}),
                paymentBreakdown: paymentBreakdown.reduce((acc, item) => {
                    acc[item._id || 'unpaid'] = item.count;
                    return acc;
                }, {}),
                avgJobAmount: avgJobAmount[0]?.avg || 0,
                totalJobAmount: avgJobAmount[0]?.total || 0,
                
                // Worker analytics
                availableWorkers,
                unavailableWorkers,
                verifiedWorkers,
                topRatedWorkers,
                avgWorkerRating: avgWorkerRating[0]?.avg || 0,
                
                // Recent activity
                recentJobs,
                recentUsers,
                
                // Support tickets
                openTickets,
                ticketsByStatus: ticketsByStatus.reduce((acc, item) => {
                    acc[item._id || 'unknown'] = item.count;
                    return acc;
                }, {}),
                
                // Skills and locations
                topSkills: skillsDistribution.slice(0, 5),
                topCities: citiesActivity,
                
                // Verification analytics
                bankAccountsStatus: bankAccountsStatus.reduce((acc, item) => {
                    acc[item._id || 'unverified'] = item.count;
                    return acc;
                }, {}),
                pendingDocuments,
                
                // Revenue
                platformRevenue: platformRevenue[0]?.total || 0
            }
        });
    } catch (error) {
        console.error('Dashboard error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// USERS - Get all contractors
// ============================
router.get('/users', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req);
        const total = await User.countDocuments({ role: 'contractor' });
        const users = await User.find({ role: 'contractor' })
            .select('phone name email role createdAt')
            .limit(limit)
            .skip(skip)
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: users.length,
            total,
            page,
            limit,
            users
        });
    } catch (error) {
        console.error('Users error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// WORKERS - Get all workers
// ============================
router.get('/workers', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req);
        const total = await Worker.countDocuments();
        // Get workers and join with User data
        const workers = await Worker.find().skip(skip).limit(limit);
        
        // Enrich worker data with User information
        const enrichedWorkers = await Promise.all(
            workers.map(async (worker) => {
                const user = await User.findOne({ phone: worker.phone }).select('name role isVerified city isAvailable');
                return {
                    _id: worker._id,
                    phone: worker.phone,
                    name: user?.name || '-',
                    workerType: user?.role || 'worker',
                    avgRating: worker.rating || 0,
                    jobsCompleted: worker.jobsCompleted || 0,
                    skills: worker.skills || [],
                    isVerified: user?.isVerified || false,
                    isAvailable: user?.isAvailable ?? worker.isAvailable ?? false,
                    city: user?.city || '-',
                    createdAt: worker.createdAt
                };
            })
        );

        res.json({
            success: true,
            count: enrichedWorkers.length,
            total,
            page,
            limit,
            workers: enrichedWorkers
        });
    } catch (error) {
        console.error('Workers error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// JOBS - Get all jobs
// ============================
router.get('/jobs', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req);
        const total = await Job.countDocuments();
        const jobs = await Job.find()
            .limit(limit)
            .skip(skip)
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: jobs.length,
            total,
            page,
            limit,
            jobs
        });
    } catch (error) {
        console.error('Jobs error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// BANK ACCOUNTS - Get all pending
// ============================
router.get('/bank-accounts', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req);
        const total = await BankAccount.countDocuments();
        const bankAccounts = await BankAccount.find().skip(skip).limit(limit);

        res.json({
            success: true,
            count: bankAccounts.length,
            total,
            page,
            limit,
            bankAccounts
        });
    } catch (error) {
        console.error('Bank accounts error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// VERIFY BANK ACCOUNT - Approve
// ============================
router.post('/bank-accounts/:bankId/verify', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { bankId } = req.params;
        const { reason } = req.body;

        // Find and update bank account in separate collection
        const bankAccount = await BankAccount.findByIdAndUpdate(
            bankId,
            {
                verificationStatus: 'verified',
                isVerified: true,
                verificationTime: new Date()
            },
            { new: true }
        );

        if (!bankAccount) {
            return res.status(404).json({ success: false, message: 'Bank account not found' });
        }

        // Log activity
        await ActivityLog.create({
            userId: req.user.id || req.user._id || 'admin',
            phone: bankAccount.phone,
            action: 'bank_account_verified',
            description: `Bank account verified for ${bankAccount.phone}`,
            timestamp: new Date()
        });

        res.json({ success: true, message: 'Bank account verified' });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// REJECT BANK ACCOUNT
// ============================
router.post('/bank-accounts/:bankId/reject', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { bankId } = req.params;
        const { reason } = req.body;

        // Find and update bank account in separate collection
        const bankAccount = await BankAccount.findByIdAndUpdate(
            bankId,
            {
                verificationStatus: 'rejected',
                isVerified: false,
                rejectionReason: reason || 'Rejected by admin'
            },
            { new: true }
        );

        if (!bankAccount) {
            return res.status(404).json({ success: false, message: 'Bank account not found' });
        }

        // Log activity
        await ActivityLog.create({
            userId: req.user.id || req.user._id || 'admin',
            phone: bankAccount.phone,
            action: 'bank_account_rejected',
            description: `Bank account rejected for ${bankAccount.phone}: ${reason}`,
            timestamp: new Date()
        });

        res.json({ success: true, message: 'Bank account rejected' });
    } catch (error) {
        console.error('Rejection error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// VERIFICATIONS - Get documents
// ============================
router.get('/verifications', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req);
        const total = await VerificationDocument.countDocuments();
        const verifications = await VerificationDocument.find()
            .limit(limit)
            .skip(skip)
            .sort({ uploadedAt: -1 });

        // Format response with document details
        const formattedVerifications = verifications.map(v => ({
            _id: v._id,
            userId: v.userId,
            phone: v.phone,
            overallVerificationStatus: v.overallVerificationStatus,
            documents: v.documents.map(doc => ({
                _id: doc._id,
                type: doc.type,
                fileUrl: doc.fileUrl,
                fileName: doc.fileName,
                documentNumber: doc.documentNumber,
                uploadedAt: doc.uploadedAt,
                verificationStatus: doc.verificationStatus,
                verifiedAt: doc.verifiedAt,
                verifiedBy: doc.verifiedBy,
                rejectionReason: doc.rejectionReason,
                expiryDate: doc.expiryDate,
                issuingAuthority: doc.issuingAuthority,
                issuingDate: doc.issuingDate
            })),
            backgroundCheckPassed: v.backgroundCheckPassed,
            backgroundCheckDate: v.backgroundCheckDate,
            backgroundCheckProvider: v.backgroundCheckProvider,
            backgroundCheckResult: v.backgroundCheckResult,
            verificationNotes: v.verificationNotes,
            kycStatus: v.kycStatus,
            lastVerificationUpdate: v.lastVerificationUpdate
        }));

        res.json({
            success: true,
            count: formattedVerifications.length,
            total,
            page,
            limit,
            verifications: formattedVerifications
        });
    } catch (error) {
        console.error('Verifications error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// VERIFY DOCUMENT - Approve
// ============================
router.post('/verifications/:docId/approve', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { docId } = req.params;
        const doc = await VerificationDocument.findByIdAndUpdate(
            docId,
            {
                verificationStatus: 'approved',
                verifiedAt: new Date(),
                verifiedBy: req.user._id
            },
            { new: true }
        );

        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        // Log activity
        await ActivityLog.create({
            userId: req.user._id,
            action: 'VERIFICATION_APPROVED',
            details: `Document verified: ${doc.documentType}`,
            timestamp: new Date()
        });

        res.json({ success: true, message: 'Document verified' });
    } catch (error) {
        console.error('Approve error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// REJECT DOCUMENT
// ============================
router.post('/verifications/:docId/reject', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { docId } = req.params;
        const { reason } = req.body;

        const doc = await VerificationDocument.findByIdAndUpdate(
            docId,
            {
                verificationStatus: 'rejected',
                rejectionReason: reason || 'Rejected by admin',
                verifiedAt: new Date(),
                verifiedBy: req.user._id
            },
            { new: true }
        );

        if (!doc) {
            return res.status(404).json({ success: false, message: 'Document not found' });
        }

        // Log activity
        await ActivityLog.create({
            userId: req.user._id,
            action: 'VERIFICATION_REJECTED',
            details: `Document rejected: ${doc.documentType}. Reason: ${reason}`,
            timestamp: new Date()
        });

        res.json({ success: true, message: 'Document rejected' });
    } catch (error) {
        console.error('Reject error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// WALLETS - Summary
// ============================
router.get('/wallets/summary', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const wallets = await Wallet.find()
            .select('userId phone userName balance createdAt updatedAt')
            .limit(100)
            .sort({ balance: -1 });

        res.json({
            success: true,
            count: wallets.length,
            wallets
        });
    } catch (error) {
        console.error('Wallets error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// JOB DETAILS - Full detail by Job ID (single source for admin modal)
// ============================
router.get('/jobs/:jobId/details', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const rawJobId = String(req.params.jobId || '').trim();
        if (!rawJobId) {
            return res.status(400).json({ success: false, message: 'jobId is required' });
        }

        const objectId = toObjectIdOrNull(rawJobId);
        let job = null;
        if (objectId) {
            job = await Job.findById(objectId).lean();
        }
        if (!job) {
            job = await Job.findOne({ id: rawJobId }).lean();
        }
        if (!job) {
            return res.status(404).json({ success: false, message: 'Job not found' });
        }

        const canonicalJobId = job._id;
        const [timeline, walletTxRows, workerEarnings] = await Promise.all([
            JobEventLog.find({ jobId: canonicalJobId }).sort({ timestamp: -1 }).lean(),
            Wallet.aggregate([
                { $match: { 'transactions.jobId': canonicalJobId } },
                { $unwind: '$transactions' },
                { $match: { 'transactions.jobId': canonicalJobId } },
                {
                    $project: {
                        _id: 0,
                        walletPhone: '$phone',
                        txId: '$transactions._id',
                        type: '$transactions.type',
                        amount: '$transactions.amount',
                        date: '$transactions.date',
                        description: '$transactions.description',
                        orderId: '$transactions.orderId',
                        paymentId: '$transactions.paymentId',
                        payoutId: '$transactions.payoutId',
                        idempotencyKey: '$transactions.idempotencyKey',
                        status: '$transactions.status',
                        source: '$transactions.source',
                        provider: '$transactions.provider',
                        providerEventId: '$transactions.providerEventId',
                        metadata: '$transactions.metadata',
                    }
                },
                { $sort: { date: -1 } }
            ]),
            WorkerEarnings.find({ jobId: canonicalJobId })
                .select('workerPhone amount status source provider orderId paymentId payoutId providerEventId idempotencyKey earnedAt payoutRequestedAt payoutCompletedAt metadata')
                .sort({ earnedAt: -1 })
                .lean(),
        ]);

        const webhookEvents = timeline.filter((e) => String(e?.source || '').toLowerCase() === 'webhook' || String(e?.actorType || '').toLowerCase() === 'webhook');
        const paymentEvents = timeline.filter((e) => String(e?.eventType || '').toLowerCase().includes('payment') || e?.oldState?.paymentStatus !== undefined || e?.newState?.paymentStatus !== undefined);
        const timelineObservability = (timeline || []).map((event) => {
            const md = event?.metadata || {};
            const source = event?.source || null;
            const actor = event?.actorPhone || event?.actorId || event?.actorType || null;
            const paymentId =
                md?.paymentId ||
                event?.providerEventId ||
                null;
            const orderId = md?.orderId || null;
            const webhookTime = String(source || '').toLowerCase() === 'webhook'
                ? (md?.webhookTime || event?.timestamp || event?.createdAt || null)
                : null;
            return {
                eventType: event?.eventType || null,
                timestamp: event?.timestamp || event?.createdAt || null,
                actor,
                actorType: event?.actorType || null,
                source,
                idempotencyKey: event?.idempotencyKey || md?.idempotencyKey || null,
                orderId,
                paymentId,
                webhookTime,
                provider: event?.provider || null,
                providerEventId: event?.providerEventId || null,
            };
        });
        const providerIds = new Set();
        for (const tx of walletTxRows || []) {
            if (tx?.paymentId) providerIds.add(String(tx.paymentId));
            if (tx?.orderId) providerIds.add(String(tx.orderId));
            if (tx?.providerEventId) providerIds.add(String(tx.providerEventId));
        }
        for (const ev of paymentEvents || []) {
            if (ev?.providerEventId) providerIds.add(String(ev.providerEventId));
        }
        const providerIdList = Array.from(providerIds.values());
        const reconciliationRuns = providerIdList.length
            ? await ReconciliationRun.find({
                mismatches: {
                    $elemMatch: {
                        $or: [
                            { providerId: { $in: providerIdList } },
                            { localId: { $in: providerIdList } },
                        ],
                    },
                },
            })
                .sort({ startedAt: -1 })
                .limit(20)
                .lean()
            : [];

        return res.json({
            success: true,
            job,
            details: {
                acceptance: {
                    acceptedBy: job.acceptedBy || null,
                    acceptedAt: job.acceptedAt || null,
                    acceptedWorker: job.acceptedWorker || null,
                    acceptedWorkers: Array.isArray(job.acceptedWorkers) ? job.acceptedWorkers : [],
                },
                attendance: {
                    status: job.attendanceStatus || null,
                    time: job.attendanceTime || null,
                    bulkWorkers: Array.isArray(job.acceptedWorkers)
                        ? job.acceptedWorkers.map((w) => ({
                            phone: w.phone || null,
                            name: w.name || null,
                            attendanceStatus: w.attendanceStatus || null,
                            attendanceTime: w.attendanceTime || null,
                            paymentStatus: w.paymentStatus || null,
                            paymentMode: w.paymentMode || null,
                            paymentTime: w.paymentTime || null,
                        }))
                        : [],
                },
                payment: {
                    status: job.paymentStatus || null,
                    mode: job.paymentMode || null,
                    paymentTime: job.paymentTime || null,
                    amount: Number(job.amount || 0),
                    walletTransactions: walletTxRows,
                    workerEarnings,
                    paymentEvents,
                    webhookEvents,
                    timelineObservability,
                    reconciliation: {
                        matchedProviderIds: providerIdList,
                        runs: reconciliationRuns.map((run) => ({
                            _id: run._id,
                            runType: run.runType,
                            provider: run.provider,
                            status: run.status,
                            startedAt: run.startedAt,
                            completedAt: run.completedAt,
                            mismatches: (run.mismatches || []).filter((m) => {
                                const pid = String(m?.providerId || "");
                                const lid = String(m?.localId || "");
                                return providerIds.has(pid) || providerIds.has(lid);
                            }),
                        })),
                    },
                },
                timeline,
            },
        });
    } catch (error) {
        console.error('Job details error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// GLOBAL SEARCH - users/workers/jobs/tickets/wallets
// ============================
router.get('/search', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const q = safeText(req.query.q || '', 80);
        const { limit } = parsePagination(req, 20, 100);
        if (!q) return res.status(400).json({ success: false, message: 'q is required' });

        const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const maybeJobId = toObjectIdOrNull(q);

        const [users, workers, wallets, jobs, tickets] = await Promise.all([
            User.find({ $or: [{ phone: regex }, { name: regex }, ...(maybeJobId ? [{ _id: maybeJobId }] : [])] }).limit(limit).lean(),
            Worker.find({ $or: [{ phone: regex }, { skills: regex }, ...(maybeJobId ? [{ _id: maybeJobId }] : [])] }).limit(limit).lean(),
            Wallet.find({ $or: [{ phone: regex }, { userName: regex }] }).limit(limit).lean(),
            Job.find({
                $or: [
                    ...(maybeJobId ? [{ _id: maybeJobId }] : []),
                    { title: regex },
                    { contractorPhone: regex },
                    { contractorName: regex },
                    { acceptedBy: regex },
                    { 'acceptedWorkers.phone': regex },
                ],
            }).limit(limit).sort({ createdAt: -1 }).lean(),
            SupportTicket.find({
                $or: [{ ticketId: regex }, { ticketNumber: regex }, { reporterPhone: regex }, { subject: regex }],
            }).limit(limit).sort({ createdAt: -1 }).lean(),
        ]);
        const workerPhones = workers.map((w) => w.phone).filter(Boolean);
        const workerUsers = await User.find({ phone: { $in: workerPhones } }).select('phone isAvailable').lean();
        const workerUserAvailability = new Map(workerUsers.map((u) => [u.phone, !!u.isAvailable]));

        return res.json({
            success: true,
            query: q,
            results: {
                users: users.map((u) => ({ _id: u._id, phone: u.phone, name: u.name, role: u.role, city: u.city })),
                workers: workers.map((w) => ({
                    _id: w._id,
                    phone: w.phone,
                    isAvailable: workerUserAvailability.has(w.phone)
                        ? workerUserAvailability.get(w.phone)
                        : !!w.isAvailable,
                    rating: w.rating,
                    isBlocked: w.isBlocked
                })),
                wallets: wallets.map((w) => ({ _id: w._id, phone: w.phone, balance: w.balance, availableBalance: w.availableBalance, pocketBalance: w.pocketBalance })),
                jobs: jobs.map((j) => ({ _id: j._id, title: j.title, contractorPhone: j.contractorPhone, status: j.status, paymentStatus: j.paymentStatus })),
                tickets: tickets.map((t) => ({ _id: t._id, ticketId: t.ticketId, status: t.status, priority: t.priority, reporterPhone: t.reporterPhone })),
            },
        });
    } catch (error) {
        console.error('Global search error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// OPS ALERTS - bell notifications
// ============================
router.get('/ops-alerts', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req, 20, 100);
        const unreadOnly = String(req.query.unreadOnly || '').toLowerCase() === 'true';
        const viewerPhone = String(req.user?.phone || '');
        const visibilityQuery = {
            $or: [
                { audiences: { $in: ['admin', 'all'] } },
                { audiences: { $exists: false } },
                { targetPhones: viewerPhone },
            ],
        };
        const query = unreadOnly
            ? { ...visibilityQuery, readByPhones: { $ne: viewerPhone } }
            : visibilityQuery;
        const [alerts, unreadCount, total] = await Promise.all([
            OpsAlert.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
            OpsAlert.countDocuments({ ...visibilityQuery, readByPhones: { $ne: viewerPhone } }),
            OpsAlert.countDocuments(query),
        ]);

        return res.json({
            success: true,
            page,
            limit,
            total,
            unreadCount,
            alerts: alerts.map((a) => ({
                ...a,
                read: Array.isArray(a.readByPhones) ? a.readByPhones.includes(viewerPhone) : false,
            })),
        });
    } catch (error) {
        console.error('Ops alerts fetch error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.patch('/ops-alerts/:id/read', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const alertId = toObjectIdOrNull(req.params.id);
        if (!alertId) return res.status(400).json({ success: false, message: 'Invalid alert id' });
        const viewerPhone = String(req.user?.phone || '');
        const alertDoc = await OpsAlert.findByIdAndUpdate(
            alertId,
            { $addToSet: { readByPhones: viewerPhone }, $set: { read: true, readAt: new Date() } },
            { new: true }
        ).lean();
        if (!alertDoc) return res.status(404).json({ success: false, message: 'Alert not found' });
        const unreadCount = await OpsAlert.countDocuments({
            $or: [
                { audiences: { $in: ['admin', 'all'] } },
                { audiences: { $exists: false } },
                { targetPhones: viewerPhone },
            ],
            readByPhones: { $ne: viewerPhone },
        });
        return res.json({
            success: true,
            alert: { ...alertDoc, read: true },
            unreadCount,
        });
    } catch (error) {
        console.error('Ops alert read error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.patch('/ops-alerts/read-all', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const viewerPhone = String(req.user?.phone || '');
        await OpsAlert.updateMany(
            {
                $or: [
                    { audiences: { $in: ['admin', 'all'] } },
                    { audiences: { $exists: false } },
                    { targetPhones: viewerPhone },
                ],
                readByPhones: { $ne: viewerPhone },
            },
            { $addToSet: { readByPhones: viewerPhone }, $set: { read: true, readAt: new Date() } }
        );
        return res.json({ success: true, unreadCount: 0 });
    } catch (error) {
        console.error('Ops alert read-all error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// WORKER CONTROL - block/unblock/force offline/risk flags
// ============================
router.patch('/workers/:phone/control', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const phone = String(req.params.phone || '').trim();
        if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'Valid phone required' });

        const worker = await Worker.findOne({ phone });
        if (!worker) return res.status(404).json({ success: false, message: 'Worker not found' });
        const user = await User.findOne({ phone }).select('isAvailable').lean();

        const before = {
            isAvailable: user?.isAvailable ?? worker.isAvailable ?? false,
            isBlocked: worker.isBlocked || false,
            blockedReason: worker.blockedReason || '',
            riskFlags: worker.riskFlags || [],
        };

        const {
            block,
            blockReason,
            forceOffline,
            forceOfflineReason,
            setAvailability,
            addRiskFlags = [],
            removeRiskFlags = [],
        } = req.body || {};

        if (typeof block === 'boolean') {
            worker.isBlocked = block;
            worker.blockedReason = block ? safeText(blockReason, 200) : '';
            // Blocking should always force worker offline so backend remains source of truth.
            if (block) {
                worker.isAvailable = false;
                worker.forceOfflineAt = new Date();
                worker.forceOfflineReason = safeText(blockReason || 'blocked_by_admin', 200);
                await User.updateOne({ phone }, { $set: { isAvailable: false } });
            }
        }

        if (forceOffline === true) {
            worker.isAvailable = false;
            worker.forceOfflineAt = new Date();
            worker.forceOfflineReason = safeText(forceOfflineReason, 200);
            await User.updateOne({ phone }, { $set: { isAvailable: false } });
        }

        if (typeof setAvailability === 'boolean') {
            if (setAvailability === true && worker.isBlocked) {
                return res.status(400).json({
                    success: false,
                    message: 'Blocked worker cannot be set online. Unblock first.',
                    code: 'WORKER_BLOCKED',
                });
            }
            worker.isAvailable = setAvailability;
            if (setAvailability === false) {
                worker.forceOfflineAt = new Date();
                worker.forceOfflineReason = safeText(forceOfflineReason || 'set_offline_by_admin', 200);
            }
            await User.updateOne({ phone }, { $set: { isAvailable: setAvailability } });
        }

        const currentFlags = new Set(Array.isArray(worker.riskFlags) ? worker.riskFlags : []);
        for (const f of (Array.isArray(addRiskFlags) ? addRiskFlags : [])) currentFlags.add(safeText(f, 60));
        for (const f of (Array.isArray(removeRiskFlags) ? removeRiskFlags : [])) currentFlags.delete(safeText(f, 60));
        worker.riskFlags = Array.from(currentFlags).filter(Boolean);

        await worker.save();
        const syncedUser = await User.findOne({ phone }).select('isAvailable').lean();
        const availabilityTruth = syncedUser?.isAvailable ?? worker.isAvailable ?? false;

        // Keep in-memory/socket state aligned for dispatch logic and worker UI.
        try {
            const io = req.app.get('io');
            if (io) {
                io.to(phone).emit('workerControlUpdated', {
                    phone,
                    isAvailable: !!availabilityTruth,
                    isBlocked: !!worker.isBlocked,
                    blockedReason: worker.blockedReason || '',
                    forceOfflineAt: worker.forceOfflineAt || null,
                    forceOfflineReason: worker.forceOfflineReason || '',
                    updatedAt: new Date(),
                });
            }
        } catch (emitErr) {
            console.warn('Worker control emit warning:', emitErr?.message || emitErr);
        }

        await logAdminAudit({
            req,
            action: 'admin_action',
            phone,
            description: 'Worker control update',
            before,
            after: {
                isAvailable: availabilityTruth,
                isBlocked: worker.isBlocked,
                blockedReason: worker.blockedReason,
                riskFlags: worker.riskFlags,
                forceOfflineAt: worker.forceOfflineAt,
            },
            metadata: { operation: 'worker_control' },
        });

        return res.json({
            success: true,
            worker: {
                ...worker.toObject(),
                isAvailable: availabilityTruth,
            },
        });
    } catch (error) {
        console.error('Worker control error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// JOB TIMELINE - immutable events from JobEventLog
// ============================
router.get('/jobs/:jobId/timeline', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.params.jobId);
        if (!jobId) return res.status(400).json({ success: false, message: 'Invalid jobId' });

        const events = await JobEventLog.find({ jobId }).sort({ timestamp: -1 }).lean();
        return res.json({ success: true, count: events.length, events });
    } catch (error) {
        console.error('Job timeline error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// JOBS CONTROL CENTER - manual interventions
// ============================
router.post('/jobs/:jobId/reassign', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.params.jobId);
        const toWorkerPhone = safeText(req.body?.toWorkerPhone, 20);
        const reason = safeText(req.body?.reason || 'admin_reassign', 300);
        if (!jobId || !isValidPhone(toWorkerPhone)) return res.status(400).json({ success: false, message: 'Invalid jobId or toWorkerPhone' });

        const job = await Job.findById(jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        const before = { acceptedBy: job.acceptedBy, status: job.status };
        job.acceptedBy = toWorkerPhone;
        job.status = 'accepted';
        job.acceptedAt = new Date();
        await job.save();

        await JobEventLog.create({
            jobId: job._id,
            eventType: 'admin_reassign',
            actorType: 'admin',
            actorPhone: req.user.phone || null,
            oldState: before,
            newState: { acceptedBy: job.acceptedBy, status: job.status },
            source: 'admin_panel',
            reasonText: reason,
            metadata: { toWorkerPhone },
        });

        await logAdminAudit({ req, action: 'job_reassigned_admin', phone: job.contractorPhone, description: `Job reassigned to ${toWorkerPhone}`, before, after: { acceptedBy: toWorkerPhone, status: 'accepted' } });

        return res.json({ success: true, job });
    } catch (error) {
        console.error('Job reassign error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/jobs/:jobId/expire-now', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.params.jobId);
        if (!jobId) return res.status(400).json({ success: false, message: 'Invalid jobId' });
        const reason = safeText(req.body?.reason || 'admin_expire_now', 300);
        const job = await Job.findById(jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        const before = { status: job.status, offerExpiresAt: job.offerExpiresAt };
        job.status = 'expired';
        job.isCancelled = true;
        job.offerExpiresAt = new Date();
        await job.save();

        await JobEventLog.create({
            jobId: job._id,
            eventType: 'admin_expire_now',
            actorType: 'admin',
            actorPhone: req.user.phone || null,
            oldState: before,
            newState: { status: job.status, offerExpiresAt: job.offerExpiresAt },
            source: 'admin_panel',
            reasonText: reason,
        });

        await logAdminAudit({ req, action: 'job_expired_admin', phone: job.contractorPhone, description: 'Job expired manually', before, after: { status: job.status, offerExpiresAt: job.offerExpiresAt } });
        return res.json({ success: true, job });
    } catch (error) {
        console.error('Expire now error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/jobs/:jobId/reopen', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.params.jobId);
        if (!jobId) return res.status(400).json({ success: false, message: 'Invalid jobId' });
        const reason = safeText(req.body?.reason || 'admin_reopen', 300);

        const job = await Job.findById(jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        const before = { status: job.status, isCancelled: job.isCancelled, acceptedBy: job.acceptedBy };
        await Job.updateOne(
            { _id: job._id },
            {
                $set: {
                    status: 'posted',
                    isCancelled: false,
                    acceptedBy: '',
                    acceptedAt: null,
                    offerExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
                },
            }
        );
        const updated = await Job.findById(job._id).lean();

        await JobEventLog.create({
            jobId: job._id,
            eventType: 'admin_reopen',
            actorType: 'admin',
            actorPhone: req.user.phone || null,
            oldState: before,
            newState: { status: 'posted', isCancelled: false },
            source: 'admin_panel',
            reasonText: reason,
        });

        await logAdminAudit({ req, action: 'job_reopened_admin', phone: job.contractorPhone, description: 'Job reopened manually', before, after: { status: 'posted', isCancelled: false } });
        return res.json({ success: true, job: updated });
    } catch (error) {
        console.error('Job reopen error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/jobs/:jobId/manual-cancel', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.params.jobId);
        if (!jobId) return res.status(400).json({ success: false, message: 'Invalid jobId' });
        const reason = safeText(req.body?.reason || 'admin_manual_cancel', 300);

        const job = await Job.findById(jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });

        const before = { status: job.status, isCancelled: job.isCancelled };
        job.status = 'cancelled';
        job.isCancelled = true;
        await job.save();

        await JobEventLog.create({
            jobId: job._id,
            eventType: 'admin_manual_cancel',
            actorType: 'admin',
            actorPhone: req.user.phone || null,
            oldState: before,
            newState: { status: job.status, isCancelled: job.isCancelled },
            source: 'admin_panel',
            reasonText: reason,
        });

        await logAdminAudit({ req, action: 'job_cancelled_admin', phone: job.contractorPhone, description: `Job cancelled manually: ${reason}`, before, after: { status: job.status, isCancelled: true } });
        return res.json({ success: true, job });
    } catch (error) {
        console.error('Manual cancel error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// BULK ATTENDANCE / PAYMENT ACTIONS
// ============================
router.post('/jobs/:jobId/bulk/attendance', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.params.jobId);
        const workerPhone = safeText(req.body?.workerPhone, 20);
        const attendanceStatus = safeText(req.body?.attendanceStatus, 20);
        if (!jobId || !isValidPhone(workerPhone) || !['Present', 'Absent'].includes(attendanceStatus)) {
            return res.status(400).json({ success: false, message: 'Invalid payload' });
        }

        const job = await Job.findById(jobId);
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
        const before = (job.acceptedWorkers || []).find((w) => w.phone === workerPhone) || null;

        await Job.updateOne(
            { _id: job._id, 'acceptedWorkers.phone': workerPhone },
            {
                $set: {
                    'acceptedWorkers.$.attendanceStatus': attendanceStatus,
                    'acceptedWorkers.$.attendanceTime': new Date(),
                },
            }
        );

        const after = await Job.findOne({ _id: job._id, 'acceptedWorkers.phone': workerPhone }, { 'acceptedWorkers.$': 1 }).lean();

        await JobEventLog.create({
            jobId: job._id,
            eventType: 'admin_bulk_attendance_marked',
            actorType: 'admin',
            actorPhone: req.user.phone || null,
            oldState: before,
            newState: after?.acceptedWorkers?.[0] || null,
            source: 'admin_panel',
            metadata: { workerPhone, attendanceStatus },
        });

        await logAdminAudit({ req, action: 'admin_action', phone: workerPhone, description: `Bulk attendance marked: ${attendanceStatus}`, before, after: after?.acceptedWorkers?.[0] || null, metadata: { operation: 'bulk_attendance', jobId: String(job._id) } });
        return res.json({ success: true });
    } catch (error) {
        console.error('Bulk attendance error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/jobs/:jobId/bulk/payment', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.params.jobId);
        const workerPhone = safeText(req.body?.workerPhone, 20);
        const idempotencyKey = safeText(req.body?.idempotencyKey || req.header('X-Idempotency-Key'), 120);
        const paymentMode = safeText(req.body?.paymentMode || 'online', 30);
        if (!jobId || !isValidPhone(workerPhone) || !idempotencyKey) {
            return res.status(400).json({ success: false, message: 'jobId, workerPhone, idempotencyKey required' });
        }

        const job = await Job.findById(jobId).lean();
        if (!job) return res.status(404).json({ success: false, message: 'Job not found' });
        const acceptedWorker = (job.acceptedWorkers || []).find((w) => w.phone === workerPhone);
        if (!acceptedWorker) return res.status(404).json({ success: false, message: 'Worker entry not found in bulk job' });
        if (String(acceptedWorker.paymentStatus || '').toLowerCase() === 'paid') return res.status(409).json({ success: false, message: 'Already paid' });

        const workerWallet = await Wallet.findOne({ phone: workerPhone });
        if (!workerWallet) return res.status(404).json({ success: false, message: 'Worker wallet not found' });

        const duplicate = (workerWallet.transactions || []).find((t) => t.idempotencyKey === idempotencyKey && t.status === 'completed');
        if (duplicate) return res.json({ success: true, idempotent: true, transaction: duplicate });

        const amount = Number(job.amount || 0);
        if (amount <= 0) {
          return res.status(400).json({ success: false, message: 'Invalid payment amount' });
        }

        // 🔐 ATOMIC WALLET UPDATE: Use $inc + $push with MongoDB atomicity (prevents race conditions and phantom credits)
        const updatedWallet = await Wallet.findOneAndUpdate(
          { phone: workerPhone },
          {
            $inc: {
              balance: amount,
              availableBalance: amount,
              totalEarned: amount
            },
            $push: {
              transactions: {
                type: 'payment',
                amount,
                description: `Admin bulk payout for job ${job.title || ''}`.trim(),
                jobId: job._id,
                idempotencyKey,
                status: 'completed',
                date: new Date(),
                source: 'admin',
                provider: 'internal',
                metadata: { workerPhone, paymentMode, actor: req.user.phone || 'admin' },
              }
            }
          },
          { new: true }
        );

        if (!updatedWallet) {
          return res.status(500).json({ success: false, message: 'Failed to update worker wallet' });
        }

        try {
            const week = getWeekRange();
            await WorkerEarnings.findOneAndUpdate(
                { workerPhone, jobId: job._id },
                {
                    $setOnInsert: {
                        workerPhone,
                        jobId: job._id,
                        amount,
                        currency: 'INR',
                        status: 'earned',
                        source: 'admin',
                        provider: 'manual',
                        providerEventId: `admin_bulk:${idempotencyKey}`,
                        idempotencyKey: `admin_bulk:${idempotencyKey}`,
                        earnedAt: new Date(),
                        payoutWeek: {
                            year: Number(week.start.getUTCFullYear()),
                            week: Number(week.week),
                            startDate: week.start,
                            endDate: week.end,
                        },
                        contractorName: job.contractorName,
                        contractorPhone: job.contractorPhone,
                        jobTitle: job.title,
                        notes: `Admin marked payment as paid (${paymentMode})`,
                        metadata: {
                            createdFrom: 'admin_bulk_payment',
                            paymentMode,
                            actor: req.user.phone || 'admin',
                        },
                    },
                },
                { upsert: true, new: true }
            );
        } catch (earningErr) {
            console.error('WorkerEarnings upsert error (admin bulk payment):', earningErr);
        }

        await Job.updateOne(
            { _id: job._id, 'acceptedWorkers.phone': workerPhone },
            {
                $set: {
                    'acceptedWorkers.$.paymentStatus': 'paid',
                    'acceptedWorkers.$.paymentMode': paymentMode,
                    'acceptedWorkers.$.paymentTime': new Date(),
                },
            }
        );

        await JobEventLog.create({
            jobId: job._id,
            eventType: 'admin_bulk_payment',
            actorType: 'admin',
            actorPhone: req.user.phone || null,
            source: 'admin_panel',
            idempotencyKey,
            metadata: { workerPhone, amount, paymentMode },
        });

        await logAdminAudit({ req, action: 'job_payment_admin', phone: workerPhone, description: `Bulk payment marked paid`, before: acceptedWorker, after: { paymentStatus: 'paid', paymentMode }, metadata: { idempotencyKey, jobId: String(job._id) } });

        return res.json({ success: true, amount, workerPhone, idempotencyKey, walletBalance: updatedWallet.balance, availableBalance: updatedWallet.availableBalance });
    } catch (error) {
        console.error('Bulk payment error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// LEDGER + WALLET ADJUSTMENTS (maker-checker)
// ============================
router.get('/ledger', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { phone, type, from, to } = req.query || {};
        const { limit } = parsePagination(req, 200, 1000);

        const walletQuery = {};
        if (phone) walletQuery.phone = String(phone).trim();
        const wallets = await Wallet.find(walletQuery).select('phone transactions').limit(500).lean();

        const fromDate = from ? new Date(from) : null;
        const toDate = to ? new Date(to) : null;

        const rows = [];
        for (const w of wallets) {
            for (const t of (w.transactions || [])) {
                if (type && t.type !== type) continue;
                const d = t.date ? new Date(t.date) : null;
                if (fromDate && d && d < fromDate) continue;
                if (toDate && d && d > toDate) continue;
                rows.push({
                    phone: w.phone,
                    txType: t.type || '',
                    amount: Number(t.amount || 0),
                    status: t.status || '',
                    date: d ? d.toISOString() : '',
                    jobId: t.jobId || '',
                    paymentId: t.paymentId || '',
                    orderId: t.orderId || '',
                    payoutId: t.payoutId || '',
                    idempotencyKey: t.idempotencyKey || '',
                    openingBalance: Number(t.openingBalance || 0),
                    closingBalance: Number(t.closingBalance || 0),
                    source: t.source || '',
                    provider: t.provider || '',
                    actor: t.metadata?.actor || '',
                    reason: t.description || '',
                });
            }
        }

        rows.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
        return res.json({ success: true, count: Math.min(rows.length, limit), rows: rows.slice(0, limit) });
    } catch (error) {
        console.error('Ledger error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/wallet-adjustments', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { phone, amount, mode = 'credit', reason } = req.body || {};
        const normalizedPhone = String(phone || '').trim();
        const normalizedAmount = Number(amount || 0);
        const normalizedMode = String(mode).trim().toLowerCase();
        if (!isValidPhone(normalizedPhone) || !Number.isFinite(normalizedAmount) || normalizedAmount <= 0 || !['credit', 'debit'].includes(normalizedMode)) {
            return res.status(400).json({ success: false, message: 'Invalid payload' });
        }

        const wallet = await Wallet.findOne({ phone: normalizedPhone });
        if (!wallet) return res.status(404).json({ success: false, message: 'Wallet not found' });

        const opening = Number(wallet.availableBalance ?? wallet.balance ?? 0);
        const delta = normalizedMode === 'debit' ? -Math.abs(normalizedAmount) : Math.abs(normalizedAmount);
        const closing = opening + delta;
        if (closing < 0) return res.status(409).json({ success: false, message: 'Insufficient balance for debit adjustment' });

        const id = generateRef('wadj');
        const row = {
            id,
            phone: normalizedPhone,
            amount: normalizedAmount,
            mode: normalizedMode,
            reason: safeText(reason || 'manual_adjustment', 300),
            status: 'approved',
            makerPhone: req.user.phone || 'admin',
            checkerPhone: req.user.phone || 'admin',
            createdAt: new Date().toISOString(),
            approvedAt: new Date().toISOString(),
            rejectedAt: null,
        };

        wallet.availableBalance = closing;
        wallet.balance = closing;
        wallet.transactions.push({
            type: normalizedMode === 'debit' ? 'withdraw' : 'deposit',
            amount: Math.abs(normalizedAmount),
            description: `Admin adjustment (${normalizedMode}): ${row.reason}`,
            idempotencyKey: id,
            status: 'completed',
            openingBalance: opening,
            closingBalance: closing,
            source: 'admin',
            provider: 'internal',
            metadata: { actor: req.user.phone || 'admin', checker: req.user.phone || 'admin', reason: row.reason },
        });
        wallet.updateTotals();
        await wallet.save();
        adminAdjustments.set(id, row);

        await logAdminAudit({
            req,
            action: 'wallet_adjustment_approved',
            phone: normalizedPhone,
            description: `Wallet adjustment applied ${normalizedMode} ${normalizedAmount}`,
            before: { balance: opening },
            after: { balance: closing, adjustment: row },
            metadata: { adjustmentId: id },
        });
        return res.json({ success: true, adjustment: row });
    } catch (error) {
        console.error('Wallet adjustment apply error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/wallet-adjustments', authenticateToken, checkAdmin, async (_req, res) => {
    try {
        const rows = Array.from(adminAdjustments.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return res.json({ success: true, count: rows.length, rows });
    } catch (error) {
        console.error('Wallet adjustments list error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/wallet-adjustments/:id/approve', authenticateToken, checkAdmin, async (req, res) => {
    return res.status(410).json({ success: false, message: 'Approval step removed. Adjustment is applied immediately on create.' });
});

router.post('/wallet-adjustments/:id/reject', authenticateToken, checkAdmin, async (req, res) => {
    return res.status(410).json({ success: false, message: 'Reject step removed. Adjustment is applied immediately on create.' });
});

// ============================
// PAYMENT / REFUND / DISPUTE (admin controls)
// ============================
router.post('/finance/refund', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const jobId = toObjectIdOrNull(req.body?.jobId);
        const contractorPhone = safeText(req.body?.contractorPhone, 20);
        const amount = Number(req.body?.amount || 0);
        const idempotencyKey = safeText(req.body?.idempotencyKey || req.header('X-Idempotency-Key'), 120);
        if (!jobId || !isValidPhone(contractorPhone) || !Number.isFinite(amount) || amount <= 0 || !idempotencyKey) {
            return res.status(400).json({ success: false, message: 'Invalid payload' });
        }

        const wallet = await Wallet.findOne({ phone: contractorPhone });
        if (!wallet) return res.status(404).json({ success: false, message: 'Contractor wallet not found' });
        const duplicate = (wallet.transactions || []).find((t) => t.idempotencyKey === idempotencyKey && t.status === 'completed');
        if (duplicate) return res.json({ success: true, idempotent: true, transaction: duplicate });

        const opening = Number(wallet.availableBalance || wallet.balance || 0);
        const closing = opening + amount;
        wallet.availableBalance = closing;
        wallet.balance = closing;
        wallet.transactions.push({
            type: 'refund',
            amount,
            description: `Admin refund for job ${jobId}`,
            jobId,
            idempotencyKey,
            status: 'completed',
            openingBalance: opening,
            closingBalance: closing,
            source: 'admin',
            provider: 'internal',
            metadata: { actor: req.user.phone || 'admin', reason: safeText(req.body?.reason || '', 200) },
        });
        wallet.updateTotals();
        await wallet.save();

        await logAdminAudit({ req, action: 'job_refund_admin', phone: contractorPhone, description: `Refund processed`, before: { balance: opening }, after: { balance: closing }, metadata: { jobId: String(jobId), idempotencyKey, amount } });
        return res.json({ success: true, amount, contractorPhone, idempotencyKey });
    } catch (error) {
        console.error('Admin refund error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/finance/disputes', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const id = generateRef('disp');
        const row = {
            id,
            jobId: safeText(req.body?.jobId, 40),
            workerPhone: safeText(req.body?.workerPhone, 20),
            contractorPhone: safeText(req.body?.contractorPhone, 20),
            issueType: safeText(req.body?.issueType || 'payment_dispute', 80),
            reason: safeText(req.body?.reason || '', 500),
            status: 'open',
            createdBy: req.user.phone || 'admin',
            createdAt: new Date().toISOString(),
            resolvedBy: null,
            resolution: null,
        };
        adminDisputes.set(id, row);
        await logAdminAudit({ req, action: 'job_dispute_admin', phone: row.contractorPhone || row.workerPhone, description: `Dispute created`, before: null, after: row, metadata: { disputeId: id } });
        return res.json({ success: true, dispute: row });
    } catch (error) {
        console.error('Create dispute error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.patch('/finance/disputes/:id', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const row = adminDisputes.get(req.params.id);
        if (!row) return res.status(404).json({ success: false, message: 'Dispute not found' });

        const status = safeText(req.body?.status || '', 40);
        if (!['open', 'under_review', 'resolved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status' });
        }

        const before = { ...row };
        row.status = status;
        row.resolution = safeText(req.body?.resolution || row.resolution || '', 500);
        row.resolvedBy = req.user.phone || 'admin';
        row.resolvedAt = new Date().toISOString();
        adminDisputes.set(row.id, row);

        await logAdminAudit({ req, action: 'job_dispute_admin', phone: row.contractorPhone || row.workerPhone, description: `Dispute ${row.id} set to ${status}`, before, after: row, metadata: { disputeId: row.id } });
        return res.json({ success: true, dispute: row });
    } catch (error) {
        console.error('Update dispute error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/finance/disputes', authenticateToken, checkAdmin, async (_req, res) => {
    try {
        const rows = Array.from(adminDisputes.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return res.json({ success: true, count: rows.length, rows });
    } catch (error) {
        console.error('List disputes error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// PAYOUT QUEUE + STATE MACHINE
// ============================
router.get('/payouts/queue', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const status = safeText(req.query.status || '', 40);
        const query = status ? { status } : {};
        const batches = await PayoutBatch.find(query).sort({ createdAt: -1 }).limit(200).lean();
        return res.json({ success: true, count: batches.length, batches });
    } catch (error) {
        console.error('Payout queue error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/payouts/batches', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { start, end } = req.body || {};
        const week = getWeekRange();
        const startDate = start ? new Date(start) : week.start;
        const endDate = end ? new Date(end) : week.end;

        // Single payout pipeline source: WorkerEarnings ledger.
        const weekEarnings = await WorkerEarnings.find({
            earnedAt: { $gte: startDate, $lt: endDate },
            status: { $in: ['earned', 'payout_requested'] },
        }).lean();

        if (!weekEarnings.length) {
            return res.status(400).json({ success: false, message: 'No eligible worker earnings found for this window' });
        }

        const byWorker = new Map();
        for (const earning of weekEarnings) {
            const phone = safeText(earning.workerPhone, 20);
            if (!isValidPhone(phone)) continue;
            if (!byWorker.has(phone)) byWorker.set(phone, { workerPhone: phone, workerName: '', earningsAmount: 0, deductions: 0, netAmount: 0, status: 'pending', earningIds: [] });
            const row = byWorker.get(phone);
            const amount = Number(earning.amount || 0);
            row.earningsAmount += amount;
            row.netAmount += amount;
            row.earningIds.push(String(earning._id));
        }

        if (!byWorker.size) {
            return res.status(400).json({ success: false, message: 'No valid worker earnings found for payout batch' });
        }

        const now = new Date();
        const year = now.getUTCFullYear();
        const wk = Math.ceil((((now - new Date(Date.UTC(year, 0, 1))) / 86400000) + new Date(Date.UTC(year, 0, 1)).getUTCDay() + 1) / 7);
        const batchId = generateRef(`PAYOUT_${year}_W${wk}`);

        const batch = await PayoutBatch.create({
            batchId,
            payoutWeek: { year, week: wk, startDate, endDate },
            status: 'pending',
            totalAmount: Array.from(byWorker.values()).reduce((s, r) => s + Number(r.netAmount || 0), 0),
            totalWorkers: byWorker.size,
            workers: Array.from(byWorker.values()),
            notes: safeText(req.body?.notes || '', 500),
            processedBy: req.user.phone || 'admin',
        });

        await logAdminAudit({ req, action: 'payout_batch_created', phone: req.user.phone || 'admin', description: `Payout batch created ${batchId}`, before: null, after: { batchId, totalAmount: batch.totalAmount, totalWorkers: batch.totalWorkers }, metadata: { batchId } });
        return res.json({ success: true, batch });
    } catch (error) {
        console.error('Create payout batch error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/payouts/weekly-settlement/run', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const io = req.app.get('io');
        const result = await runWeeklyWalletSettlement(new Date(), { io });
        await logAdminAudit({
            req,
            action: 'payout_batch_state_changed',
            phone: req.user.phone || 'admin',
            description: 'Manual weekly wallet settlement run',
            before: null,
            after: result,
            metadata: { source: 'admin_console' },
        });
        return res.json({ success: true, message: 'Weekly settlement run completed', result });
    } catch (error) {
        console.error('Weekly settlement run error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.patch('/payouts/:batchId/state', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const batchId = String(req.params.batchId || '').trim();
        const next = safeText(req.body?.status || '', 40);
        const allowed = ['queued', 'pending', 'processing', 'success', 'completed', 'failed', 'retry'];
        if (!allowed.includes(next)) return res.status(400).json({ success: false, message: 'Invalid status' });

        const batch = await PayoutBatch.findOne({ batchId });
        if (!batch) return res.status(404).json({ success: false, message: 'Batch not found' });
        const before = { status: batch.status };

        if (next === 'retry') {
            batch.status = 'processing';
            for (const w of batch.workers || []) {
                if (w.status === 'failed') w.status = 'pending';
            }
        } else if (next === 'success') {
            batch.status = 'completed';
            batch.completedAt = new Date();
            for (const w of batch.workers || []) {
                if (w.status !== 'success') w.status = 'success';
            }
            // Source-of-truth sync: mark underlying earnings as paid out for this batch window.
            await WorkerEarnings.updateMany(
                {
                    workerPhone: { $in: (batch.workers || []).map((w) => w.workerPhone).filter(Boolean) },
                    earnedAt: { $gte: batch.payoutWeek.startDate, $lt: batch.payoutWeek.endDate },
                    status: { $in: ['earned', 'payout_requested'] },
                },
                {
                    $set: {
                        status: 'payout_completed',
                        payoutCompletedAt: new Date(),
                        source: 'admin',
                        provider: 'internal',
                        providerEventId: `batch:${batch.batchId}`,
                    },
                }
            );
        } else {
            batch.status = next === 'queued' ? 'pending' : next;
            if (next === 'processing') batch.processedAt = new Date();
        }
        await batch.save();

        await logAdminAudit({ req, action: 'payout_batch_state_changed', phone: req.user.phone || 'admin', description: `Batch ${batchId} -> ${batch.status}`, before, after: { status: batch.status }, metadata: { batchId } });
        return res.json({ success: true, batch });
    } catch (error) {
        console.error('Payout state transition error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// INCENTIVES + RATINGS + LEADERBOARD DEBUG
// ============================
router.get('/incentives/debug/:phone', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const phone = String(req.params.phone || '').trim();
        if (!isValidPhone(phone)) return res.status(400).json({ success: false, message: 'Invalid phone' });

        const [worker, gigs, claims] = await Promise.all([
            Worker.findOne({ phone }).lean(),
            GigHistory.find({ workerPhone: phone }).sort({ eventTime: -1 }).limit(800).lean(),
            IncentiveLedger.find({ phone }).sort({ createdAt: -1 }).lean(),
        ]);
        if (!worker) return res.status(404).json({ success: false, message: 'Worker not found' });

        const streak = computeCurrentConsecutiveDays(gigs);
        const totalHours = gigs.filter((g) => g.eventType === 'job_completed').reduce((s, g) => s + Number(g.hoursWorked || 0), 0);
        const cancellations = gigs.filter((g) => g.eventType === 'job_declined_offer' || g.eventType === 'job_cancelled_by_worker').length;
        const consecutiveDays = Number(worker.gigsData?.consecutiveDays || 0);

        const eligible = {
            '5days': consecutiveDays >= 5 && streak.cancellationsInStreak === 0,
            '10days': consecutiveDays >= 10 && streak.cancellationsInStreak === 0,
            '20days': consecutiveDays >= 20 && streak.cancellationsInStreak === 0,
        };

        return res.json({
            success: true,
            phone,
            snapshot: worker.gigsData || {},
            computed: {
                totalHours,
                cancellations,
                consecutiveDays,
                cancellationsInCurrentStreak: streak.cancellationsInStreak,
                eligibility: eligible,
                reasons: {
                    minHoursRule: '8+ hours/day required for day to count',
                    cancellationRule: 'Decline/cancel inside streak invalidates eligibility',
                },
            },
            claims,
        });
    } catch (error) {
        console.error('Incentive debug error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/ratings/center', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit } = parsePagination(req, 100, 500);
        const jobs = await Job.find({ status: 'completed' }).sort({ updatedAt: -1 }).limit(1500).lean();

        const workerRatings = [];
        const contractorRatings = [];
        let bulkRatedWorkers = 0;
        let bulkAcceptedWorkers = 0;

        for (const j of jobs) {
            if (j.rating?.stars) workerRatings.push({ jobId: j._id, stars: Number(j.rating.stars), workerPhone: j.acceptedBy || null, ratedAt: j.rating.ratedAt || j.updatedAt });
            if (j.contractorRating?.stars) contractorRatings.push({ jobId: j._id, stars: Number(j.contractorRating.stars), contractorPhone: j.contractorPhone || null, ratedAt: j.contractorRating.ratedAt || j.updatedAt });
            for (const w of (j.acceptedWorkers || [])) {
                bulkAcceptedWorkers += 1;
                if (w.rating?.stars) bulkRatedWorkers += 1;
            }
        }

        const avgWorkerRating = workerRatings.length ? workerRatings.reduce((s, r) => s + r.stars, 0) / workerRatings.length : 0;
        const avgContractorRating = contractorRatings.length ? contractorRatings.reduce((s, r) => s + r.stars, 0) / contractorRatings.length : 0;

        return res.json({
            success: true,
            summary: {
                workerRatingsCount: workerRatings.length,
                contractorRatingsCount: contractorRatings.length,
                avgWorkerRating: Number(avgWorkerRating.toFixed(2)),
                avgContractorRating: Number(avgContractorRating.toFixed(2)),
                bulkWorkerRatingCoverage: bulkAcceptedWorkers ? Number(((bulkRatedWorkers / bulkAcceptedWorkers) * 100).toFixed(2)) : 0,
            },
            workerRatings: workerRatings.slice(0, limit),
            contractorRatings: contractorRatings.slice(0, limit),
        });
    } catch (error) {
        console.error('Ratings center error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/leaderboard/debug', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const city = safeText(req.query.city || '', 120);
        const state = safeText(req.query.state || '', 120);
        const query = { role: 'contractor' };
        if (city) query.city = new RegExp(`^${city}$`, 'i');
        if (state) query.state = new RegExp(`^${state}$`, 'i');

        const contractors = await User.find(query).select('phone name avgRating createdAt city state').limit(300).lean();
        const rows = [];

        for (const c of contractors) {
            const jobs = await Job.find({ contractorPhone: c.phone }).select('status paymentStatus').lean();
            const totalJobsPosted = jobs.length;
            const completedJobs = jobs.filter((j) => j.status === 'completed').length;
            const completionRate = totalJobsPosted ? (completedJobs / totalJobsPosted) * 100 : 0;
            const daysActive = Math.max(1, Math.ceil((Date.now() - new Date(c.createdAt).getTime()) / 86400000));
            const breakdown = computeLeaderboardBreakdown({
                avgRating: Number(c.avgRating || 0),
                totalJobsPosted,
                daysActive,
                completionRate,
            });
            rows.push({
                contractorPhone: c.phone,
                contractorName: c.name,
                city: c.city || '',
                state: c.state || '',
                avgRating: Number(c.avgRating || 0),
                totalJobsPosted,
                completedJobs,
                completionRate: Number(completionRate.toFixed(2)),
                daysActive,
                ...breakdown,
            });
        }

        rows.sort((a, b) => b.finalScore - a.finalScore);
        rows.forEach((r, i) => { r.rank = i + 1; });
        return res.json({ success: true, count: rows.length, rows });
    } catch (error) {
        console.error('Leaderboard debug error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// ANALYTICS + EXPORTS + SCHEDULED REPORT DEFINITIONS
// ============================
router.get('/analytics/funnel', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
        const to = req.query.to ? new Date(req.query.to) : new Date();
        const city = safeText(req.query.city || '', 120);

        const query = { createdAt: { $gte: from, $lte: to } };
        const jobs = await Job.find(query).select('status paymentStatus isCancelled attendanceStatus contractorPhone createdAt').lean();
        const contractorPhones = Array.from(new Set(jobs.map((j) => j.contractorPhone).filter(Boolean)));
        const contractorUsers = await User.find({ phone: { $in: contractorPhones } }).select('phone city').lean();
        const cityMap = new Map(contractorUsers.map((u) => [u.phone, (u.city || '').toLowerCase()]));
        const normalizedCity = city.toLowerCase();
        const filteredJobs = city ? jobs.filter((j) => cityMap.get(j.contractorPhone) === normalizedCity) : jobs;

        const posted = filteredJobs.filter((j) => ['pending', 'posted', 'offered', 'accepted', 'in_progress', 'completed'].includes(j.status) && !j.isCancelled).length;
        const accepted = filteredJobs.filter((j) => ['accepted', 'in_progress', 'completed'].includes(j.status)).length;
        const present = filteredJobs.filter((j) => (j.attendanceStatus || '').toLowerCase() === 'present').length;
        const paid = filteredJobs.filter((j) => String(j.paymentStatus || '').toLowerCase() === 'paid').length;
        const cancelled = filteredJobs.filter((j) => j.status === 'cancelled' || j.isCancelled === true).length;

        return res.json({
            success: true,
            filters: { from, to, city: city || null },
            metrics: { posted, accepted, present, paid, cancelled, totalJobs: filteredJobs.length },
        });
    } catch (error) {
        console.error('Funnel analytics error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/analytics/funnel/export.csv', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
        const to = req.query.to ? new Date(req.query.to) : new Date();
        const jobs = await Job.find({ createdAt: { $gte: from, $lte: to } })
            .select('_id title contractorPhone status paymentStatus attendanceStatus amount createdAt')
            .sort({ createdAt: -1 })
            .lean();

        const rows = jobs.map((j) => ({
            jobId: String(j._id),
            title: j.title || '',
            contractorPhone: j.contractorPhone || '',
            status: j.status || '',
            paymentStatus: j.paymentStatus || '',
            attendanceStatus: j.attendanceStatus || '',
            amount: Number(j.amount || 0),
            createdAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
        }));

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=\"funnel_export_${Date.now()}.csv\"`);
        return res.status(200).send(buildCsv(rows));
    } catch (error) {
        console.error('Funnel CSV export error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/analytics/funnel/export.excel', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000);
        const to = req.query.to ? new Date(req.query.to) : new Date();
        const jobs = await Job.find({ createdAt: { $gte: from, $lte: to } })
            .select('_id title contractorPhone status paymentStatus attendanceStatus amount createdAt')
            .sort({ createdAt: -1 })
            .lean();

        const rows = jobs.map((j) => ({
            jobId: String(j._id),
            title: j.title || '',
            contractorPhone: j.contractorPhone || '',
            status: j.status || '',
            paymentStatus: j.paymentStatus || '',
            attendanceStatus: j.attendanceStatus || '',
            amount: Number(j.amount || 0),
            createdAt: j.createdAt ? new Date(j.createdAt).toISOString() : '',
        }));

        // Excel-compatible format via TSV content.
        const headers = rows.length ? Object.keys(rows[0]) : ['jobId', 'title', 'contractorPhone', 'status', 'paymentStatus', 'attendanceStatus', 'amount', 'createdAt'];
        const lines = [headers.join('\t'), ...rows.map((r) => headers.map((h) => String(r[h] ?? '')).join('\t'))];
        res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename=\"funnel_export_${Date.now()}.xls\"`);
        return res.status(200).send(lines.join('\n'));
    } catch (error) {
        console.error('Funnel Excel export error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.get('/analytics/report-schedules', authenticateToken, checkAdmin, async (_req, res) => {
    try {
        const rows = Array.from(reportSchedules.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return res.json({ success: true, count: rows.length, rows });
    } catch (error) {
        console.error('Report schedules list error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

router.post('/analytics/report-schedules', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const id = generateRef('rpt');
        const schedule = {
            id,
            name: safeText(req.body?.name || 'weekly-funnel-report', 120),
            cadence: safeText(req.body?.cadence || 'weekly', 30),
            recipients: Array.isArray(req.body?.recipients) ? req.body.recipients.map((e) => safeText(e, 120)).filter(Boolean) : [],
            format: safeText(req.body?.format || 'csv', 20),
            active: req.body?.active !== false,
            createdAt: new Date().toISOString(),
            createdBy: req.user.phone || 'admin',
        };
        reportSchedules.set(id, schedule);
        await logAdminAudit({ req, action: 'admin_action', phone: req.user.phone || 'admin', description: 'Report schedule created', before: null, after: schedule, metadata: { scheduleId: id } });
        return res.json({ success: true, schedule });
    } catch (error) {
        console.error('Create report schedule error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// WALLETS - Details by phone
// ============================
router.get('/wallets/:phone', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const phone = String(req.params.phone || '').trim();
        if (!/^\d{10}$/.test(phone)) {
            return res.status(400).json({ success: false, message: 'Valid 10-digit phone is required' });
        }
        const wallet = await Wallet.findOne({ phone }).lean();

        if (!wallet) {
            return res.status(404).json({ success: false, message: 'Wallet not found' });
        }

        const transactions = Array.isArray(wallet.transactions) ? wallet.transactions : [];
        transactions.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        res.json({
            success: true,
            wallet: {
                _id: wallet._id,
                phone: wallet.phone,
                balance: wallet.balance || 0,
                totalDeposited: wallet.totalDeposited || 0,
                totalWithdrawn: wallet.totalWithdrawn || 0,
                totalEarned: wallet.totalEarned || 0,
                createdAt: wallet.createdAt,
                updatedAt: wallet.updatedAt,
            },
            transactions,
        });
    } catch (error) {
        console.error('Wallet details error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// ACTIVITY LOGS
// ============================
router.get('/activity-logs', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const logs = await ActivityLog.find()
            .select('userId action details timestamp')
            .limit(500)
            .sort({ timestamp: -1 });

        res.json({
            success: true,
            count: logs.length,
            logs
        });
    } catch (error) {
        console.error('Activity logs error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// GIG HISTORY - Worker timeline + streak summary
// ============================
router.get('/gig-history', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { limit, page, skip } = parsePagination(req, 200, 1000);
        const phone = String(req.query.phone || '').trim();

        const query = {};
        if (phone) {
            query.workerPhone = { $regex: phone, $options: 'i' };
        }

        const total = await GigHistory.countDocuments(query);
        const events = await GigHistory.find(query)
            .sort({ eventTime: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        const workerStats = new Map();
        for (const event of events) {
            const workerPhone = String(event.workerPhone || '').trim();
            if (!workerPhone) continue;

            if (!workerStats.has(workerPhone)) {
                workerStats.set(workerPhone, {
                    workerPhone,
                    workerName: event.workerName || '-',
                    totalCompletedJobs: 0,
                    totalHoursWorked: 0,
                    totalCancellations: 0,
                    latestEventTime: event.eventTime || event.createdAt || null,
                    records: [],
                });
            }

            const bucket = workerStats.get(workerPhone);
            bucket.records.push(event);

            if (event.eventType === 'job_completed') {
                bucket.totalCompletedJobs += 1;
                bucket.totalHoursWorked += Number(event.hoursWorked || 0);
            }
            if (event.eventType === 'job_declined_offer' || event.eventType === 'job_cancelled_by_worker') {
                bucket.totalCancellations += 1;
            }
        }

        const workerSummaries = Array.from(workerStats.values()).map((w) => {
            const streak = computeCurrentConsecutiveDays(w.records);
            return {
                workerPhone: w.workerPhone,
                workerName: w.workerName,
                totalCompletedJobs: w.totalCompletedJobs,
                totalHoursWorked: Number(w.totalHoursWorked.toFixed(2)),
                totalCancellations: w.totalCancellations,
                consecutiveDays: streak.consecutiveDays,
                cancellationsInStreak: streak.cancellationsInStreak,
                latestEventTime: w.latestEventTime,
            };
        }).sort((a, b) => (b.consecutiveDays || 0) - (a.consecutiveDays || 0));

        const summaryMap = new Map(workerSummaries.map((s) => [s.workerPhone, s]));
        const rows = events.map((event) => {
            const summary = summaryMap.get(String(event.workerPhone || '').trim()) || {};
            return {
                _id: event._id,
                workerPhone: event.workerPhone || '-',
                workerName: event.workerName || '-',
                jobId: event.jobId || null,
                jobTitle: event.jobTitle || '-',
                contractorPhone: event.contractorPhone || '-',
                contractorName: event.contractorName || '-',
                eventType: event.eventType || '-',
                status: event.status || '-',
                paymentStatus: event.paymentStatus || '-',
                hoursWorked: Number(event.hoursWorked || 0),
                timeSpentMinutes: Number(event.timeSpentMinutes || 0),
                eventTime: event.eventTime || event.createdAt || null,
                workDate: event.workDate || null,
                totalCompletedJobs: summary.totalCompletedJobs || 0,
                totalHoursWorked: summary.totalHoursWorked || 0,
                consecutiveDays: summary.consecutiveDays || 0,
                cancellationsInStreak: summary.cancellationsInStreak || 0,
                totalCancellations: summary.totalCancellations || 0,
            };
        });

        return res.json({
            success: true,
            count: rows.length,
            total,
            page,
            limit,
            rows,
            workers: workerSummaries,
        });
    } catch (error) {
        console.error('Gig history error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// USER PROFILE - Get single user
// ============================
router.get('/users/:phone', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const user = await User.findOne({ phone: req.params.phone })
            .select('-password');

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        res.json({ success: true, user });
    } catch (error) {
        console.error('User fetch error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// RESTRICT/UNRESTRICT USER
// ============================
router.post('/users/:phone/restrict', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { isRestricted } = req.body;
        const user = await User.findOneAndUpdate(
            { phone: req.params.phone },
            { isRestricted: isRestricted },
            { new: true }
        );

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        // Log activity
        await ActivityLog.create({
            userId: req.user._id,
            action: isRestricted ? 'USER_RESTRICTED' : 'USER_UNRESTRICTED',
            details: `User ${user.phone} ${isRestricted ? 'restricted' : 'unrestricted'}`,
            timestamp: new Date()
        });

        res.json({ success: true, message: `User ${isRestricted ? 'restricted' : 'unrestricted'}` });
    } catch (error) {
        console.error('Restrict error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// VERIFY DOCUMENT - Approve/Reject verification
// ============================
router.post('/verify-document', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { verificationId, documentId, status, rejectionReason } = req.body;

        // Validation
        if (!verificationId || !status) {
            return res.status(400).json({ success: false, message: 'verificationId and status are required' });
        }

        if (!['approved', 'rejected'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Status must be approved or rejected' });
        }

        // Find verification document
        const verification = await VerificationDocument.findById(verificationId);
        if (!verification) {
            return res.status(404).json({ success: false, message: 'Verification not found' });
        }

        // If documentId is provided, update specific document within array
        if (documentId) {
            const docIndex = verification.documents.findIndex(d => d._id.toString() === documentId);
            if (docIndex === -1) {
                return res.status(404).json({ success: false, message: 'Document not found' });
            }

            verification.documents[docIndex].verificationStatus = status;
            verification.documents[docIndex].verifiedAt = new Date();
            verification.documents[docIndex].verifiedBy = req.user.id || req.user._id || 'admin';
            
            if (status === 'rejected') {
                verification.documents[docIndex].rejectionReason = rejectionReason || 'Rejected by admin';
            }
        } else {
            // Update all documents in the verification
            verification.documents.forEach(doc => {
                doc.verificationStatus = status;
                doc.verifiedAt = new Date();
                doc.verifiedBy = req.user.id || req.user._id || 'admin';
                
                if (status === 'rejected') {
                    doc.rejectionReason = rejectionReason || 'Rejected by admin';
                }
            });
        }

        // Update overall verification status
        const allApproved = verification.documents.every(d => d.verificationStatus === 'approved');
        const anyRejected = verification.documents.some(d => d.verificationStatus === 'rejected');
        
        if (allApproved) {
            verification.overallVerificationStatus = 'verified';
        } else if (anyRejected) {
            verification.overallVerificationStatus = 'rejected';
        }

        await verification.save();

        // Update user's verification status if all approved
        if (allApproved) {
            await User.findOneAndUpdate(
                { phone: verification.phone },
                { isVerified: true }
            );
        }

        // Log activity
        await ActivityLog.create({
            userId: req.user.id || req.user._id || 'admin',
            phone: verification.phone,
            action: status === 'approved' ? 'document_verified' : 'document_rejected',
            description: `Document for ${verification.phone} ${status}${rejectionReason ? ': ' + rejectionReason : ''}`,
            timestamp: new Date()
        });

        res.json({ 
            success: true, 
            message: `Document ${status}`,
            verification 
        });
    } catch (error) {
        console.error('Verify document error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// CITY LEADERBOARD - Get city leaderboard data
// ============================
router.get('/leaderboard', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { city } = req.query;
        
        // Get all cities with their leaderboards
        const allLeaderboards = await CityLeaderboard.find()
            .sort({ 'leaderboard.rank': 1 });

        if (!allLeaderboards || allLeaderboards.length === 0) {
            return res.json({ 
                success: true, 
                leaderboard: [],
                cities: []
            });
        }

        // Extract unique cities
        const citiesMap = allLeaderboards.map(lb => ({
            city: lb.city,
            state: lb.state
        }));

        let selectedLeaderboard = [];
        if (city) {
            const selected = allLeaderboards.find(lb => lb.city.toLowerCase() === city.toLowerCase());
            if (selected) {
                selectedLeaderboard = selected.leaderboard || [];
            }
        } else {
            // Return all contractors from all cities combined
            allLeaderboards.forEach(lb => {
                const leaderboardWithCity = (lb.leaderboard || []).map(entry => ({
                    ...entry.toObject ? entry.toObject() : entry,
                    city: lb.city,
                    state: lb.state
                }));
                selectedLeaderboard = selectedLeaderboard.concat(leaderboardWithCity);
            });
        }

        res.json({
            success: true,
            leaderboard: selectedLeaderboard,
            cities: citiesMap,
            selectedCity: city || null
        });
    } catch (error) {
        console.error('Leaderboard fetch error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// SUPPORT TICKETS - Get all support tickets
// ============================
router.get('/support-tickets', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { status, priority } = req.query;
        const { limit, page, skip } = parsePagination(req);
        
        let query = {};
        if (status) {
            const statusList = String(status)
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            if (statusList.length > 1) {
                query.status = { $in: statusList };
            } else if (statusList.length === 1) {
                query.status = statusList[0];
            }
        }
        if (priority) query.priority = priority;

        const tickets = await SupportTicket.find(query)
            .limit(limit)
            .skip(skip)
            .sort({ createdAt: -1 });
        const total = await SupportTicket.countDocuments(query);

        res.json({
            success: true,
            count: tickets.length,
            total,
            page,
            limit,
            tickets
        });
    } catch (error) {
        console.error('Support tickets fetch error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// SUPPORT TICKET - Get single ticket details
// ============================
router.get('/support-tickets/:ticketId', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const ticket = await SupportTicket.findOne({ ticketId: req.params.ticketId });
        
        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        res.json({ success: true, ticket });
    } catch (error) {
        console.error('Support ticket fetch error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// RESOLVE SUPPORT TICKET
// ============================
router.post('/support-tickets/:ticketId/resolve', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { resolution, resolutionNotes, status } = req.body;
        
        const ticket = await SupportTicket.findOneAndUpdate(
            { ticketId: req.params.ticketId },
            {
                status: status || 'resolved',
                resolution,
                resolutionNotes,
                resolvedAt: new Date(),
                assignedToAdmin: req.user.phone || req.user._id
            },
            { new: true }
        );

        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        // Log activity
        await ActivityLog.create({
            userId: req.user.id || req.user._id || 'admin',
            phone: ticket.reporterPhone,
            action: 'ticket_resolved',
            description: `Support ticket ${ticket.ticketId} resolved: ${resolution}`,
            timestamp: new Date()
        });

        res.json({ 
            success: true, 
            message: 'Ticket resolved',
            ticket 
        });
    } catch (error) {
        console.error('Resolve ticket error:', error);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// SUPPORT TICKET - Update status/notes (admin)
// ============================
router.patch('/support-tickets/:ticketId/status', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { status, resolution, resolutionNotes, priority } = req.body || {};
        const allowedStatus = ['open', 'under_review', 'waiting_user_response', 'resolved', 'closed'];

        if (!status || !allowedStatus.includes(status)) {
            return res.status(400).json({ success: false, message: 'Valid status is required' });
        }

        const update = {
            status,
            updatedAt: new Date(),
            assignedToAdmin: req.user.phone || req.user._id
        };

        if (priority) update.priority = priority;
        if (resolution !== undefined) update.resolution = resolution;
        if (resolutionNotes !== undefined) update.resolutionNotes = resolutionNotes;
        if (status === 'resolved' || status === 'closed') update.resolvedAt = new Date();

        const ticket = await SupportTicket.findOneAndUpdate(
            { ticketId: req.params.ticketId },
            update,
            { new: true }
        );

        if (!ticket) {
            return res.status(404).json({ success: false, message: 'Ticket not found' });
        }

        await ActivityLog.create({
            userId: req.user.id || req.user._id || 'admin',
            phone: ticket.reporterPhone,
            action: 'ticket_status_updated',
            description: `Ticket ${ticket.ticketId} moved to ${status}`,
            metadata: { status, priority, adminPhone: req.user.phone },
            timestamp: new Date()
        });

        return res.json({ success: true, message: 'Ticket status updated', ticket });
    } catch (error) {
        console.error('Support ticket status update error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// LOOKUP BY PHONE - Worker/Contractor/Jobs/Wallet/Verification/Tickets
// ============================
router.get('/lookup/:phone', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const phone = String(req.params.phone || '').trim();
        if (!isValidPhone(phone)) {
            return res.status(400).json({ success: false, message: 'Valid 10-digit phone is required' });
        }

        const [
            user,
            worker,
            wallet,
            bankAccount,
            verification,
            contractorStats,
            jobsAsContractor,
            jobsAsWorkerRaw,
            supportTickets,
            activityLogs,
            cancellationLogs
        ] = await Promise.all([
            User.findOne({ phone }).select('-password -refreshTokens -otpCode -otpExpiry').lean(),
            Worker.findOne({ phone }).lean(),
            Wallet.findOne({ phone }).lean(),
            BankAccount.findOne({ phone }).lean(),
            VerificationDocument.findOne({ phone }).lean(),
            ContractorStats.find({ phone }).sort({ date: -1 }).limit(60).lean(),
            Job.find({ contractorPhone: phone }).sort({ createdAt: -1 }).limit(300).lean(),
            Job.find({
                $or: [
                    { acceptedBy: phone },
                    { 'acceptedWorkers.phone': phone }
                ]
            }).sort({ createdAt: -1 }).limit(300).lean(),
            SupportTicket.find({ $or: [{ reporterPhone: phone }, { reportedPhone: phone }] }).sort({ createdAt: -1 }).limit(100).lean(),
            ActivityLog.find({ phone }).sort({ timestamp: -1 }).limit(100).lean(),
            CancellationLog.find({ $or: [{ contractorPhone: phone }, { workerPhone: phone }] }).sort({ cancelledAt: -1 }).limit(100).lean()
        ]);

        const dedupedWorkerJobsMap = new Map();
        for (const j of jobsAsWorkerRaw) dedupedWorkerJobsMap.set(String(j._id), j);
        const jobsAsWorker = Array.from(dedupedWorkerJobsMap.values());

        const workerGigSummary = buildWorkerGigSummary(jobsAsWorker, phone);

        const contractorSummary = {
            totalJobsPosted: jobsAsContractor.length,
            totalPaidJobs: jobsAsContractor.filter((j) => String(j.paymentStatus || '').toLowerCase() === 'paid').length,
            totalCancelledJobs: jobsAsContractor.filter((j) => j.status === 'cancelled' || j.isCancelled === true).length,
            totalSpending: jobsAsContractor
                .filter((j) => String(j.paymentStatus || '').toLowerCase() === 'paid')
                .reduce((sum, j) => sum + (Number(j.amount) || 0), 0)
        };

        return res.json({
            success: true,
            phone,
            data: {
                user,
                worker,
                wallet,
                bankAccount,
                verification,
                contractorStats,
                supportTickets,
                activityLogs,
                cancellationLogs,
                jobs: {
                    asContractor: jobsAsContractor,
                    asWorker: jobsAsWorker
                },
                summaries: {
                    worker: workerGigSummary,
                    contractor: contractorSummary
                }
            }
        });
    } catch (error) {
        console.error('Admin lookup error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// PREMIUM SUBSCRIPTIONS - History
// ============================
router.get('/premium/subscriptions', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const { phone, status } = req.query;
        const { limit, page, skip } = parsePagination(req, 50, 1000);
        const query = {};

        if (phone) query.userPhone = String(phone).trim();
        if (status) query.status = String(status).trim();
        const total = await PremiumSubscription.countDocuments(query);

        const subscriptions = await PremiumSubscription.find(query)
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .lean();

        return res.json({
            success: true,
            count: subscriptions.length,
            total,
            page,
            limit,
            subscriptions
        });
    } catch (error) {
        console.error('Premium subscriptions fetch error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// PREMIUM RECONCILIATION - Latest run + mismatches
// ============================
router.get('/premium/reconciliation/latest', authenticateToken, checkAdmin, async (req, res) => {
    try {
        const latestRun = await ReconciliationRun.findOne({ provider: 'internal_premium' })
            .sort({ startedAt: -1 })
            .lean();

        if (!latestRun) {
            return res.json({
                success: true,
                latestRun: null,
                mismatches: [],
                mismatchCount: 0
            });
        }

        const mismatches = (latestRun.mismatches || []).filter((m) => m.entityType === 'subscription');

        return res.json({
            success: true,
            latestRun: {
                _id: latestRun._id,
                runDate: latestRun.runDate,
                startedAt: latestRun.startedAt,
                completedAt: latestRun.completedAt,
                status: latestRun.status,
                summary: latestRun.summary || {},
            },
            mismatches,
            mismatchCount: mismatches.length
        });
    } catch (error) {
        console.error('Premium reconciliation fetch error:', error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// ============================
// ✅ POST /admin/districts/import-geojson - Import district boundaries from GeoJSON
// ============================
router.post('/districts/import-geojson', authenticateToken, async (req, res) => {
  try {
    const { features } = req.body;

    if (!Array.isArray(features)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid GeoJSON format. Expected features array.',
      });
    }

    const importedDistricts = [];
    const errors = []; // ✅ FIXED: Initialize errors array

        // Helper: Remove duplicate vertices from polygon rings
        const removeDuplicateVertices = (coords) => {
            const unique = [];
            const seen = new Set();

            for (const [lng, lat] of coords) {
                const key = `${lng}-${lat}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    unique.push([lng, lat]);
                }
            }

            // Ensure polygon is closed
            if (unique.length > 0) {
                const first = unique[0];
                const last = unique[unique.length - 1];

                if (first[0] !== last[0] || first[1] !== last[1]) {
                    unique.push(first);
                }
            }

            return unique;
        };

        // Helper: Calculate centroid from polygon/multipolygon coordinates
        const calculateCentroid = (geometry) => {
            let allCoords = [];

            if (geometry.type === 'Polygon') {
                allCoords = geometry.coordinates[0]; // Outer ring
            } else if (geometry.type === 'MultiPolygon') {
                // Use first polygon's outer ring
                allCoords = geometry.coordinates[0][0];
            } else {
                return null;
            }

            if (allCoords.length === 0) return null;

            const [lonSum, latSum] = allCoords.reduce(
                ([lon, lat], [clng, clat]) => [lon + clng, lat + clat],
                [0, 0]
            );

            return [lonSum / allCoords.length, latSum / allCoords.length];
        };

        // Helper: Calculate bounding box
        const calculateBbox = (geometry) => {
            let allCoords = [];

            if (geometry.type === 'Polygon') {
                allCoords = geometry.coordinates.flat();
            } else if (geometry.type === 'MultiPolygon') {
                allCoords = geometry.coordinates.flat(2);
            } else {
                return null;
            }

            const lngs = allCoords.map(([lng]) => lng);
            const lats = allCoords.map(([, lat]) => lat);

            return {
                minLon: Math.min(...lngs),
                maxLon: Math.max(...lngs),
                minLat: Math.min(...lats),
                maxLat: Math.max(...lats),
            };
        };

        // Process each feature
        for (const feature of features) {
            try {
                const { properties, geometry } = feature;

                if (!geometry || !properties) {
                    errors.push(`Skipped feature: Missing geometry or properties`);
                    continue;
                }

                // For Indian district GeoJSON: DISTRICT="Adilabad", ST_NM="Andhra Pradesh"
                const districtName = properties.DISTRICT || properties.name;
                const stateName = properties.ST_NM || properties.state;

                if (!districtName || !stateName) {
                    errors.push(`Skipped feature: Missing DISTRICT or ST_NM property`);
                    continue;
                }

                // Validate geometry type
                if (!['Polygon', 'MultiPolygon'].includes(geometry.type)) {
                    errors.push(`Skipped ${districtName}: Unsupported geometry type ${geometry.type}`);
                    continue;
                }

                // Clean geometry: Remove duplicate vertices
                if (geometry.type === 'Polygon') {
                    geometry.coordinates = geometry.coordinates.map(ring =>
                        removeDuplicateVertices(ring)
                    );
                }

                if (geometry.type === 'MultiPolygon') {
                    geometry.coordinates = geometry.coordinates.map(polygon =>
                        polygon.map(ring =>
                            removeDuplicateVertices(ring)
                        )
                    );
                }

                const centroid = calculateCentroid(geometry);
                const bbox = calculateBbox(geometry);

                if (!centroid || !bbox) {
                    errors.push(`Skipped ${districtName}: Could not calculate centroid/bbox`);
                    continue;
                }

                // Create or update district
                const districtSlug = `${districtName}-${stateName}`.toLowerCase().replace(/\s+/g, '-');

                const districtData = {
                    name: districtName,
                    slug: districtSlug,
                    state: stateName,
                    geometry: geometry,
                    centroid: {
                        type: "Point",
                        coordinates: centroid
                    },
                    bbox: bbox,
                    properties: {
                        stateCensuscode: properties.ST_CEN_CD,
                        districtCensuscode: properties.DT_CEN_CD,
                        censuscode: properties.censuscode,
                    },
                };

                const district = await District.findOneAndUpdate(
                    { slug: districtSlug },
                    districtData,
                    { 
                        upsert: true, 
                        new: true,
                        runValidators: true
                    }
                );

                importedDistricts.push({
                    name: district.name,
                    state: district.state,
                    slug: district.slug,
                    centroid: district.centroid,
                });

                console.log(`✅ Imported district: ${district.name}, ${district.state}`);
            } catch (featureError) {
                errors.push(`Error processing feature: ${featureError.message}`);
                console.error('Feature import error:', featureError);
            }
        }

        res.json({
            success: true,
            message: `Imported ${importedDistricts.length} districts`,
            importedDistricts: importedDistricts,
            errors: errors,
            count: importedDistricts.length,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('❌ GeoJSON import error:', error);
        res.status(500).json({
            success: false,
            message: 'Error importing GeoJSON',
            error: error.message,
        });
    }
});

// ✅ DEBUG: Check district coverage for a given coordinate
// GET /admin/debug/check-point?lat=19.89&lon=75.36
router.get('/debug/check-point', async (req, res) => {
    try {
        const { lat, lon } = req.query;

        if (!lat || !lon) {
            return res.status(400).json({
                success: false,
                message: 'Latitude and longitude required',
            });
        }

        const latitude = parseFloat(lat);
        const longitude = parseFloat(lon);

        if (isNaN(latitude) || isNaN(longitude)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid latitude or longitude',
            });
        }

        const point = {
            type: 'Point',
            coordinates: [longitude, latitude],
        };

        // Check 1: Exact polygon match
        const exactDistrict = await District.findOne({
            geometry: {
                $geoIntersects: {
                    $geometry: point,
                },
            },
        }).lean();

        // Check 2: Nearest centroid
        const nearestDistrict = await District.findOne(
            {
                centroid: {
                    $nearSphere: {
                        $geometry: point,
                        $maxDistance: 100000, // 100km
                    },
                },
            },
            null,
            { lean: true }
        );

        // Check 3: Count total districts
        const totalDistricts = await District.countDocuments();

        // Check 4: Get some sample districts
        const sampleDistricts = await District.find({}, { name: 1, state: 1, _id: 0 }).limit(5).lean();

        return res.json({
            success: true,
            point: { latitude, longitude },
            exactMatch: exactDistrict ? {
                name: exactDistrict.name,
                state: exactDistrict.state,
            } : null,
            nearestMatch: nearestDistrict ? {
                name: nearestDistrict.name,
                state: nearestDistrict.state,
                distance: 'within 100km',
            } : null,
            totalDistrictsInDB: totalDistricts,
            sampleDistricts: sampleDistricts,
        });
    } catch (err) {
        console.error('Debug check error:', err);
        res.status(500).json({
            success: false,
            message: 'Error checking point',
            error: err.message,
        });
    }
});

// ✅ DEBUG: Check geospatial queries for specific coordinates
router.get('/debug/geospatial/:lat/:lon', async (req, res) => {
    try {
        const lat = parseFloat(req.params.lat);
        const lon = parseFloat(req.params.lon);

        if (isNaN(lat) || isNaN(lon)) {
            return res.status(400).json({ success: false, message: 'Invalid latitude or longitude' });
        }

        console.log(`🔍 [GeospatialDebug] Checking point: [${lon}, ${lat}]`);

        const point = { type: 'Point', coordinates: [lon, lat] };

        // Check 1: Exact polygon match
        const exactMatch = await District.findOne({
            geometry: { $geoIntersects: { $geometry: point } }
        }).lean();

        // Check 2: Nearest centroid (50km)
        const nearestCentroid = await District.findOne(
            {
                centroid: {
                    $nearSphere: {
                        $geometry: point,
                        $maxDistance: 50000
                    }
                }
            },
            null,
            { lean: true }
        );

        // Check 3: All districts within 100km
        const withinHundredKm = await District.find(
            {
                centroid: {
                    $nearSphere: {
                        $geometry: point,
                        $maxDistance: 100000
                    }
                }
            },
            { name: 1, state: 1, centroid: 1 },
            { limit: 10, lean: true }
        );

        // Check 4: Total districts in DB and geospatial indexes
        const totalDistricts = await District.countDocuments();
        const indexInfo = await District.collection.getIndexes();
        const hasGeoIndex = Object.values(indexInfo).some(idx => 
            idx.key && (idx.key.geometry === '2dsphere' || idx.key.centroid === '2dsphere')
        );

        res.json({
            coordinates: { latitude: lat, longitude: lon },
            geospatialIndexExists: hasGeoIndex,
            totalDistrictsInDB: totalDistricts,
            exactPolygonMatch: exactMatch ? {
                name: exactMatch.name,
                state: exactMatch.state,
                matchType: 'EXACT (inside polygon)'
            } : null,
            nearestCentroidWithin50km: nearestCentroid ? {
                name: nearestCentroid.name,
                state: nearestCentroid.state,
                distance: 'unknown',
                matchType: 'FALLBACK (nearest centroid)'
            } : null,
            districtsWith100kmRadius: withinHundredKm.map(d => ({
                name: d.name,
                state: d.state
            })),
            indexes: Object.keys(indexInfo).map(name => ({
                name,
                fields: indexInfo[name].key
            }))
        });
    } catch (err) {
        console.error('❌ Geospatial debug error:', err);
        res.status(500).json({
            success: false,
            message: 'Error checking geospatial data',
            error: err.message
        });
    }
});

module.exports = router;

