const express = require("express");
const { authenticateToken } = require("../utils/auth");
const { createJobsLifecycleController } = require("../controllers/jobsLifecycleController");

function createJobsLifecycleRouter(deps) {
  const router = express.Router();
  const controller = createJobsLifecycleController(deps);

  router.post("/jobs/attendance/:id", authenticateToken, controller.markAttendance);
  router.post("/jobs/pay/:id", authenticateToken, controller.payJob);
  router.post("/jobs/rate/:id", authenticateToken, controller.rateJob);
  router.post("/jobs/cancel/:id", authenticateToken, controller.cancelJob);
  router.get("/jobs/cancellations", authenticateToken, controller.getCancellations);

  return router;
}

module.exports = { createJobsLifecycleRouter };
