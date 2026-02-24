const express = require("express");
const { authenticateToken } = require("../utils/auth");
const User = require("../models/User");
const WorkerModel = require("../models/Worker");
const Job = require("../models/Jobs");
const Wallet = require("../models/Wallet");
const NotificationHistory = require("../models/NotificationHistory");
const District = require("../models/City");
const GigHistory = require("../models/GigHistory");
const { calculateEligibility } = require("../services/incentiveEligibilityService");

function createWorkersRouter({
  io,
  connectedWorkers,
  checkJobMatchesForWorker,
  sendNotificationToUserPhone,
}) {
  const router = express.Router();

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
            isAvailable: worker.isAvailable || false,
            createdAt: userProfile.createdAt,
          };
        })
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
          message: `Requested by ${req.user.phone}: ${message || ""}`,
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

  router.get("/worker/:phone", authenticateToken, async (req, res, next) => {
    try {
      const workerPhone = req.params.phone;
      if (workerPhone === "profile") {
        return next();
      }

      const worker = await WorkerModel.findOne({ phone: workerPhone });
      if (!worker) {
        return res.status(404).json({ success: false, message: "Worker not found" });
      }

      const user = await User.findOne({ phone: workerPhone });
      return res.json({
        id: worker._id.toString(),
        phone: worker.phone,
        location: worker.location || null,
        isAvailable: worker.isAvailable || false,
        profilePhoto: user?.profilePhoto || null,
        skills: worker.skills || [],
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
      if (!worker) {
        return res.status(404).json({ success: false, message: "Worker not found" });
      }

      const user = await User.findOne({ phone: workerPhone });
      return res.json({
        success: true,
        worker: {
          phone: worker.phone,
          name: user?.name || "Unknown",
          profilePhoto: user?.profilePhoto,
          skills: worker.skills || [],
          mainSkill: user?.mainSkill || worker.mainSkill,
          expectedWage: user?.expectedWage || "Negotiable",
          isAvailable: worker.isAvailable || false,
          rating: worker.rating || 0,
          performanceMetrics: {
            averageRating: worker.performanceMetrics?.averageRating || 0,
            totalReviews: worker.performanceMetrics?.totalReviews || 0,
            completionRate: worker.performanceMetrics?.completionRate || 0,
            cancellationRate: worker.performanceMetrics?.cancellationRate || 0,
            averageEarningsPerGig: worker.performanceMetrics?.averageEarningsPerGig || 0,
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
      const workerPhone = req.user.phone;
      const worker = await WorkerModel.findOne({ phone: workerPhone });
      if (!worker) {
        return res.status(404).json({ success: false, message: "Worker not found" });
      }

      const events = await GigHistory.find({ workerPhone })
        .sort({ eventTime: -1 })
        .limit(365)
        .lean();

      const eligibility = calculateEligibility(events);

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
      const workerPhone = req.user?.phone;
      if (!workerPhone) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }

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
          { acceptedBy: workerPhone },
          { "acceptedWorkers.phone": workerPhone },
        ],
      };

      const completedJobs = await Job.find({
        ...workerJobQuery,
        status: "completed",
        paymentStatus: "Paid",
      })
        .select("amount paymentTime timeSpentMinutes rating")
        .lean();

      const todayCompletedJobs = completedJobs.filter((j) => {
        const d = j.paymentTime ? new Date(j.paymentTime) : null;
        return d && d >= todayStart && d < todayEnd;
      });
      const weeklyCompletedJobs = completedJobs.filter((j) => {
        const d = j.paymentTime ? new Date(j.paymentTime) : null;
        return d && d >= weekStart && d < weekEnd;
      });

      const todayEarnings = todayCompletedJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);
      const timeOnOrder = todayCompletedJobs.reduce((sum, j) => sum + (Number(j.timeSpentMinutes) || 0), 0);
      const todayJobs = todayCompletedJobs.length;
      const totalEarnings = weeklyCompletedJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);
      const jobsCompleted = weeklyCompletedJobs.length;

      const ratings = weeklyCompletedJobs
        .map((j) => Number(j.rating?.stars || 0))
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
        ...workerJobQuery,
        createdAt: { $gte: weekStart, $lt: weekEnd },
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

      if (isAvailable === true) {
        const workerRecord = await WorkerModel.findOne({ phone }).select("compliance").lean();
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

      const updatedUser = await User.findOneAndUpdate({ phone }, updateObj, { new: true });
      if (!updatedUser) {
        return res.status(404).json({ success: false, message: "User not found" });
      }

      await WorkerModel.findOneAndUpdate({ phone }, updateObj, { new: true });

      for (const [socketId, worker] of connectedWorkers.entries()) {
        if (worker.phone === phone) {
          worker.isAvailable = isAvailable;
          if (updateObj.latitude !== undefined) {
            worker.latitude = updateObj.latitude;
            worker.longitude = updateObj.longitude;
            worker.city = updateObj.city;
          }
          connectedWorkers.set(socketId, worker);
          break;
        }
      }

      if (isAvailable === true) {
        await checkJobMatchesForWorker(phone);
      }

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
      if (isNaN(parsedLat) || isNaN(parsedLon)) {
        return res.status(400).json({ success: false, message: "Invalid coordinates" });
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
      const formattedWorkers = workers.map((w) => ({
        phone: w.phone,
        name: w.name,
        location: w.location?.coordinates || [0, 0],
        isAvailable: w.isAvailable,
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
