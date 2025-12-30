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
const CityLeaderboard = require('../models/CityLeaderboard');
const SupportTicket = require('../models/SupportTicket');

// Middleware to check admin role
const checkAdmin = (req, res, next) => {
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    next();
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
                userId: 'system',
                action: 'ADMIN_CREATED',
                details: `New admin user created: ${name} (${phone})`,
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
        const users = await User.find({ role: 'contractor' })
            .select('phone name email role createdAt')
            .limit(100)
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: users.length,
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
        // Get workers and join with User data
        const workers = await Worker.find().limit(100);
        
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
        const jobs = await Job.find()
            .limit(100)
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: jobs.length,
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
        const bankAccounts = await BankAccount.find().limit(100);

        res.json({
            success: true,
            count: bankAccounts.length,
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
        const verifications = await VerificationDocument.find()
            .limit(100)
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
        
        let query = {};
        if (status) query.status = status;
        if (priority) query.priority = priority;

        const tickets = await SupportTicket.find(query)
            .limit(100)
            .sort({ createdAt: -1 });

        res.json({
            success: true,
            count: tickets.length,
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

module.exports = router;
