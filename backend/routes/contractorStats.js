const express = require("express");
const { authenticateToken } = require("../utils/auth");
const ContractorStats = require("../models/ContractorStats");
const Job = require("../models/Jobs");

function createContractorStatsRouter() {
  const router = express.Router();

  router.post("/contractor/stats/save", authenticateToken, async (req, res) => {
    try {
      const { phone } = req.user;
      const { jobsPosted, jobsCompleted, workersEngaged, totalSpending, jobDetails, workersList } = req.body;

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      let stats = await ContractorStats.findOne({ phone, date: today });
      if (stats) {
        stats.jobsPosted = jobsPosted || stats.jobsPosted;
        stats.jobsCompleted = jobsCompleted || stats.jobsCompleted;
        stats.workersEngaged = workersEngaged || stats.workersEngaged;
        stats.totalSpending = totalSpending || stats.totalSpending;
        if (jobDetails) stats.jobDetails = jobDetails;
        if (workersList) stats.workersList = workersList;
        stats.updatedAt = new Date();
      } else {
        stats = new ContractorStats({
          phone,
          date: today,
          jobsPosted: jobsPosted || 0,
          jobsCompleted: jobsCompleted || 0,
          workersEngaged: workersEngaged || 0,
          totalSpending: totalSpending || 0,
          jobDetails: jobDetails || [],
          workersList: workersList || [],
        });
      }

      await stats.save();
      return res.json({ success: true, stats, message: "Stats saved successfully" });
    } catch (err) {
      console.error("Save stats error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/contractor/stats", authenticateToken, async (req, res) => {
    try {
      const { phone, name } = req.user;
      const { range = "today" } = req.query;

      const now = new Date();
      const startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      const endDate = new Date(now);
      endDate.setHours(23, 59, 59, 999);

      if (range === "week") {
        startDate.setDate(startDate.getDate() - 6);
      } else if (range === "month") {
        startDate.setDate(startDate.getDate() - 29);
      }

      const jobQuery = {
        $and: [
          {
            $or: [
              { contractorPhone: phone },
              ...(name ? [{ contractorName: name }] : []),
            ],
          },
          {
            $or: [{ isCancelled: { $exists: false } }, { isCancelled: { $ne: true } }],
          },
          { status: { $ne: "cancelled" } },
          { createdAt: { $gte: startDate, $lte: endDate } },
        ],
      };

      const jobs = await Job.find(jobQuery).lean();

      const dayMap = new Map();
      for (const job of jobs) {
        const day = new Date(job.createdAt || now);
        day.setHours(0, 0, 0, 0);
        const dayKey = day.toISOString();
        if (!dayMap.has(dayKey)) {
          dayMap.set(dayKey, {
            phone,
            date: day,
            jobsPosted: 0,
            jobsCompleted: 0,
            workersList: [],
            totalSpending: 0,
          });
        }

        const bucket = dayMap.get(dayKey);
        bucket.jobsPosted += 1;
        if (job.paymentStatus === "Paid") {
          bucket.jobsCompleted += 1;
          bucket.totalSpending += Number(job.amount) || 0;
        }
        if (job.acceptedBy) {
          bucket.workersList.push(job.acceptedBy);
        }
      }

      const stats = Array.from(dayMap.values())
        .map((s) => ({
          ...s,
          workersList: [...new Set(s.workersList.filter(Boolean))],
          workersEngaged: [...new Set(s.workersList.filter(Boolean))].length,
        }))
        .sort((a, b) => new Date(b.date) - new Date(a.date));

      const aggregated = {
        totalJobsPosted: stats.reduce((sum, s) => sum + s.jobsPosted, 0),
        totalJobsCompleted: stats.reduce((sum, s) => sum + s.jobsCompleted, 0),
        totalWorkersEngaged: new Set(stats.flatMap((s) => s.workersList || [])).size,
        totalSpending: stats.reduce((sum, s) => sum + s.totalSpending, 0),
        avgJobsPerDay:
          stats.length > 0
            ? (stats.reduce((sum, s) => sum + s.jobsPosted, 0) / stats.length).toFixed(2)
            : 0,
        avgCompletionPerDay:
          stats.length > 0
            ? (stats.reduce((sum, s) => sum + s.jobsCompleted, 0) / stats.length).toFixed(2)
            : 0,
      };

      return res.json({ success: true, stats, aggregated, range });
    } catch (err) {
      console.error("Fetch stats error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/contractor/stats/range", authenticateToken, async (req, res) => {
    try {
      const { phone } = req.user;
      const { startDate, endDate } = req.query;

      if (!startDate || !endDate) {
        return res.status(400).json({ success: false, message: "startDate and endDate required" });
      }

      const stats = await ContractorStats.find({
        phone,
        date: {
          $gte: new Date(startDate),
          $lte: new Date(endDate),
        },
      }).sort({ date: 1 });

      return res.json({ success: true, stats });
    } catch (err) {
      console.error("Fetch range stats error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.post("/contractor/stats/update-from-jobs", authenticateToken, async (req, res) => {
    try {
      const { phone } = req.user;
      const jobs = await Job.find({
        contractorPhone: phone,
        isCancelled: { $ne: true },
        status: { $ne: "cancelled" },
      });

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todayJobs = jobs.filter((j) => {
        const jDate = new Date(j.createdAt);
        jDate.setHours(0, 0, 0, 0);
        return jDate.getTime() === today.getTime();
      });
      const jobsPosted = todayJobs.length;
      const jobsCompleted = todayJobs.filter((j) => j.attendanceStatus && j.paymentStatus === "Paid").length;
      const workersList = [...new Set(todayJobs.map((j) => j.acceptedBy))];
      const workersEngaged = workersList.length;
      const totalSpending = todayJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);

      const jobDetails = todayJobs.map((j) => ({
        jobId: j._id,
        title: j.title,
        workerName: j.acceptedBy,
        amount: j.amount,
        status: j.status,
        paymentStatus: j.paymentStatus,
        timestamp: j.createdAt,
      }));

      let stats = await ContractorStats.findOne({ phone, date: today });
      if (stats) {
        stats.jobsPosted = jobsPosted;
        stats.jobsCompleted = jobsCompleted;
        stats.workersEngaged = workersEngaged;
        stats.totalSpending = totalSpending;
        stats.workersList = workersList;
        stats.jobDetails = jobDetails;
        stats.updatedAt = new Date();
      } else {
        stats = new ContractorStats({
          phone,
          date: today,
          jobsPosted,
          jobsCompleted,
          workersEngaged,
          totalSpending,
          workersList,
          jobDetails,
        });
      }

      await stats.save();
      return res.json({ success: true, stats, message: "Stats updated from jobs" });
    } catch (err) {
      console.error("Update stats from jobs error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  return router;
}

module.exports = { createContractorStatsRouter };
