const express = require("express");
const { authenticateToken } = require("../utils/auth");
const ContractorStats = require("../models/ContractorStats");
const Job = require("../models/Jobs");

const normalizePaymentStatus = (status) => String(status || "").trim().toLowerCase();
const isPaidStatus = (status) => normalizePaymentStatus(status) === "paid";

const resolveJobDate = (job, fallback = new Date(0)) => {
  const raw = job?.createdAt || job?.timestamp || job?.date || job?.updatedAt;
  const parsed = raw ? new Date(raw) : fallback;
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
};

const buildContractorJobQuery = ({ phone, startDate, endDate }) => ({
  contractorPhone: phone,
  createdAt: { $gte: startDate, $lte: endDate },
  isCancelled: { $ne: true },
  status: { $ne: "cancelled" },
});

const statsJobDetailsLimit = 200;

const buildStatsFromJobs = (jobs, phone) => {
  const dayMap = new Map();

  for (const job of jobs) {
    const jobDate = resolveJobDate(job, new Date());
    jobDate.setHours(0, 0, 0, 0);
    const dayKey = jobDate.toISOString();

    if (!dayMap.has(dayKey)) {
      dayMap.set(dayKey, {
        phone,
        date: new Date(jobDate),
        jobsPosted: 0,
        jobsCompleted: 0,
        workersList: [],
        totalSpending: 0,
      });
    }

    const bucket = dayMap.get(dayKey);
    bucket.jobsPosted += 1;
    if (isPaidStatus(job.paymentStatus)) {
      bucket.jobsCompleted += 1;
      bucket.totalSpending += Number(job.amount) || 0;
    }
    if (job.acceptedBy) {
      bucket.workersList.push(job.acceptedBy);
    }
    if (Array.isArray(job.acceptedWorkers)) {
      for (const w of job.acceptedWorkers) {
        if (w?.phone && (w.attendanceStatus === "Present" || isPaidStatus(w.paymentStatus))) {
          bucket.workersList.push(w.phone);
        }
      }
    }
  }

  return Array.from(dayMap.values()).map((s) => {
    const uniqueWorkers = [...new Set(s.workersList.filter(Boolean))];
    return {
      ...s,
      workersList: uniqueWorkers,
      workersEngaged: uniqueWorkers.length,
    };
  }).sort((a, b) => new Date(b.date) - new Date(a.date));
};

const buildJobDetails = (jobs) =>
  jobs.slice(0, statsJobDetailsLimit).map((j) => ({
    jobId: j._id,
    title: j.title,
    workerName: j.acceptedBy,
    amount: j.amount,
    status: j.status,
    paymentStatus: j.paymentStatus,
    timestamp: j.createdAt,
  }));

const aggregateStats = (stats) => ({
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
});

function createContractorStatsRouter() {
  const router = express.Router();

  router.post("/contractor/stats/save", authenticateToken, async (req, res) => {
    try {
      const { phone } = req.user;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today);
      endOfDay.setHours(23, 59, 59, 999);

      const jobs = await Job.find(
        buildContractorJobQuery({ phone, startDate: today, endDate: endOfDay })
      )
        .select("createdAt timestamp date updatedAt status paymentStatus amount acceptedBy acceptedWorkers title attendanceStatus")
        .lean();

      const statsArray = buildStatsFromJobs(jobs, phone);
      const todayStats = statsArray.find((item) => item.date.getTime() === today.getTime()) || {
        phone,
        date: today,
        jobsPosted: 0,
        jobsCompleted: 0,
        workersList: [],
        totalSpending: 0,
        workersEngaged: 0,
      };

      const jobDetails = jobs.slice(0, statsJobDetailsLimit).map((j) => ({
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
        stats.jobsPosted = todayStats.jobsPosted;
        stats.jobsCompleted = todayStats.jobsCompleted;
        stats.workersEngaged = todayStats.workersEngaged;
        stats.totalSpending = todayStats.totalSpending;
        stats.jobDetails = jobDetails;
        stats.workersList = todayStats.workersList;
        stats.updatedAt = new Date();
      } else {
        stats = new ContractorStats({
          phone,
          date: today,
          jobsPosted: todayStats.jobsPosted,
          jobsCompleted: todayStats.jobsCompleted,
          workersEngaged: todayStats.workersEngaged,
          totalSpending: todayStats.totalSpending,
          jobDetails,
          workersList: todayStats.workersList,
        });
      }

      await stats.save();
      return res.json({ success: true, stats, message: "Stats saved successfully from jobs" });
    } catch (err) {
      console.error("Save stats error", err);
      return res.status(500).json({ success: false, message: "Internal server error" });
    }
  });

  router.get("/contractor/stats", authenticateToken, async (req, res) => {
    try {
      const { phone } = req.user;
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

      // Filter in DB using indexed contractorPhone + createdAt, then aggregate in memory.
      const jobs = await Job.find(
        buildContractorJobQuery({ phone, startDate, endDate })
      )
        .select("createdAt timestamp date updatedAt status paymentStatus amount acceptedBy acceptedWorkers title")
        .lean();

      const stats = buildStatsFromJobs(jobs, phone);
      const aggregated = aggregateStats(stats);

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
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const endOfDay = new Date(today);
      endOfDay.setHours(23, 59, 59, 999);

      // Only load today's contractor jobs from the DB, using indexed contractorPhone + createdAt.
      const todayJobs = await Job.find(
        buildContractorJobQuery({ phone, startDate: today, endDate: endOfDay })
      )
        .select("createdAt timestamp date updatedAt status paymentStatus amount acceptedBy acceptedWorkers title attendanceStatus")
        .lean();

      const statsArray = buildStatsFromJobs(todayJobs, phone);
      const todayStats =
        statsArray.find((item) => item.date.getTime() === today.getTime()) ||
        {
          phone,
          date: today,
          jobsPosted: 0,
          jobsCompleted: 0,
          workersList: [],
          totalSpending: 0,
          workersEngaged: 0,
        };
      const jobsPosted = todayStats.jobsPosted;
      const jobsCompleted = todayStats.jobsCompleted;
      const workersList = todayStats.workersList;
      const workersEngaged = todayStats.workersEngaged;
      const totalSpending = todayStats.totalSpending;

      const jobDetails = buildJobDetails(todayJobs);

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
