function createUpdateContractorStats({ Job, ContractorStats }) {
  return async function updateContractorStats(phone) {
    try {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const todayJobs = await Job.find({
        contractorPhone: phone,
        createdAt: { $gte: today },
        isCancelled: { $ne: true },
      });

      const jobsPosted = todayJobs.length;
      const jobsCompleted = todayJobs.filter((j) => {
        // For single jobs: check attendance and payment
        if (j.acceptedBy && !Array.isArray(j.acceptedWorkers)) {
          return j.attendanceStatus && String(j.paymentStatus || "").toLowerCase() === "paid";
        }
        // For bulk jobs: check if any worker has attendance 'Present' and payment 'paid'
        if (Array.isArray(j.acceptedWorkers)) {
          return j.acceptedWorkers.some(w => w?.attendanceStatus === 'Present' && String(w?.paymentStatus || "").toLowerCase() === "paid");
        }
        return false;
      }).length;
      const workersList = [
        ...new Set(
          todayJobs.flatMap((j) => {
            const workers = [];
            // Handle single jobs
            if (j.acceptedBy && !Array.isArray(j.acceptedWorkers)) {
              if (j.attendanceStatus && String(j.paymentStatus || "").toLowerCase() === "paid") {
                workers.push(j.acceptedBy);
              }
            }
            // Handle bulk jobs - only count workers who have been marked present and paid
            if (Array.isArray(j.acceptedWorkers)) {
              j.acceptedWorkers.forEach((w) => {
                if (w?.phone && w.attendanceStatus === 'Present' && String(w.paymentStatus || "").toLowerCase() === "paid") {
                  workers.push(w.phone);
                }
              });
            }
            return workers;
          })
        ),
      ];
      const totalSpending = todayJobs
        .filter((j) => {
          // For single jobs
          if (j.acceptedBy && !Array.isArray(j.acceptedWorkers)) {
            return String(j.paymentStatus || "").toLowerCase() === "paid";
          }
          // For bulk jobs: check if any worker is paid
          if (Array.isArray(j.acceptedWorkers)) {
            return j.acceptedWorkers.some(w => String(w?.paymentStatus || "").toLowerCase() === "paid");
          }
          return false;
        })
        .reduce((sum, j) => sum + (Number(j.amount) || 0), 0);

      let stats = await ContractorStats.findOne({ phone, date: today });
      if (stats) {
        stats.jobsPosted = jobsPosted;
        stats.jobsCompleted = jobsCompleted;
        stats.workersEngaged = [...new Set(workersList)].length; // Deduplicate workers
        stats.totalSpending = totalSpending;
        stats.workersList = [...new Set(workersList)]; // Store deduplicated list
        stats.updatedAt = new Date();
      } else {
        stats = new ContractorStats({
          phone,
          date: today,
          jobsPosted,
          jobsCompleted,
          workersEngaged: [...new Set(workersList)].length, // Deduplicate workers
          totalSpending,
          workersList: [...new Set(workersList)], // Store deduplicated list
          jobDetails: [],
        });
      }
      await stats.save();
      console.log(`Stats: ${jobsPosted} posted, ${jobsCompleted} completed, ${workersList.length} workers`);
    } catch (err) {
      console.error("Error updating contractor stats:", err);
    }
  };
}

function createEmitEventToUsers({ io, connectedWorkers }, eventName) {
  return async function emitEventToUsers(payload, userIdentifiers = []) {
    try {
      if (!userIdentifiers || userIdentifiers.length === 0) {
        io.emit(eventName, payload);
        return;
      }

      const ids = userIdentifiers.filter(Boolean).map((i) => i.toString());
      const sentSockets = new Set();

      for (const [socketId, worker] of connectedWorkers.entries()) {
        if (!worker) continue;
        if (ids.includes(worker.phone?.toString()) || ids.includes(worker.id?.toString())) {
          const targetSocket = io.sockets.sockets.get(socketId);
          if (targetSocket) {
            targetSocket.emit(eventName, payload);
            sentSockets.add(socketId);
          }
        }
      }

      for (const [socketId, socket] of io.sockets.sockets.entries()) {
        if (sentSockets.has(socketId)) continue;

        try {
          const user = socket.data?.user;
          if (user && (ids.includes(user.phone?.toString()) || ids.includes(user.id?.toString()))) {
            socket.emit(eventName, payload);
            sentSockets.add(socketId);
          }
        } catch (e) {
          // Ignore sockets without usable auth payload.
        }
      }
    } catch (e) {
      console.error(`Error emitting targeted ${eventName}:`, e);
      try {
        io.emit(eventName, payload);
      } catch (err) {
        console.error(`Fallback broadcast failed for ${eventName}`, err);
      }
    }
  };
}

function createEmitJobUpdatedToUsers({ io, connectedWorkers }) {
  return createEmitEventToUsers({ io, connectedWorkers }, "jobUpdated");
}

function createEmitJobCancelledToUsers({ io, connectedWorkers }) {
  return createEmitEventToUsers({ io, connectedWorkers }, "jobCancelled");
}

module.exports = {
  createUpdateContractorStats,
  createEmitJobUpdatedToUsers,
  createEmitJobCancelledToUsers,
};
