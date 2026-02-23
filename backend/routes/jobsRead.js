const express = require("express");

function createJobsReadRouter({ authenticateToken, Job, getDistanceFromLatLonInKm }) {
  const router = express.Router();

  router.post("/jobs/nearby", authenticateToken, async (req, res) => {
    try {
      const { lat, lon, workerType } = req.body;
      const workerPhone = req.user.phone;
      const workerName = req.user.name;
      const MAX_RADIUS_KM = 10;

      let jobs = await Job.find();

      const hasActiveUnpaidJob = jobs.some(
        (job) => (job.acceptedBy === workerPhone || job.acceptedWorkers?.some((w) => w.phone === workerPhone)) && job.paymentStatus !== "Paid"
      );

      if (hasActiveUnpaidJob) {
        console.log(`Worker ${workerName} (${workerPhone}) has unpaid job - blocking new job offers`);
        return res.json([]);
      }

      const availableJobs = jobs.filter(
        (j) =>
          j.status !== "accepted" &&
          (!workerType || j.workerType?.toLowerCase() === workerType?.toLowerCase()) &&
          !(j.declinedBy && j.declinedBy.includes(workerName))
      );

      const jobsWithDistance = [];
      for (const j of availableJobs) {
        const distanceToJob = getDistanceFromLatLonInKm(lat, lon, j.lat, j.lon);

        if (distanceToJob > MAX_RADIUS_KM) continue;

        const distanceToContractor = distanceToJob;
        jobsWithDistance.push({
          ...j.toObject ? j.toObject() : j,
          distanceToJob,
          distanceToContractor,
        });
      }

      jobsWithDistance.sort((a, b) => {
        if (a.distanceToContractor !== b.distanceToContractor) {
          return a.distanceToContractor - b.distanceToContractor;
        }
        return a.distanceToJob - b.distanceToJob;
      });

      return res.json(jobsWithDistance);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ message: "Internal server error" });
    }
  });

  router.get("/jobs", authenticateToken, async (req, res) => {
    try {
      const userRole = req.user.role;

      let jobs;
      if (userRole === "contractor") {
        jobs = await Job.find({ contractorName: req.user.name });
      } else {
        return res.json([]);
      }

      res.json(jobs);
    } catch (err) {
      console.error("Failed to load jobs", err);
      res.status(500).json({ message: "Failed to load jobs" });
    }
  });

  router.get("/jobs/my-accepted", authenticateToken, async (req, res) => {
    try {
      const workerName = req.user.name;
      const workerPhone = req.user.phone;

      console.log(`\n[/jobs/my-accepted] Request from ${workerName} (${workerPhone})`);

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const pageSize = Math.min(limit, 100);
      const skip = (page - 1) * pageSize;

      // Include both single and bulk jobs for this worker.
      // Keep cancelled/expired too so history screens can show full lifecycle.
      const myAcceptedFilter = {
        $or: [
          { acceptedBy: workerPhone },
          { "acceptedWorkers.phone": workerPhone },
        ],
      };
      const totalCount = await Job.countDocuments(myAcceptedFilter);

      const jobs = await Job.find(myAcceptedFilter)
        .sort({ date: -1 })
        .skip(skip)
        .limit(pageSize)
        .lean();

      jobs.forEach((job) => {
        if (job.rating) {
          console.log(`   Job ${job._id} with rating:`, job.rating);
        }
      });

      const response = {
        gigs: jobs,
        page,
        limit: pageSize,
        totalCount,
        totalPages: Math.ceil(totalCount / pageSize),
        hasMore: skip + pageSize < totalCount,
      };

      res.json(response);
    } catch (err) {
      console.error("Failed to load worker's accepted jobs:", err);
      res.status(500).json({ success: false, message: "Failed to load jobs", error: err.message });
    }
  });

  router.get("/jobs/by-id/:id", authenticateToken, async (req, res) => {
    try {
      const jobId = req.params.id;
      const workerPhone = req.user?.phone;

      let job = await Job.findById(jobId).lean();
      if (!job) {
        job = await Job.findOne({ id: jobId }).lean();
      }
      if (!job) {
        return res.status(404).json({ success: false, message: "Job not found" });
      }

      const notVisibleStatuses = new Set(["cancelled", "expired"]);
      if (notVisibleStatuses.has(job.status || "")) {
        return res.status(404).json({ success: false, message: "Job not available" });
      }

      if (job.status === "accepted" && workerPhone && job.acceptedBy && job.acceptedBy !== workerPhone) {
        return res.status(404).json({ success: false, message: "Job not available" });
      }

      return res.json({ success: true, job });
    } catch (err) {
      console.error("Failed to fetch job by id", err);
      return res.status(500).json({ success: false, message: "Failed to fetch job" });
    }
  });

  return router;
}

module.exports = {
  createJobsReadRouter,
};
