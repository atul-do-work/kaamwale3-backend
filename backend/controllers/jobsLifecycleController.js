const jobsLifecycleService = require("../services/jobsLifecycleService");

function createJobsLifecycleController(deps) {
  return {
    markAttendance: async (req, res) => {
      try {
        const result = await jobsLifecycleService.markAttendance({
          jobId: req.params.id,
          status: req.body.status,
          workerPhone: req.body.workerPhone,
          userPhone: req.user.phone,
          deps,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    },

    payJob: async (req, res) => {
      try {
        const result = await jobsLifecycleService.payJob({
          jobId: req.params.id,
          mode: req.body.mode,
          workerPhone: req.body.workerPhone,
          idempotencyKey: req.headers["x-idempotency-key"] || req.body.idempotencyKey,
          userPhone: req.user.phone,
          userName: req.user.name,
          deps,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    },

    depositCash: async (req, res) => {
      try {
        const result = await jobsLifecycleService.depositCash({
          jobId: req.params.id,
          workerPhone: req.user.phone,
          idempotencyKey: req.headers["x-idempotency-key"] || req.body.idempotencyKey,
          deps,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    },

    depositCashById: async (req, res) => {
      try {
        const result = await jobsLifecycleService.depositCashById({
          depositId: req.params.id,
          workerPhone: req.user.phone,
          idempotencyKey: req.headers["x-idempotency-key"] || req.body.idempotencyKey,
          deps,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    },

    getCashDeposits: async (req, res) => {
      try {
        const result = await jobsLifecycleService.getCashDeposits({
          workerPhone: req.user.phone,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    },

    rateJob: async (req, res) => {
      try {
        const result = await jobsLifecycleService.rateJob({
          jobId: req.params.id,
          stars: req.body.stars,
          feedback: req.body.feedback,
          workerPhone: req.body.workerPhone,
          userPhone: req.user.phone,
          userName: req.user.name,
          deps,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    },

    rateContractor: async (req, res) => {
      try {
        const result = await jobsLifecycleService.rateContractor({
          jobId: req.params.id,
          stars: req.body.stars,
          feedback: req.body.feedback,
          userPhone: req.user.phone,
          userName: req.user.name,
          deps,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error(err);
        return res.status(500).json({ success: false, message: "Internal server error" });
      }
    },

    cancelJob: async (req, res) => {
      try {
        const result = await jobsLifecycleService.cancelJob({
          jobId: req.params.id,
          reason: req.body.reason,
          reasonDescription: req.body.reasonDescription,
          idempotencyKey: req.headers["x-idempotency-key"] || req.body.idempotencyKey,
          userPhone: req.user.phone,
          deps,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error("Job cancellation error:", err);
        return res.status(500).json({ success: false, message: "Error cancelling job" });
      }
    },

    getCancellations: async (req, res) => {
      try {
        const result = await jobsLifecycleService.getCancellations({
          userPhone: req.user.phone,
        });
        return res.status(result.code).json(result.body);
      } catch (err) {
        console.error("Fetch cancellations error:", err);
        return res.status(500).json({ success: false, message: "Error fetching cancellations" });
      }
    },
  };
}

module.exports = { createJobsLifecycleController };
