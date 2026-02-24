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
      const jobsCompleted = todayJobs.filter((j) => j.attendanceStatus && j.paymentStatus === "Paid").length;
      const workersList = [...new Set(todayJobs.map((j) => j.acceptedBy).filter(Boolean))];
      const totalSpending = todayJobs.reduce((sum, j) => sum + (Number(j.amount) || 0), 0);

      let stats = await ContractorStats.findOne({ phone, date: today });
      if (stats) {
        stats.jobsPosted = jobsPosted;
        stats.jobsCompleted = jobsCompleted;
        stats.workersEngaged = workersList.length;
        stats.totalSpending = totalSpending;
        stats.workersList = workersList;
        stats.updatedAt = new Date();
      } else {
        stats = new ContractorStats({
          phone,
          date: today,
          jobsPosted,
          jobsCompleted,
          workersEngaged: workersList.length,
          totalSpending,
          workersList,
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
        if (ids.includes(worker.name?.toString()) || ids.includes(worker.phone?.toString())) {
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
          if (user && (ids.includes(user.name?.toString()) || ids.includes(user.phone?.toString()))) {
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
