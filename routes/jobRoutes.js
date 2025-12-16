const express = require('express');
const router = express.Router();
const { postJob, getNearbyJobs, acceptJob, declineJob } = require('../controllers/jobController');

// Post a new job (Contractor)
router.post('/post', postJob);

// Get nearby jobs for worker
router.post('/nearby', getNearbyJobs);

// Accept a job (Worker)
router.post('/accept/:id', acceptJob);

// Decline a job (Worker)
router.post('/decline/:id', declineJob);

module.exports = router;
