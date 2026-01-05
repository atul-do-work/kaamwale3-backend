// controllers/jobController.js
const path = require("path");
const { getDistanceFromLatLonInKm } = require("../utils/distance");

// Use global helpers from server.js: loadJobs / saveJobs
// (Alternatively require a shared persistence module)

function readJobs() {
  return global.loadJobs();
}

function writeJobs(jobs) {
  global.saveJobs(jobs);
}

function postJob(req, res) {
  const { title, description = "", amount = "", contractorName, lat, lon, workerType = "", date = null } = req.body;

  if (!title || !contractorName || typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({ success: false, message: "title, contractorName, lat, lon required" });
  }

  const jobs = readJobs();
  const newId = jobs.length ? Math.max(...jobs.map(j => j.id)) + 1 : 1;

  const newJob = {
    id: newId,
    title,
    description,
    amount,
    contractorName,
    workerType,
    lat,
    lon,
    date,
    timestamp: new Date().toISOString(),
    acceptedBy: null,
    declinedBy: [],
    status: "pending"
  };

  jobs.push(newJob);
  writeJobs(jobs);
  return res.status(201).json({ success: true, job: newJob });
}

function getNearbyJobs(req, res) {
  const { lat, lon, workerName } = req.body;
  if (typeof lat !== "number" || typeof lon !== "number") {
    return res.status(400).json({ success: false, message: "lat and lon required (numbers)" });
  }

  const jobs = readJobs();

  const possible = jobs
    .filter(job => {
      if (job.status !== "pending") return false;
      job.declinedBy = Array.isArray(job.declinedBy) ? job.declinedBy : [];
      if (workerName && job.declinedBy.includes(workerName)) return false;
      if (typeof job.lat !== "number" || typeof job.lon !== "number") return false;
      const d = getDistanceFromLatLonInKm(lat, lon, job.lat, job.lon);
      return d <= 5;
    })
    .map(job => {
      const distanceKm = getDistanceFromLatLonInKm(lat, lon, job.lat, job.lon);
      return { ...job, distanceKm };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);

  // return array (closest first)
  return res.json(possible);
}

function acceptJob(req, res) {
  const jobId = parseInt(req.params.id);
  const { workerName } = req.body;
  if (!workerName) return res.status(400).json({ success: false, message: "workerName required" });

  const jobs = readJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ success: false, message: "Job not found" });
  if (job.status !== "pending") return res.status(400).json({ success: false, message: "Job not available" });

  job.acceptedBy = workerName;
  job.status = "accepted";
  writeJobs(jobs);
  return res.json({ success: true, job });
}

function declineJob(req, res) {
  const jobId = parseInt(req.params.id);
  const { workerName } = req.body;
  if (!workerName) return res.status(400).json({ success: false, message: "workerName required" });

  const jobs = readJobs();
  const job = jobs.find(j => j.id === jobId);
  if (!job) return res.status(404).json({ success: false, message: "Job not found" });
  job.declinedBy = Array.isArray(job.declinedBy) ? job.declinedBy : [];
  if (!job.declinedBy.includes(workerName)) job.declinedBy.push(workerName);
  // keep status pending so other workers can receive it
  writeJobs(jobs);
  return res.json({ success: true, job });
}

// Debug: get all jobs
function getAllJobs(req, res) {
  return res.json(readJobs());
}

module.exports = { postJob, getNearbyJobs, acceptJob, declineJob, getAllJobs };
