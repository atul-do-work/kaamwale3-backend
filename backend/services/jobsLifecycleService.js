const Job = require("../models/Jobs");
const WorkerModel = require("../models/Worker");
const Wallet = require("../models/Wallet");
const NotificationHistory = require("../models/NotificationHistory");
const CancellationLog = require("../models/CancellationLog");
const ActivityLog = require("../models/ActivityLog");
const { updateGigDataOnCompletion } = require("../utils/gigsDataTracker");

async function markAttendance({ jobId, status, userPhone, deps }) {
  const { trackingJobs, emitJobUpdatedToUsers, logJobEvent } = deps;
  const job = await Job.findById(jobId);
  if (!job) return { code: 404, body: { message: "Job not found" } };

  const oldState = { status: job.status, attendanceStatus: job.attendanceStatus, paymentStatus: job.paymentStatus };
  job.attendanceStatus = status;
  job.attendanceTime = new Date();
  if (status === "Present" && job.status === "accepted") {
    job.status = "in_progress";
  }
  await job.save();

  await logJobEvent({
    jobId: job._id,
    eventType: status === "Present" ? "job_started" : "attendance_marked",
    actorType: "contractor",
    actorPhone: userPhone,
    source: "app",
    oldState,
    newState: { status: job.status, attendanceStatus: job.attendanceStatus, paymentStatus: job.paymentStatus },
    metadata: { attendanceTime: job.attendanceTime },
  });

  if (trackingJobs.has(jobId)) trackingJobs.delete(jobId);
  await emitJobUpdatedToUsers(job, [job.contractorName, job.acceptedBy || job.contractorName]);
  return { code: 200, body: { success: true, job } };
}

async function payJob({ jobId, mode, userPhone, userName, deps }) {
  const { updateContractorStats, emitJobUpdatedToUsers, logJobEvent } = deps;
  const job = await Job.findById(jobId);
  if (!job) return { code: 404, body: { message: "Job not found" } };

  if (job.attendanceStatus !== "Present") {
    return { code: 400, body: { success: false, message: "Payment allowed only for PRESENT workers" } };
  }

  const oldState = { status: job.status, paymentStatus: job.paymentStatus, paymentMode: job.paymentMode };
  job.paymentStatus = "Paid";
  job.paymentMode = mode;
  job.paymentTime = new Date();
  if (job.status === "accepted" || job.status === "in_progress") {
    job.status = "completed";
  }
  if (job.acceptedAt) {
    const timeSpentMs = job.paymentTime - job.acceptedAt;
    job.timeSpentMinutes = Math.round(timeSpentMs / 60000);
  }
  await job.save();

  await logJobEvent({
    jobId: job._id,
    eventType: "job_completed",
    actorType: "contractor",
    actorPhone: userPhone,
    source: "app",
    oldState,
    newState: {
      status: job.status,
      paymentStatus: job.paymentStatus,
      paymentMode: job.paymentMode,
      paymentTime: job.paymentTime,
    },
    metadata: { amount: job.amount },
  });

  try {
    if (job.acceptedBy) {
      const worker = await WorkerModel.findOne({ phone: job.acceptedBy });
      if (worker && typeof worker.recordWork === "function") {
        const hoursWorked = (job.timeSpentMinutes || 0) / 60;
        worker.recordWork(job.paymentTime || new Date(), hoursWorked, false);
        await worker.save();
      }
    }
  } catch (recErr) {
    console.error("Error recording worker work on payment:", recErr);
  }

  try {
    if (job.acceptedWorker && job.acceptedWorker.phone) {
      await NotificationHistory.create({
        recipientPhone: job.acceptedWorker.phone,
        senderPhone: userPhone,
        senderName: userName || job.contractorName || "Contractor",
        type: "payment_received",
        title: `Payment Received: ₹${job.amount}`,
        body: `Payment for ${job.title} has been transferred to your wallet`,
        jobId: job._id,
        metadata: {
          jobTitle: job.title,
          amount: job.amount,
          actionRequired: false,
        },
        deepLink: "worker/wallet",
        pushNotificationSent: false,
      });
    }
  } catch (e) {
    console.error("Error creating payment notification:", e);
  }

  try {
    let workerWallet = await Wallet.findOne({ phone: job.acceptedBy });
    if (!workerWallet) workerWallet = new Wallet({ phone: job.acceptedBy, balance: 0 });
    workerWallet.balance += Number(job.amount);
    workerWallet.transactions.push({
      type: "payment",
      amount: Number(job.amount),
      date: new Date(),
      jobId: job._id,
      source: "app",
      provider: "internal",
      status: "completed",
    });
    await workerWallet.save();
  } catch (walletErr) {
    console.error("Error updating worker wallet after payment:", walletErr);
  }

  await updateContractorStats(userPhone);

  try {
    await updateGigDataOnCompletion(job.acceptedBy, {
      jobId: job._id.toString(),
      title: job.title,
      amount: job.amount,
      workerType: job.workerType,
      timeSpentMinutes: job.timeSpentMinutes || 0,
    });
  } catch (e) {
    console.error("Error updating gigs data on completion:", e);
  }

  await emitJobUpdatedToUsers(job, [job.contractorName, job.acceptedBy || job.contractorName]);
  return { code: 200, body: { success: true, message: "Payment successful", job } };
}

async function rateJob({ jobId, stars, feedback, userPhone, userName, deps }) {
  const { emitJobUpdatedToUsers } = deps;
  if (!stars || stars < 1 || stars > 5) {
    return { code: 400, body: { message: "Rating must be between 1 and 5 stars" } };
  }

  const job = await Job.findById(jobId);
  if (!job) return { code: 404, body: { message: "Job not found" } };

  if (job.paymentStatus !== "Paid") {
    return { code: 400, body: { message: "Can only rate jobs that have been paid" } };
  }
  if (job.attendanceStatus !== "Present") {
    return { code: 400, body: { message: "Can only rate workers marked as Present" } };
  }

  job.rating = {
    stars: parseInt(stars, 10),
    feedback: feedback || "",
    ratedAt: new Date(),
    ratedBy: userPhone || job.contractorName,
  };
  await job.save();

  try {
    if (job.acceptedWorker && job.acceptedWorker.phone) {
      const workerPhone = job.acceptedWorker.phone;
      const ratedJobs = await Job.find({
        $or: [{ "acceptedWorker.phone": workerPhone }, { acceptedBy: workerPhone }],
        paymentStatus: "Paid",
        "rating.stars": { $exists: true, $ne: null },
      });

      if (ratedJobs.length > 0) {
        const totalStars = ratedJobs.reduce((sum, j) => sum + (j.rating?.stars || 0), 0);
        const averageRating = totalStars / ratedJobs.length;
        await WorkerModel.findOneAndUpdate(
          { phone: workerPhone },
          {
            $set: {
              "performanceMetrics.averageRating": Math.round(averageRating * 10) / 10,
              "performanceMetrics.totalReviews": ratedJobs.length,
              rating: Math.round(averageRating * 10) / 10,
            },
          },
          { new: true }
        );
      }
    }
  } catch (err) {
    console.error("Error updating worker average rating:", err);
  }

  try {
    if (job.acceptedWorker && job.acceptedWorker.phone) {
      const ratingText = `${stars} star${stars > 1 ? "s" : ""}`;
      await NotificationHistory.create({
        recipientPhone: job.acceptedWorker.phone,
        senderPhone: userPhone,
        senderName: userName || job.contractorName || "Contractor",
        type: "rating_received",
        title: `Rating Received: ${ratingText}`,
        body: feedback || `You received a ${ratingText} rating for ${job.title}`,
        jobId: job._id,
        metadata: { rating: stars, jobTitle: job.title, actionRequired: false },
        deepLink: "worker/profile",
        pushNotificationSent: false,
      });
    }
  } catch (e) {
    console.error("Error creating rating notification:", e);
  }

  await emitJobUpdatedToUsers(job, [job.contractorName, job.acceptedBy || job.contractorName]);
  return { code: 200, body: { success: true, message: "Rating submitted successfully", job } };
}

async function cancelJob({ jobId, reason, reasonDescription, userPhone, deps }) {
  const {
    io,
    pendingJobTimeouts,
    pendingJobExpirations,
    logJobEvent,
  } = deps;

  if (!reason) {
    return { code: 400, body: { success: false, message: "Cancellation reason required" } };
  }

  const job = await Job.findById(jobId);
  if (!job) {
    return { code: 404, body: { success: false, message: "Job not found" } };
  }

  let cancelledBy = "admin";
  if (userPhone === job.contractorPhone) cancelledBy = "contractor";
  if (userPhone === job.acceptedBy) cancelledBy = "worker";

  let refundAmount = 0;
  let cancellationFee = 0;
  if (cancelledBy === "contractor" && !job.acceptedBy) refundAmount = 25;

  const cancellation = new CancellationLog({
    jobId: job._id,
    contractorPhone: job.contractorPhone,
    contractorName: job.contractorName,
    workerPhone: job.acceptedBy,
    cancelledBy,
    reason,
    reasonDescription,
    jobAmount: job.amount,
    cancellationFee,
    refundAmount,
    refundToPhone: job.contractorPhone,
    cancelledAt: new Date(),
  });
  await cancellation.save();

  const oldState = { status: job.status, paymentStatus: job.paymentStatus };
  job.status = "cancelled";
  await job.save();

  await logJobEvent({
    jobId: job._id,
    eventType: "job_cancelled",
    actorType: cancelledBy === "contractor" ? "contractor" : cancelledBy === "worker" ? "worker" : "admin",
    actorPhone: userPhone,
    source: "app",
    oldState,
    newState: { status: job.status, paymentStatus: job.paymentStatus },
    reasonCode: reason,
    reasonText: reasonDescription || reason,
    metadata: { refundAmount, cancellationFee },
  });

  if (refundAmount > 0 && cancelledBy === "contractor" && !job.acceptedBy) {
    let wallet = await Wallet.findOne({ phone: job.contractorPhone });
    if (!wallet) wallet = new Wallet({ phone: job.contractorPhone });
    wallet.balance += refundAmount;
    wallet.transactions.push({ type: "refund", amount: refundAmount, date: new Date() });
    await wallet.save();
  }

  const cancellationPayload = {
    ...job.toObject(),
    _id: job._id.toString(),
    id: job._id.toString(),
    status: "cancelled",
    cancelledBy,
    cancelledAt: new Date(),
  };
  io.emit("jobCancelled", cancellationPayload);

  if (pendingJobTimeouts.has(jobId)) {
    clearTimeout(pendingJobTimeouts.get(jobId));
    pendingJobTimeouts.delete(jobId);
  }
  if (pendingJobExpirations.has(jobId)) {
    clearTimeout(pendingJobExpirations.get(jobId));
    pendingJobExpirations.delete(jobId);
  }

  await ActivityLog.create({
    userId: userPhone,
    phone: userPhone,
    action: "job_cancelled",
    jobId: job._id,
    description: `Job cancelled by ${cancelledBy}: ${reason}`,
    status: "success",
    metadata: { reason, refundAmount, cancellationFee },
  });

  return { code: 200, body: { success: true, cancellation, message: "Job cancelled successfully" } };
}

async function getCancellations({ userPhone }) {
  const cancellations = await CancellationLog.find({
    $or: [{ contractorPhone: userPhone }, { workerPhone: userPhone }],
  })
    .sort({ cancelledAt: -1 })
    .limit(50);

  return { code: 200, body: { success: true, cancellations, count: cancellations.length } };
}

module.exports = {
  markAttendance,
  payJob,
  rateJob,
  cancelJob,
  getCancellations,
};
