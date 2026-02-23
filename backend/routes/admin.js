const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
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

const buildWorkerGigSummary = (jobs, phone) => {
    const workerJobs = jobs.filter((j) => {
        const inBulk = Array.isArray(j.acceptedWorkers) && j.acceptedWorkers.some((w) => w.phone === phone);
        return j.acceptedBy === phone || inBulk;
    });

    const completed = workerJobs.filter((j) => j.paymentStatus === 'Paid').length;
    const cancelled = workerJobs.filter((j) => j.status === 'cancelled' || j.isCancelled === true).length;
    const pending = workerJobs.filter((j) => j.paymentStatus !== 'Paid' && j.status !== 'cancelled').length;
    const earnings = workerJobs
        .filter((j) => j.paymentStatus === 'Paid')
        .reduce((sum, j) => sum + (Number(j.amount) || 0), 0);

    return {
        totalJobs: workerJobs.length,
        completedJobs: completed,
        cancelledJobs: cancelled,
        pendingJobs: pending,
        totalEarnings: earnings
    };
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
        const completedJobs = await Job.countDocuments({ status: 'completed', paymentStatus: 'Paid' });
        
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
        const availableWorkers = await Worker.countDocuments({ isAvailable: true });
        const unavailableWorkers = await Worker.countDocuments({ isAvailable: false });
        
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
            { $group: { _id: null, avg: { $avg: '$avgRating' } } }
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
            { $match: { paymentStatus: 'Paid' } },
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
                const user = await User.findOne({ phone: worker.phone }).select('name role isVerified city');
                return {
                    _id: worker._id,
                    phone: worker.phone,
                    name: user?.name || '-',
                    workerType: user?.role || 'worker',
                    avgRating: worker.rating || 0,
                    jobsCompleted: worker.jobsCompleted || 0,
                    skills: worker.skills || [],
                    isVerified: user?.isVerified || false,
                    isAvailable: worker.isAvailable,
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
            totalPaidJobs: jobsAsContractor.filter((j) => j.paymentStatus === 'Paid').length,
            totalCancelledJobs: jobsAsContractor.filter((j) => j.status === 'cancelled' || j.isCancelled === true).length,
            totalSpending: jobsAsContractor
                .filter((j) => j.paymentStatus === 'Paid')
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

