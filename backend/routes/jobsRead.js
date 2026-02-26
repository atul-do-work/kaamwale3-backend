const express = require("express");

function createJobsReadRouter({ authenticateToken, Job, getDistanceFromLatLonInKm }) {
  const router = express.Router();
  const setNoStore = (res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    res.set('Surrogate-Control', 'no-store');
  };
  const normalizeStatus = (v) => String(v || "").trim().toLowerCase();
  const normalizeJobForApi = (job) => {
    if (!job || typeof job !== "object") return job;
    const copy = { ...job };
    copy.status = normalizeStatus(copy.status);
    copy.paymentStatus = normalizeStatus(copy.paymentStatus);
    if (Array.isArray(copy.acceptedWorkers)) {
      copy.acceptedWorkers = copy.acceptedWorkers.map((w) => ({
        ...w,
        paymentStatus: normalizeStatus(w?.paymentStatus),
      }));
    }
    return copy;
  };

  router.post("/jobs/nearby", authenticateToken, async (req, res) => {
    try {
      const { lat, lon, workerType } = req.body;
      const latNum = Number(lat);
      const lonNum = Number(lon);
      const workerPhone = req.user.phone;
      const MAX_RADIUS_KM = 10;
      const maxDistanceMeters = MAX_RADIUS_KM * 1000;

      if (!Number.isFinite(latNum) || !Number.isFinite(lonNum)) {
        return res.status(400).json({ success: false, message: "Valid lat/lon required" });
      }

      const hasActiveUnpaidJob = await Job.exists({
        $and: [
          {
            $or: [
              { acceptedBy: workerPhone },
              { "acceptedWorkers.phone": workerPhone },
            ],
          },
          { paymentStatus: { $ne: "paid" } },
          { status: { $nin: ["cancelled", "expired"] } },
        ],
      });

      if (hasActiveUnpaidJob) {
        console.log(`Worker (${workerPhone}) has unpaid job - blocking new job offers`);
        return res.json([]);
      }

      const nearbyQuery = {
        $and: [
          { status: { $in: ["pending", "posted", "offered"] } },
          { isCancelled: { $ne: true } },
          { paymentStatus: { $ne: "paid" } },
          // Canonical decline identity is worker phone.
          { declinedBy: { $nin: [workerPhone] } },
          {
            jobLocation: {
              $nearSphere: {
                $geometry: { type: "Point", coordinates: [lonNum, latNum] },
                $maxDistance: maxDistanceMeters,
              },
            },
          },
        ],
      };

      if (workerType) {
        nearbyQuery.$and.push({ workerType: { $regex: `^${String(workerType).trim()}$`, $options: "i" } });
      }

      const availableJobs = await Job.find(nearbyQuery).lean();

      const jobsWithDistance = [];
      for (const j of availableJobs) {
        const jobLat = Number.isFinite(j.lat) ? j.lat : (Array.isArray(j.jobLocation?.coordinates) ? j.jobLocation.coordinates[1] : null);
        const jobLon = Number.isFinite(j.lon) ? j.lon : (Array.isArray(j.jobLocation?.coordinates) ? j.jobLocation.coordinates[0] : null);
        if (!Number.isFinite(jobLat) || !Number.isFinite(jobLon)) continue;

        const distanceToJob = getDistanceFromLatLonInKm(latNum, lonNum, jobLat, jobLon);

        if (distanceToJob > MAX_RADIUS_KM) continue;

        const distanceToContractor = distanceToJob;
        jobsWithDistance.push({
          ...j,
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
      setNoStore(res);
      const requesterPhone = String(req.user?.phone || "").trim();
      const requesterDigits = requesterPhone.replace(/\D/g, "").slice(-10);
      if (!requesterPhone && !requesterDigits) {
        return res.json([]);
      }
      // Canonical ownership is contractor phone; do not depend on role-casing in JWT.
      // Accept exact, normalized-10-digit, and +91-suffixed storage variants.
      const phoneVariants = Array.from(
        new Set([requesterPhone, requesterDigits].filter(Boolean))
      );
      const jobs = await Job.find({
        $or: [
          { contractorPhone: { $in: phoneVariants } },
          ...(requesterDigits
            ? [{ contractorPhone: { $regex: `${requesterDigits}$` } }]
            : []),
        ],
      }).lean();

      res.json((jobs || []).map(normalizeJobForApi));
    } catch (err) {
      console.error("Failed to load jobs", err);
      res.status(500).json({ message: "Failed to load jobs" });
    }
  });

  router.get("/jobs/my-accepted", authenticateToken, async (req, res) => {
    try {
      setNoStore(res);
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

      res.json({
        ...response,
        gigs: (response.gigs || []).map(normalizeJobForApi),
      });
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

      return res.json({ success: true, job: normalizeJobForApi(job) });
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
