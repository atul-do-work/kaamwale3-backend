const express = require("express");
const { authenticateToken } = require("../utils/auth");
const User = require("../models/User");
const WorkerModel = require("../models/Worker");
const Job = require("../models/Jobs");
const Wallet = require("../models/Wallet");
const NotificationHistory = require("../models/NotificationHistory");
const District = require("../models/City");
const GigHistory = require("../models/GigHistory");
const IncentiveLedger = require("../models/IncentiveLedger");
const CashDeposit = require("../models/CashDeposit");
const {
  calculateEligibility,
  MILESTONE_IDS,
  buildClaimStatusByMilestone,
} = require("../services/incentiveEligibilityService");
const jobsLifecycleService = require("../services/jobsLifecycleService");

function createWorkersRouter({
  io,
  connectedWorkers,
  checkJobMatchesForWorker,
  sendNotificationToUserPhone,
}) {
  const router = express.Router();
  const setNoStore = (req, res) => {
    if (req?.headers) {
      delete req.headers["if-none-match"];
      delete req.headers["if-modified-since"];
    }
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
    res.set("Surrogate-Control", "no-store");
  };

  const isValidCoordinate = (value, min, max) =>
    typeof value === "number" && !Number.isNaN(value) && value >= min && value <= max;

  const isValidPoint = (lat, lon) =>
    isValidCoordinate(lat, -90, 90) && isValidCoordinate(lon, -180, 180);

  router.get("/workers/nearby", authenticateToken, async (req, res) => {
    try {
      let lat = req.query.lat ? parseFloat(req.query.lat) : null;
      let lon = req.query.lon ? parseFloat(req.query.lon) : null;
      const maxMeters = parseInt(req.query.max || "70000", 10);
      const skill = req.query.skill || null;
      const wageMin = req.query.wageMin ? parseInt(req.query.wageMin, 10) : null;
      const wageMax = req.query.wageMax ? parseInt(req.query.wageMax, 10) : null;

      if (lat === null || lon === null || isNaN(lat) || isNaN(lon)) {
        lat = null;
        lon = null;
      }

      if ((!lat || !lon) && req.user && req.user.phone) {
        const u = await User.findOne({ phone: req.user.phone });
        if (u && u.location && u.location.coordinates) {
          lon = u.location.coordinates[0];
          lat = u.location.coordinates[1];
        }
      }

      if (!lat || !lon) {
        return res.status(400).json({ success: false, message: "Latitude and longitude required" });
      }

      const query = {
        location: {
          $near: {
            $geometry: { type: "Point", coordinates: [lon, lat] },
            $maxDistance: maxMeters || 70000,
          },
        },
      };

      if (skill && skill !== "All Skills") {
        query.$or = [{ mainSkill: skill }, { skills: skill }];
      }

      const workers = await WorkerModel.find(query).limit(100).lean();
      const workerPhones = workers.map((w) => w.phone);
      const userProfiles = await User.find({ phone: { $in: workerPhones } }).lean();
      const userMap = {};
      userProfiles.forEach((u) => {
        userMap[u.phone] = u;
      });

      const nearby = workers
        .map((worker) => {
          const userProfile = userMap[worker.phone] || {};
          if (userProfile.role && String(userProfile.role).toLowerCase() !== "worker") {
            return null;
          }
          const avgRating = worker.performanceMetrics?.averageRating || worker.rating || 0;
          const totalReviews = worker.performanceMetrics?.totalReviews || 0;
          return {
            phone: worker.phone,
            name: userProfile.name,
            skills: worker.skills || [],
            mainSkill: userProfile.mainSkill || worker.mainSkill || "Not specified",
            expectedWage: userProfile.expectedWage || "Negotiable",
            rating: avgRating,
            totalReviews,
            profilePhoto: userProfile.profilePhoto || worker.profilePhoto,
            distanceKm: worker.distanceKm || 0,
            distanceMeters: worker.distanceMeters || 0,
            location: worker.location,
            isAvailable: userProfile.isAvailable ?? worker.isAvailable ?? false,
            createdAt: userProfile.createdAt,
          };
        })
        .filter((worker) => worker !== null)
        .filter((worker) => {
          if (wageMin !== null || wageMax !== null) {
            const wageMatch = worker.expectedWage.match(/(\d+)/);
            const workerWage = wageMatch ? parseInt(wageMatch[0], 10) : 0;
            if (wageMin !== null && workerWage < wageMin) return false;
            if (wageMax !== null && workerWage >= wageMax) return false;
          }
          return true;
        })
        .sort((a, b) => a.distanceMeters - b.distanceMeters);

      return res.json({
        success: true,
        count: nearby.length,
        maxDistanceMeters: maxMeters || 70000,
        filters: { skill: skill || "All Skills", wageMin: wageMin || null, wageMax: wageMax || null },
        workers: nearby,
      });
    } catch (err) {
      console.error("workers/nearby error", err);
      return res.status(500).json({ success: false, message: "Failed to fetch nearby workers", error: err.message });
    }
  });

  router.post("/workers/request", authenticateToken, async (req, res) => {
    try {
      const { workerPhone, message } = req.body || {};
      if (!workerPhone) return res.status(400).json({ success: false, message: "workerPhone required" });

      const worker = await WorkerModel.findOne({ phone: workerPhone });
      if (!worker) return res.status(404).json({ success: false, message: "Worker not found" });

      if (worker.socketId) {
        try {
          io.to(worker.socketId).emit("workerRequested", { from: req.user.phone, message: message || "" });
        } catch (e) {
          console.warn("Could not emit workerRequested to socket:", e.message);
        }
      }

      try {
        await NotificationHistory.create({
          recipientPhone: workerPhone,
          phone: workerPhone,
          type: "worker_request",
          title: "Request from contractor",
          body: `You have a new request from ${req.user.phone}`,
          metadata: { from: req.user.phone, message: message || "" },
        });
      } catch (e) {
        console.warn("Could not save notification history:", e.message);
      }

      try {
        const payload = {
          type: "worker_request",
          title: "Request from contractor",
          body: `You have a new request from ${req.user.phone}`,
          metadata: { from: req.user.phone, message: message || "" },
        };
        await sendNotificationToUserPhone(workerPhone, payload);
      } catch (e) {
        console.error("Error sending push for worker request:", e && e.message);
      }

      return res.json({ success: true, message: "Request sent" });
    } catch (err) {
      console.error("workers/request error", err);
      return res.status(500).json({ success: false, message: "Failed to request worker" });
    }
  });

  router.post("/workers/request-job", authenticateToken, async (req, res) => {
    try {
      const { workerPhone, date, startTime, endTime, location, message, siteImageUri, requiredWorkers } = req.body || {};
      const requiredWorkersCount = Number.parseInt(requiredWorkers, 10) || 1;

      if (!workerPhone || !date || !startTime || !endTime || !location) {
        return res.status(400).json({
          success: false,
          message: "workerPhone, date, startTime, endTime, and location are required"
        });
      }

      const worker = await WorkerModel.findOne({ phone: workerPhone });
      if (!worker) {
        return res.status(404).json({ success: false, message: "Worker not found" });
      }

      const contractor = await User.findOne({ phone: req.user.phone });
      if (!contractor) {
        return res.status(404).json({ success: false, message: "Contractor not found" });
      }

      // Create job request notification
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const payload = {
        type: "job_request",
        title: "New Job Request",
        body: `Job request from ${contractor.name || req.user.phone} for ${date}`,
        metadata: {
          requestId,
          contractorPhone: req.user.phone,
          contractorName: contractor.name,
          date,
          startTime,
          endTime,
          location,
          requiredWorkers: requiredWorkersCount,
          paymentFrequency: paymentFrequency || 'daily',
          message: message || "",
          siteImageUri: siteImageUri || undefined,
          timestamp: new Date().toISOString(),
        },
      };

      // Send real-time notification if worker is online
      if (worker.socketId) {
        try {
          io.to(worker.socketId).emit("jobRequest", {
            requestId,
            contractorPhone: req.user.phone,
            contractorName: contractor.name,
            date,
            startTime,
            endTime,
            location,
            requiredWorkers: requiredWorkersCount,
            paymentFrequency: paymentFrequency || 'daily',
            message: message || "",
            siteImageUri: siteImageUri || undefined,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          console.warn("Could not emit jobRequest to socket:", e.message);
        }
      }

      // Send push notification
      try {
        await sendNotificationToUserPhone(workerPhone, payload);
      } catch (e) {
        console.error("Error sending push notification for job request:", e && e.message);
      }

      return res.json({
        success: true,
        message: "Job request sent successfully",
        requestId
      });
    } catch (err) {
      console.error("workers/request-job error", err);
      return res.status(500).json({ success: false, message: "Failed to send job request" });
    }
  });

  router.get("/workers/job-requests", authenticateToken, async (req, res) => {
    try {
      const contractorPhone = req.user?.phone;
      if (!contractorPhone) {
        return res.status(400).json({ success: false, message: "Contractor phone missing from token" });
      }

      const limit = parseInt(req.query.limit || "50", 10);
      const skip = parseInt(req.query.skip || "0", 10);
      const query = {
        type: "job_request",
        "metadata.contractorPhone": contractorPhone,
      };

      const [requests, total] = await Promise.all([
        NotificationHistory.find(query)
          .sort({ createdAt: -1 })
          .limit(limit)
          .skip(skip)
          .lean(),
        NotificationHistory.countDocuments(query),
      ]);

      const formatted = requests.map((request) => {
        const metadata = request.metadata || {};
        const responded = metadata.responded === true;
        const accepted = metadata.accepted === true;

        return {
          _id: request._id,
          requestId: metadata.requestId || String(request._id),
          workerPhone: metadata.workerPhone || request.recipientPhone,
          status: responded ? (accepted ? "accepted" : "declined") : "pending",
          createdAt: request.createdAt,
          updatedAt: request.updatedAt,
          metadata,
          type: request.type,
          title: request.title,
          body: request.body,
        };
      });

      return res.json({ success: true, requests: formatted, total });
    } catch (err) {
      console.error("workers/job-requests error", err);
      return res.status(500).json({ success: false, message: "Failed to fetch job requests" });
    }
  });

  router.post("/workers/respond-job-request", authenticateToken, async (req, res) => {
    try {
      const { requestId, accepted } = req.body || {};

      if (!requestId || typeof accepted !== 'boolean') {
        return res.status(400).json({
          success: false,
          message: "requestId and accepted (boolean) are required"
        });
      }

      // Find the notification
      const notification = await NotificationHistory.findOne({
        'metadata.requestId': requestId,
        recipientPhone: req.user.phone,
        type: 'job_request'
      });

      if (!notification) {
        return res.status(404).json({ success: false, message: "Job request not found" });
      }

      const contractorPhone = notification.metadata.contractorPhone;
      const contractor = await User.findOne({ phone: contractorPhone });

      // Update notification with response
      await NotificationHistory.findByIdAndUpdate(notification._id, {
        $set: {
          'metadata.responded': true,
          'metadata.accepted': accepted,
          'metadata.responseTime': new Date().toISOString(),
        }
      });

      // Send response notification to contractor
      const responseNotificationData = {
        recipientPhone: contractorPhone,
        phone: contractorPhone,
        type: accepted ? "job_request_accepted" : "job_request_declined",
        title: accepted ? "Job Request Accepted!" : "Job Request Declined",
        body: `Your job request was ${accepted ? 'accepted' : 'declined'} by ${req.user.name || req.user.phone}`,
        metadata: {
          workerPhone: req.user.phone,
          workerName: req.user.name,
          requestId,
          date: notification.metadata.date,
          startTime: notification.metadata.startTime,
          endTime: notification.metadata.endTime,
          location: notification.metadata.location,
          responseTime: new Date().toISOString(),
        },
      };

      await NotificationHistory.create(responseNotificationData);

      // Send real-time notification to contractor if online
      try {
        io.to(contractorPhone).emit("jobRequestResponse", {
          requestId,
          workerPhone: req.user.phone,
          workerName: req.user.name,
          accepted,
          date: notification.metadata.date,
          startTime: notification.metadata.startTime,
          endTime: notification.metadata.endTime,
          location: notification.metadata.location,
          responseTime: new Date().toISOString(),
        });
      } catch (e) {
        console.warn("Could not emit jobRequestResponse to contractor room:", e.message);
      }

      // Send push notification to contractor
      try {
        const payload = {
          type: accepted ? "job_request_accepted" : "job_request_declined",
          title: accepted ? "Job Request Accepted!" : "Job Request Declined",
          body: `Your job request was ${accepted ? 'accepted' : 'declined'} by ${req.user.name || req.user.phone}`,
          metadata: {
            workerPhone: req.user.phone,
            workerName: req.user.name,
            requestId,
            date: notification.metadata.date,
            startTime: notification.metadata.startTime,
            endTime: notification.metadata.endTime,
            location: notification.metadata.location,
          },
        };
        await sendNotificationToUserPhone(contractorPhone, payload);
      } catch (e) {
        console.error("Error sending push notification for job response:", e && e.message);
      }

      return res.json({
        success: true,
        message: `Job request ${accepted ? 'accepted' : 'declined'} successfully`
      });
    } catch (err) {
      console.error("workers/respond-job-request error", err);
      return res.status(500).json({ success: false, message: "Failed to respond to job request" });
    }
  });

  router.get("/worker/:phone", authenticateToken, async (req, res, next) => {
    try {
      const workerPhone = req.params.phone;
      if (workerPhone === "profile") {
        return next();
      }

      const worker = await WorkerModel.findOne({ phone: workerPhone });
      const user = await User.findOne({ phone: workerPhone });
      if (!worker && !user) {
        return res.status(404).json({ success: false, message: "Worker not found" });
      }

      return res.json({
        id: worker?._id?.toString() || null,
        phone: worker?.phone || user?.phone,
        location: worker?.location || null,
        isAvailable: user?.isAvailable ?? worker?.isAvailable ?? false,
        profilePhoto: user?.profilePhoto || null,
        skills: worker?.skills || [],
      });
    } catch (err) {
      console.error("Failed to fetch worker details", err);
      return res.status(500).json({ success: false, message: "Failed to fetch worker details" });
    }
  });

  router.get("/worker/profile", authenticateToken, async (req, res) => {
    try {
      const workerPhone = req.user?.phone;
      if (!workerPhone) {
        return res.status(400).json({ success: false, message: "User phone not found in token" });
      }

      const worker = await WorkerModel.findOne({ phone: workerPhone });
      const user = await User.findOne({ phone: workerPhone });
      if (!worker && !user) {
        return res.status(404).json({ success: false, message: "Worker not found" });
      }

      return res.json({
        success: true,
        worker: {
          phone: worker?.phone || user?.phone,
          name: user?.name || "Unknown",
          profilePhoto: user?.profilePhoto,
          skills: worker?.skills || [],
          mainSkill: user?.mainSkill || worker?.mainSkill,
          expectedWage: user?.expectedWage || "Negotiable",
          isAvailable: user?.isAvailable ?? worker?.isAvailable ?? false,
          rating: worker?.rating || 0,
          performanceMetrics: {
            averageRating: worker?.performanceMetrics?.averageRating || 0,
            totalReviews: worker?.performanceMetrics?.totalReviews || 0,
            completionRate: worker?.performanceMetrics?.completionRate || 0,
            cancellationRate: worker?.performanceMetrics?.cancellationRate || 0,
            averageEarningsPerGig: worker?.performanceMetrics?.averageEarningsPerGig || 0,
          },
          gigsData: {
            totalGigsCompleted: worker.gigsData?.totalGigsCompleted || 0,
            totalEarnings: worker.gigsData?.totalEarnings || 0,
            consecutiveDays: worker.gigsData?.consecutiveDays || 0,
          },
        },
      });
    } catch (err) {
      console.error("Failed to fetch worker profile", err);
      return res.status(500).json({ success: false, message: "Failed to fetch worker profile" });
    }
  });

  router.get("/worker/incentive-data", authenticateToken, async (req, res) => {
    try {
      setNoStore(req, res);
      const workerPhone = req.user.phone;
      const normalizePhoneDigits = (value) => String(value || "").replace(/\D/g, "").slice(-10);
      const workerDigits = normalizePhoneDigits(workerPhone);
      const workerPhoneOr = {
        $or: [
          { phone: { $in: Array.from(new Set([String(workerPhone || "").trim(), workerDigits].filter(Boolean))) } },
          ...(workerDigits ? [{ phone: { $regex: `${workerDigits}$` } }] : []),
        ],
      };
      const worker = await WorkerModel.findOne(workerPhoneOr);
      if (!worker) {
        return res.status(404).json({ success: false, message: "Worker not found" });
      }

      const events = await GigHistory.find({
        $or: [
          { workerPhone: { $in: Array.from(new Set([String(workerPhone || "").trim(), workerDigits].filter(Boolean))) } },
          ...(workerDigits ? [{ workerPhone: { $regex: `${workerDigits}$` } }] : []),
        ],
      })
        .sort({ eventTime: -1 })
        .limit(365)
        .lean();

      const eligibility = calculateEligibility(events);
      const ledgerRecords = await IncentiveLedger.find({
        phone: workerPhone,
        milestoneId: { $in: MILESTONE_IDS },
      }).lean();
      const claimStatusByMilestone = buildClaimStatusByMilestone(eligibility, ledgerRecords);
      const claimedMilestones = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'claimed');
      const availableMilestones = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'available');
      const pendingMilestones = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'processing');
      const failedMilestones = MILESTONE_IDS.filter((id) => claimStatusByMilestone[id] === 'failed');

      return res.json({
        success: true,
        data: {
          consecutiveDays: eligibility.consecutiveDays,
          totalHours: eligibility.totalHours,
          totalCancellations: eligibility.cancellationsInWindow,
          totalEarnings: worker.gigsData?.totalEarnings || 0,
          completionRate: worker.performanceMetrics?.completionRate || 0,
          averageRating: worker.performanceMetrics?.averageRating || worker.rating || 0,
          milestonesUnlocked: worker.gigsData?.milestonesUnlocked || {},
          eligibleFor5Days: eligibility.eligibleFor5Days,
          eligibleFor10Days: eligibility.eligibleFor10Days,
          eligibleFor20Days: eligibility.eligibleFor20Days,
          claimStatusByMilestone,
          claimedMilestones,
          availableMilestones,
          pendingMilestones,
          failedMilestones,
          lastWorkDate: eligibility.lastWorkDate,
          recentGigs: worker.recentGigs || [],
        },
      });
    } catch (err) {
      console.error("Error fetching incentive data:", err);
      return res.status(500).json({ success: false, message: "Error fetching incentive data" });
    }
  });

  router.get("/worker/overview-stats", authenticateToken, async (req, res) => {
    try {
      setNoStore(req, res);
      const workerPhone = req.user?.phone;
      if (!workerPhone) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }
      const normalizePhoneDigits = (value) => String(value || "").replace(/\D/g, "").slice(-10);
      const workerDigits = normalizePhoneDigits(workerPhone);
      const workerVariants = Array.from(new Set([String(workerPhone || "").trim(), workerDigits].filter(Boolean)));
      const sameWorkerPhone = (value) => {
        const raw = String(value || "").trim();
        if (!raw) return false;
        if (workerVariants.includes(raw)) return true;
        const digits = normalizePhoneDigits(raw);
        return !!digits && !!workerDigits && digits === workerDigits;
      };

      const now = new Date();
      const todayStart = new Date(now);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(todayStart);
      todayEnd.setDate(todayEnd.getDate() + 1);

      // Week window: Monday 00:00 -> next Monday 00:00 (local time)
      const weekStart = new Date(todayStart);
      const dayOfWeek = weekStart.getDay(); // 0=Sunday, 1=Monday...
      const diffToMonday = (dayOfWeek + 6) % 7;
      weekStart.setDate(weekStart.getDate() - diffToMonday);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 7);

      const workerJobQuery = {
        $or: [
          { acceptedBy: { $in: workerVariants } },
          { "acceptedWorker.phone": { $in: workerVariants } },
          { "acceptedWorkers.phone": { $in: workerVariants } },
          ...(workerDigits
            ? [
                { acceptedBy: { $regex: `${workerDigits}$` } },
                { "acceptedWorker.phone": { $regex: `${workerDigits}$` } },
                { "acceptedWorkers.phone": { $regex: `${workerDigits}$` } },
              ]
            : []),
        ],
      };

      const paidStatusFilter = { $regex: /^paid$/i };
      const candidateCompletedJobs = await Job.find({
        $and: [
          workerJobQuery,
          {
            $or: [
              { status: "completed" },
              { paymentTime: { $exists: true, $ne: null } },
              { "acceptedWorkers.paymentTime": { $exists: true, $ne: null } },
            ],
          },
        ],
      })
        .select("amount status paymentStatus paymentTime timeSpentMinutes acceptedAt createdAt updatedAt rating acceptedBy acceptedWorker acceptedWorkers")
        .lean();

      const operationalJobs = await Job.find({
        $and: [
          workerJobQuery,
          { status: { $nin: ["cancelled", "expired"] } },
        ],
      })
        .select("status timeSpentMinutes hoursWorked acceptedAt paymentTime createdAt updatedAt acceptedWorkers")
        .lean();

      // Bug #8 Fix: Check attendance status in addition to payment
      const getPaidEntryForWorker = (job) => {
        if (!Array.isArray(job?.acceptedWorkers)) return null;
        return job.acceptedWorkers.find(
          (w) =>
            sameWorkerPhone(w?.phone || w?.workerPhone) &&
            w?.attendanceStatus === 'Present' &&
            /^paid$/i.test(String(w?.paymentStatus || ""))
        ) || null;
      };

      const isPaidForWorker = (job) => {
        const paidEntry = getPaidEntryForWorker(job);
        if (paidEntry) return true;
        const isSingleWorkerMatch = sameWorkerPhone(job?.acceptedBy || job?.acceptedWorker?.phone);
        return isSingleWorkerMatch && /^paid$/i.test(String(job?.paymentStatus || ""));
      };

      const completedJobs = candidateCompletedJobs.filter((j) => isPaidForWorker(j));

      const getEffectivePaidAt = (job) => {
        const paidEntry = getPaidEntryForWorker(job);
        const paidAtFromWorker = paidEntry?.paymentTime ? new Date(paidEntry.paymentTime) : null;
        if (paidAtFromWorker && !Number.isNaN(paidAtFromWorker.getTime())) return paidAtFromWorker;
        const paidAt = job?.paymentTime ? new Date(job.paymentTime) : null;
        if (paidAt && !Number.isNaN(paidAt.getTime())) return paidAt;
        const updatedAt = job?.updatedAt ? new Date(job.updatedAt) : null;
        if (updatedAt && !Number.isNaN(updatedAt.getTime())) return updatedAt;
        const createdAt = job?.createdAt ? new Date(job.createdAt) : null;
        if (createdAt && !Number.isNaN(createdAt.getTime())) return createdAt;
        return null;
      };

      const getOperationalAnchorTime = (job) => {
        const acceptedEntry = Array.isArray(job?.acceptedWorkers)
          ? job.acceptedWorkers.find((w) => sameWorkerPhone(w?.phone || w?.workerPhone))
          : null;
        const acceptedAtFromWorker = acceptedEntry?.acceptedAt ? new Date(acceptedEntry.acceptedAt) : null;
        if (acceptedAtFromWorker && !Number.isNaN(acceptedAtFromWorker.getTime())) return acceptedAtFromWorker;
        const acceptedAt = job?.acceptedAt ? new Date(job.acceptedAt) : null;
        if (acceptedAt && !Number.isNaN(acceptedAt.getTime())) return acceptedAt;
        const paymentAtFromWorker = acceptedEntry?.paymentTime ? new Date(acceptedEntry.paymentTime) : null;
        if (paymentAtFromWorker && !Number.isNaN(paymentAtFromWorker.getTime())) return paymentAtFromWorker;
        const paymentAt = job?.paymentTime ? new Date(job.paymentTime) : null;
        if (paymentAt && !Number.isNaN(paymentAt.getTime())) return paymentAt;
        const updatedAt = job?.updatedAt ? new Date(job.updatedAt) : null;
        if (updatedAt && !Number.isNaN(updatedAt.getTime())) return updatedAt;
        const createdAt = job?.createdAt ? new Date(job.createdAt) : null;
        if (createdAt && !Number.isNaN(createdAt.getTime())) return createdAt;
        return null;
      };

      const resolveTimeSpentMinutes = (job) => {
        const explicit = Number(job?.timeSpentMinutes || 0);
        if (explicit > 0) return explicit;
        const acceptedAt = job?.acceptedAt ? new Date(job.acceptedAt) : null;
        const paidAt = getEffectivePaidAt(job);
        if (acceptedAt && paidAt && !Number.isNaN(acceptedAt.getTime()) && !Number.isNaN(paidAt.getTime())) {
          return Math.max(0, Math.round((paidAt.getTime() - acceptedAt.getTime()) / 60000));
        }
        return 0;
      };

      const todayCompletedJobs = completedJobs.filter((j) => {
        const d = getEffectivePaidAt(j);
        return d && d >= todayStart && d < todayEnd;
      });
      const todayOperationalJobs = operationalJobs.filter((j) => {
        const d = getOperationalAnchorTime(j);
        return d && d >= todayStart && d < todayEnd;
      });

      const resolveOperationalTimeMinutes = (job) => {
        const explicit = Number(job?.timeSpentMinutes || 0);
        if (explicit > 0) return explicit;

        const acceptedAt = job?.acceptedAt ? new Date(job.acceptedAt) : null;
        if (!acceptedAt || Number.isNaN(acceptedAt.getTime())) {
          return Math.max(0, Math.round((Number(job?.hoursWorked || 0) || 0) * 60));
        }

        const status = String(job?.status || "").toLowerCase();
        const endAt =
          status === "accepted" || status === "in_progress"
            ? new Date()
            : (job?.paymentTime ? new Date(job.paymentTime) : new Date(job?.updatedAt || Date.now()));
        if (!endAt || Number.isNaN(endAt.getTime())) return 0;
        return Math.max(0, Math.round((endAt.getTime() - acceptedAt.getTime()) / 60000));
      };

      const todayEarnings = todayCompletedJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);
      const timeOnOrder = todayOperationalJobs.reduce((sum, j) => sum + resolveOperationalTimeMinutes(j), 0);
      const todayJobs = todayOperationalJobs.length;
      const totalEarnings = completedJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);
      const jobsCompleted = completedJobs.length;

      const ratings = completedJobs
        .flatMap((j) => {
          const jobLevelRating = Number(j?.rating?.stars || j?.rating || 0);
          const workerLevelRatings = Array.isArray(j?.acceptedWorkers)
            ? j.acceptedWorkers
                .filter((w) => sameWorkerPhone(w?.phone))
                .map((w) => Number(w?.rating?.stars || 0))
                .filter((r) => r > 0)
            : [];
          
          // Include both job-level rating (for single jobs) and worker-level ratings (for bulk jobs)
          const allRatings = [];
          if (jobLevelRating > 0) allRatings.push(jobLevelRating);
          allRatings.push(...workerLevelRatings);
          
          return allRatings;
        })
        .filter((v) => Number.isFinite(v) && v > 0);
      let avgCompletedRating = ratings.length
        ? Number((ratings.reduce((s, v) => s + v, 0) / ratings.length).toFixed(2))
        : 0;

      // Source-of-truth rating for worker profile/overall summary.
      const workerDoc = await WorkerModel.findOne({ phone: workerPhone })
        .select("performanceMetrics.averageRating rating")
        .lean();
      const persistedAvg = Number(workerDoc?.performanceMetrics?.averageRating || workerDoc?.rating || 0);
      if (persistedAvg > 0) {
        avgCompletedRating = Number(persistedAvg.toFixed(2));
      }

      const historyCount = await Job.countDocuments({
        $and: [workerJobQuery, { status: { $nin: ["cancelled", "expired"] } }],
      });

      const wallet = await Wallet.findOne({ phone: workerPhone }).select("transactions").lean();
      const transactions = Array.isArray(wallet?.transactions) ? wallet.transactions : [];
      const activeBonuses = transactions
        .filter((t) => String(t?.type || "").toLowerCase() === "incentive_reward")
        .filter((t) => {
          const d = new Date(t?.date || 0);
          return !Number.isNaN(d.getTime()) && d >= weekStart && d < weekEnd;
        })
        .reduce((sum, t) => sum + (Number(t?.amount) || 0), 0);

      return res.json({
        success: true,
        weekWindow: {
          start: weekStart,
          end: weekEnd,
        },
        stats: {
          todayEarnings,
          timeOnOrder,
          todayJobs,
          historyCount,
          totalEarnings,
          jobsCompleted,
          avgCompletedRating,
          activeBonuses,
        },
      });
    } catch (err) {
      console.error("worker/overview-stats error:", err);
      return res.status(500).json({ success: false, message: "Failed to fetch overview stats" });
    }
  });

  router.post("/workers/verify-profile", authenticateToken, async (req, res) => {
    try {
      const phone = req.user.phone;
      const user = await User.findOne({ phone });
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      const isProfileComplete = !!(user.mainSkill && user.expectedWage);
      if (isProfileComplete) {
        return res.status(200).json({
          success: true,
          message: "Profile is complete",
          isProfileComplete: true,
          mainSkill: user.mainSkill,
          expectedWage: user.expectedWage,
        });
      }

      return res.status(200).json({
        success: false,
        message: "Profile is incomplete. Please set Main Skill and Expected Wage.",
        isProfileComplete: false,
        missingFields: {
          mainSkill: !user.mainSkill,
          expectedWage: !user.expectedWage,
        },
      });
    } catch (err) {
      console.error("Profile verification error:", err);
      return res.status(500).json({ success: false, message: "Failed to verify profile", error: err.message });
    }
  });

  router.put("/workers/availability", authenticateToken, async (req, res) => {
    try {
      const { isAvailable, latitude, longitude } = req.body;
      const phone = req.user.phone;

      if (typeof isAvailable !== "boolean") {
        return res.status(400).json({ success: false, message: "isAvailable must be a boolean" });
      }

      const workerState = await WorkerModel.findOne({ phone }).select("isBlocked blockedReason compliance").lean();
      if (isAvailable === true && workerState?.isBlocked) {
        return res.status(403).json({
          success: false,
          code: "WORKER_BLOCKED",
          message: "You are blocked and cannot go online. Contact support.",
          blockedReason: workerState?.blockedReason || "blocked_by_admin",
        });
      }

      if (isAvailable === true) {
        const workerRecord = workerState || await WorkerModel.findOne({ phone }).select("compliance").lean();
        const requiresPocketMinimum = !!workerRecord?.compliance?.requiresPocketMinimumForOnline;
        const minPocketAmount = Number(workerRecord?.compliance?.pocketMinimumAmount || 100);

        if (requiresPocketMinimum) {
          const wallet = await Wallet.findOne({ phone }).select("pocketBalance").lean();
          const pocketBalance = Number(wallet?.pocketBalance || 0);
          if (pocketBalance < minPocketAmount) {
            return res.status(403).json({
              success: false,
              code: "POCKET_BALANCE_REQUIRED",
              message: `Pocket balance must be at least ₹${minPocketAmount} to go online.`,
              requiredPocketBalance: minPocketAmount,
              currentPocketBalance: pocketBalance,
            });
          }
        }

        // 🔐 CRITICAL: Check for pending cash deposits before allowing worker to go online
        const { totalPendingAmount, pendingDeposits } = await jobsLifecycleService.getPendingCashDepositsForWorker({ workerPhone: phone });

        if (pendingDeposits.length > 0) {
          return res.status(403).json({
            success: false,
            code: "PENDING_CASH_DEPOSIT",
            message: `You have ₹${totalPendingAmount} in pending cash deposits that must be deposited before you can go online.`,
            requiredDepositAmount: totalPendingAmount,
            pendingDeposits,
            actionRequired: "deposit_cash"
          });
        }
      }

      const updateObj = { isAvailable, updatedAt: new Date() };
      if (
        isAvailable === true &&
        latitude !== undefined &&
        latitude !== null &&
        longitude !== undefined &&
        longitude !== null
      ) {
        const parsedLat = parseFloat(latitude);
        const parsedLon = parseFloat(longitude);
        if (!isNaN(parsedLat) && !isNaN(parsedLon)) {
          try {
            const point = { type: "Point", coordinates: [parsedLon, parsedLat] };
            let district = await District.findOne({
              geometry: { $geoIntersects: { $geometry: point } },
            }).lean();
            if (!district) {
              district = await District.findOne(
                { centroid: { $nearSphere: { $geometry: point, $maxDistance: 50000 } } },
                null,
                { lean: true }
              );
            }
            if (district) {
              updateObj.latitude = parsedLat;
              updateObj.longitude = parsedLon;
              updateObj.city = district.name;
              updateObj.state = district.state;
              updateObj.location = { type: "Point", coordinates: [parsedLon, parsedLat] };
              updateObj.locationLastUpdated = new Date();
              updateObj.locationEnabled = true;
            }
          } catch (distErr) {
            console.error("Error finding district:", distErr.message);
            updateObj.latitude = parsedLat;
            updateObj.longitude = parsedLon;
            updateObj.location = { type: "Point", coordinates: [parsedLon, parsedLat] };
            updateObj.locationLastUpdated = new Date();
            updateObj.locationEnabled = true;
          }
        }
      }

      const existingUser = await User.findOne({ phone });
      if (!existingUser) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      if (isAvailable === true && updateObj.latitude === undefined && updateObj.longitude === undefined) {
        if (!isValidPoint(existingUser.latitude, existingUser.longitude)) {
          return res.status(400).json({
            success: false,
            message: "Please enable location services and share your location before going online.",
          });
        }
        updateObj.locationEnabled = true;
      }

      const updatedUser = await User.findOneAndUpdate({ phone }, updateObj, { new: true });
      if (!updatedUser) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      console.log(`✅ [AVAILABILITY UPDATE] User ${phone}: isAvailable=${isAvailable} written to User collection`, {
        updateObj,
        resultIsAvailable: updatedUser.isAvailable
      });

      const updatedWorker = await WorkerModel.findOneAndUpdate(
        { phone },
        updateObj,
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );

      console.log(`✅ [AVAILABILITY UPDATE] Worker ${phone}: isAvailable=${isAvailable} written to WorkerModel`, {
        resultIsAvailable: updatedWorker?.isAvailable
      });

      let connectedWorkerFound = false;
      for (const [socketId, worker] of connectedWorkers.entries()) {
        if (worker.phone === phone) {
          console.log(`📍 [AVAILABILITY UPDATE] Found worker in connectedWorkers at socketId=${socketId}. Before: isAvailable=${worker.isAvailable}`);
          worker.isAvailable = isAvailable;
          if (updateObj.latitude !== undefined) {
            worker.latitude = updateObj.latitude;
            worker.longitude = updateObj.longitude;
            worker.city = updateObj.city;
          }
          connectedWorkers.set(socketId, worker);
          console.log(`📍 [AVAILABILITY UPDATE] Updated connectedWorkers: Worker ${phone} isAvailable=${worker.isAvailable}`);
          connectedWorkerFound = true;
          break;
        }
      }
      
      if (!connectedWorkerFound) {
        console.warn(`⚠️ [AVAILABILITY UPDATE] Worker ${phone} NOT found in connectedWorkers map (size=${connectedWorkers.size}). Will be updated on next socket registration.`);
      }

      if (isAvailable === true) {
        await checkJobMatchesForWorker(phone);
      }

      io.to(phone).emit("workerStatusUpdate", {
        isAvailable,
        phone,
        message: `Worker is now ${isAvailable ? "online" : "offline"}`,
        timestamp: new Date(),
      });

      return res.json({
        success: true,
        message: `Worker is now ${isAvailable ? "online" : "offline"}`,
        user: {
          phone: updatedUser.phone,
          name: updatedUser.name,
          isAvailable: updatedUser.isAvailable,
          role: updatedUser.role,
          city: updatedUser.city,
          latitude: updatedUser.latitude,
          longitude: updatedUser.longitude,
        },
      });
    } catch (err) {
      console.error("Update worker availability error:", err);
      return res
        .status(500)
        .json({ success: false, message: "Error updating worker availability", error: err.message });
    }
  });

  router.post("/user/update-location", authenticateToken, async (req, res) => {
    try {
      const { latitude, longitude } = req.body;
      const phone = req.user.phone;

      if (latitude === undefined || latitude === null || longitude === undefined || longitude === null) {
        return res.status(400).json({ success: false, message: "Latitude and longitude required" });
      }

      const parsedLat = parseFloat(latitude);
      const parsedLon = parseFloat(longitude);
      if (isNaN(parsedLat) || isNaN(parsedLon) || !isValidPoint(parsedLat, parsedLon)) {
        return res.status(400).json({
          success: false,
          message: "Invalid coordinates. Latitude must be between -90 and 90 and longitude between -180 and 180.",
        });
      }

      let city = "Unknown";
      let state = "Unknown";
      try {
        const point = { type: "Point", coordinates: [parsedLon, parsedLat] };
        let district = await District.findOne({
          geometry: { $geoIntersects: { $geometry: point } },
        }).lean();
        if (!district) {
          district = await District.findOne(
            { centroid: { $nearSphere: { $geometry: point, $maxDistance: 50000 } } },
            null,
            { lean: true }
          );
        }
        if (district) {
          city = district.name;
          state = district.state;
        }
      } catch (distErr) {
        console.error("Error finding district:", distErr.message);
      }

      const user = await User.findOneAndUpdate(
        { phone },
        {
          latitude: parsedLat,
          longitude: parsedLon,
          city,
          state,
          location: { type: "Point", coordinates: [parsedLon, parsedLat] },
          locationLastUpdated: new Date(),
          locationEnabled: true,
        },
        { new: true }
      );

      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      if (user.role === "worker") {
        await WorkerModel.findOneAndUpdate(
          { phone },
          {
            latitude: parsedLat,
            longitude: parsedLon,
            city,
            state,
            location: { type: "Point", coordinates: [parsedLon, parsedLat] },
            updatedAt: new Date(),
          }
        );
      }

      return res.json({
        success: true,
        message: "Location updated successfully",
        user: {
          phone: user.phone,
          latitude: user.latitude,
          longitude: user.longitude,
          city: user.city,
          state: user.state,
        },
      });
    } catch (err) {
      console.error("Error updating location:", err);
      return res.status(500).json({ success: false, message: "Error updating location", error: err.message });
    }
  });

  router.get("/debug/workers-locations", authenticateToken, async (req, res) => {
    try {
      const workers = await WorkerModel.find({}).select("phone name location isAvailable").lean();
      const workerPhones = workers.map((w) => w.phone).filter(Boolean);
      const users = await User.find({ phone: { $in: workerPhones } }).select("phone isAvailable").lean();
      const userAvailabilityByPhone = new Map(users.map((u) => [u.phone, !!u.isAvailable]));
      const formattedWorkers = workers.map((w) => ({
        phone: w.phone,
        name: w.name,
        location: w.location?.coordinates || [0, 0],
        isAvailable: userAvailabilityByPhone.has(w.phone)
          ? userAvailabilityByPhone.get(w.phone)
          : !!w.isAvailable,
      }));
      return res.json({ success: true, count: workers.length, workers: formattedWorkers });
    } catch (err) {
      console.error("debug/workers-locations error", err);
      return res.status(500).json({ success: false, message: "Error fetching workers", error: err.message });
    }
  });

  router.get("/debug/geo-test", authenticateToken, async (req, res) => {
    try {
      const { lat = 26.9988724, lon = 75.9130502 } = req.query;
      const indexes = await WorkerModel.collection.getIndexes();
      const result = await WorkerModel.aggregate([
        {
          $geoNear: {
            near: { type: "Point", coordinates: [parseFloat(lon), parseFloat(lat)] },
            distanceField: "distance",
            maxDistance: 100000,
            spherical: true,
          },
        },
        { $limit: 10 },
      ]);

      return res.json({
        success: true,
        message: "$geoNear query executed successfully",
        indexes,
        testCoordinates: [parseFloat(lon), parseFloat(lat)],
        resultCount: result.length,
        workers: result.slice(0, 5).map((w) => ({
          phone: w.phone,
          distance: w.distance,
          location: w.location?.coordinates,
        })),
      });
    } catch (err) {
      console.error("debug/geo-test error", err);
      return res.status(500).json({ success: false, message: "Geo test failed", error: err.message });
    }
  });

  return router;
}

module.exports = { createWorkersRouter };
