const Job = require("../models/Jobs");
const WorkerModel = require("../models/Worker");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const NotificationHistory = require("../models/NotificationHistory");
const CancellationLog = require("../models/CancellationLog");
const ActivityLog = require("../models/ActivityLog");
const { updateGigDataOnCompletion } = require("../utils/gigsDataTracker");
const { createGigHistoryEvent } = require("./gigHistoryService");
const { cancelDispatchState } = require("./dispatchStateService");

const payInFlightLocks = new Map();
const payIdempotencyResults = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

function getPayKey({ jobId, workerPhone, mode, idempotencyKey }) {
  const target = `${jobId}:${workerPhone || "single"}:${String(mode || "cash").toLowerCase()}`;
  return `${target}:${idempotencyKey || ""}`;
}

function cleanupIdempotencyCache() {
  const now = Date.now();
  for (const [key, value] of payIdempotencyResults.entries()) {
    if (!value || value.expiresAt <= now) {
      payIdempotencyResults.delete(key);
    }
  }
}

async function markAttendance({ jobId, status, workerPhone, userPhone, deps }) {
  const { trackingJobs, emitJobUpdatedToUsers, logJobEvent } = deps;
  const job = await Job.findById(jobId);
  if (!job) return { code: 404, body: { message: "Job not found" } };

  if (job.bulkHiring && workerPhone) {
    const target = (job.acceptedWorkers || []).find((w) => w.phone === workerPhone);
    if (!target) {
      return { code: 404, body: { success: false, message: "Worker not found on this bulk job" } };
    }

    target.attendanceStatus = status;
    target.attendanceTime = new Date();
    if (status === "Present" && job.status === "accepted") {
      job.status = "in_progress";
    }
    await job.save();

    if (trackingJobs.has(jobId)) trackingJobs.delete(jobId);
    await emitJobUpdatedToUsers(job, [job.contractorName, workerPhone, job.acceptedBy || job.contractorName]);
    return { code: 200, body: { success: true, job } };
  }

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
  await emitJobUpdatedToUsers(job, [
    job.contractorName,
    job.contractorPhone,
    job.acceptedBy || job.contractorName,
  ]);
  return { code: 200, body: { success: true, job } };
}

async function payJob({ jobId, mode, workerPhone, idempotencyKey, userPhone, userName, deps }) {
  cleanupIdempotencyCache();
  const idemKey = idempotencyKey ? getPayKey({ jobId, workerPhone, mode, idempotencyKey }) : null;
  if (idemKey && payIdempotencyResults.has(idemKey)) {
    return payIdempotencyResults.get(idemKey).result;
  }

  const lockKey = `${jobId}:${workerPhone || "single"}`;
  if (payInFlightLocks.has(lockKey)) {
    return { code: 409, body: { success: false, message: "Payment already processing for this job/worker. Please wait." } };
  }
  payInFlightLocks.set(lockKey, true);

  const finalize = (result) => {
    payInFlightLocks.delete(lockKey);
    if (idemKey) {
      payIdempotencyResults.set(idemKey, {
        result,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      });
    }
    return result;
  };

  try {
  const { updateContractorStats, emitJobUpdatedToUsers, logJobEvent } = deps;
  const job = await Job.findById(jobId);
  if (!job) return finalize({ code: 404, body: { message: "Job not found" } });

  if (job.bulkHiring && workerPhone) {
    const target = (job.acceptedWorkers || []).find((w) => w.phone === workerPhone);
    if (!target) {
      return finalize({ code: 404, body: { success: false, message: "Worker not found on this bulk job" } });
    }
    if (target.attendanceStatus !== "Present") {
      return finalize({ code: 400, body: { success: false, message: "Payment allowed only for PRESENT workers" } });
    }
    if (target.paymentStatus === "Paid") {
      return finalize({ code: 400, body: { success: false, message: "This worker is already paid for this job" } });
    }

    const oldState = { status: job.status, paymentStatus: job.paymentStatus, paymentMode: job.paymentMode };
    target.paymentStatus = "Paid";
    target.paymentMode = mode;
    target.paymentTime = new Date();

    const allPaid = (job.acceptedWorkers || []).length > 0 &&
      (job.acceptedWorkers || []).every((w) => w.paymentStatus === "Paid");
    if (allPaid) {
      job.paymentStatus = "Paid";
      job.paymentTime = target.paymentTime;
      if (job.status === "accepted" || job.status === "in_progress") {
        job.status = "completed";
      }
    } else if (job.paymentStatus !== "Paid") {
      job.paymentStatus = "Pending";
      if (job.status === "accepted") {
        job.status = "in_progress";
      }
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
      metadata: { amount: job.amount, workerPhone },
    });

    try {
      await NotificationHistory.create({
        recipientPhone: workerPhone,
        senderPhone: userPhone,
        senderName: userName || job.contractorName || "Contractor",
        type: "payment_received",
        title: `Payment Received: ₹${job.amount}`,
        body: `Payment for ${job.title} has been transferred to your wallet`,
        jobId: job._id,
        metadata: { jobTitle: job.title, amount: job.amount, actionRequired: false, workerPhone },
        deepLink: "worker/wallet",
        pushNotificationSent: false,
      });
    } catch (e) {
      console.error("Error creating payment notification:", e);
    }

    try {
      let workerWallet = await Wallet.findOne({ phone: workerPhone });
      if (!workerWallet) workerWallet = new Wallet({ phone: workerPhone, balance: 0, availableBalance: 0, pocketBalance: 0 });
      const creditAmount = Number(job.amount) || 0;
      workerWallet.availableBalance = Number(workerWallet.availableBalance ?? workerWallet.balance ?? 0) + creditAmount;
      workerWallet.balance = Number(workerWallet.availableBalance || 0);
      workerWallet.transactions.push({
        type: "payment",
        amount: creditAmount,
        date: new Date(),
        jobId: job._id,
        source: "app",
        provider: "internal",
        status: "completed",
        description: `Job payment credited to available balance (${job.title})`,
        metadata: { balanceType: "available", workerPhone },
      });
      await workerWallet.save();
    } catch (walletErr) {
      console.error("Error updating worker wallet after payment:", walletErr);
    }

    try {
      await updateGigDataOnCompletion(workerPhone, {
        jobId: job._id.toString(),
        title: job.title,
        amount: job.amount,
        workerType: job.workerType,
        timeSpentMinutes: job.timeSpentMinutes || 0,
      });
    } catch (e) {
      console.error("Error updating gigs data on completion:", e);
    }

    await updateContractorStats(userPhone);
    await emitJobUpdatedToUsers(job, [job.contractorName, workerPhone, job.acceptedBy || job.contractorName]);
    return finalize({ code: 200, body: { success: true, message: "Payment successful", job, workerPhone } });
  }

  if (job.attendanceStatus !== "Present") {
    return finalize({ code: 400, body: { success: false, message: "Payment allowed only for PRESENT workers" } });
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
    job.hoursWorked = Math.round(((job.timeSpentMinutes || 0) / 60) * 10) / 10;
  }
  await job.save();

  // Record completion for incentive eligibility only after payment is finalized.
  try {
    if (job.acceptedBy) {
      await createGigHistoryEvent({
        workerPhone: job.acceptedBy,
        workerName: job.acceptedWorker?.name || job.acceptedBy,
        jobId: job._id,
        jobTitle: job.title,
        contractorPhone: job.contractorPhone,
        contractorName: job.contractorName,
        eventType: "job_completed",
        status: job.status,
        paymentStatus: job.paymentStatus,
        hoursWorked: job.hoursWorked || 0,
        timeSpentMinutes: job.timeSpentMinutes || 0,
        eventTime: job.paymentTime || new Date(),
      });
    }
  } catch (e) {
    console.error("Error writing gig history completion event:", e);
  }

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
    if (!workerWallet) workerWallet = new Wallet({ phone: job.acceptedBy, balance: 0, availableBalance: 0, pocketBalance: 0 });
    const creditAmount = Number(job.amount) || 0;
    workerWallet.availableBalance = Number(workerWallet.availableBalance ?? workerWallet.balance ?? 0) + creditAmount;
    workerWallet.balance = Number(workerWallet.availableBalance || 0);
    workerWallet.transactions.push({
      type: "payment",
      amount: creditAmount,
      date: new Date(),
      jobId: job._id,
      source: "app",
      provider: "internal",
      status: "completed",
      description: `Job payment credited to available balance (${job.title})`,
      metadata: { balanceType: "available" },
    });
    await workerWallet.save();
  } catch (walletErr) {
    console.error("Error updating worker wallet after payment:", walletErr);
  }

  // First completed cash-paid job activates mandatory pocket balance rule for worker availability.
  try {
    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (normalizedMode === "cash" && job.acceptedBy) {
      const totalPaidCompletedJobs = await Job.countDocuments({
        $or: [{ acceptedBy: job.acceptedBy }, { "acceptedWorkers.phone": job.acceptedBy }],
        paymentStatus: "Paid",
        status: "completed",
      });

      if (totalPaidCompletedJobs === 1) {
        await WorkerModel.findOneAndUpdate(
          { phone: job.acceptedBy },
          {
            $set: {
              "compliance.requiresPocketMinimumForOnline": true,
              "compliance.pocketMinimumAmount": 100,
              "compliance.firstCashPaidJobId": job._id,
              "compliance.ruleActivatedAt": new Date(),
            },
          },
          { new: true }
        );
      }
    }
  } catch (complianceErr) {
    console.error("Error applying first-cash pocket-balance compliance rule:", complianceErr);
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
  return finalize({ code: 200, body: { success: true, message: "Payment successful", job } });
  } catch (err) {
    payInFlightLocks.delete(lockKey);
    throw err;
  }
}

async function rateJob({ jobId, stars, feedback, workerPhone, userPhone, userName, deps }) {
  const { emitJobUpdatedToUsers } = deps;
  if (!stars || stars < 1 || stars > 5) {
    return { code: 400, body: { message: "Rating must be between 1 and 5 stars" } };
  }

  const job = await Job.findById(jobId);
  if (!job) return { code: 404, body: { message: "Job not found" } };

  const isBulkTarget = job.bulkHiring && workerPhone;
  let ratingTargetPhone = workerPhone || job.acceptedWorker?.phone || job.acceptedBy;

  if (isBulkTarget) {
    const target = (job.acceptedWorkers || []).find((w) => w.phone === workerPhone);
    if (!target) {
      return { code: 404, body: { success: false, message: "Worker not found on this bulk job" } };
    }
    if (target.paymentStatus !== "Paid") {
      return { code: 400, body: { success: false, message: "Can only rate workers that have been paid" } };
    }
    if (target.attendanceStatus !== "Present") {
      return { code: 400, body: { success: false, message: "Can only rate workers marked as Present" } };
    }
    if (target.rating?.stars) {
      return { code: 400, body: { success: false, message: "This worker is already rated for this job" } };
    }
    target.rating = {
      stars: parseInt(stars, 10),
      feedback: feedback || "",
      ratedAt: new Date(),
      ratedBy: userPhone || job.contractorName,
    };
  } else {
    if (job.paymentStatus !== "Paid") {
      return { code: 400, body: { message: "Can only rate jobs that have been paid" } };
    }
    if (job.attendanceStatus !== "Present") {
      return { code: 400, body: { message: "Can only rate workers marked as Present" } };
    }
    if (job.rating?.stars) {
      return { code: 400, body: { success: false, message: "Worker already rated for this job" } };
    }

    job.rating = {
      stars: parseInt(stars, 10),
      feedback: feedback || "",
      ratedAt: new Date(),
      ratedBy: userPhone || job.contractorName,
    };
  }
  await job.save();

  try {
    if (ratingTargetPhone) {
      const ratedJobs = await Job.find({
        $or: [
          { $and: [{ $or: [{ "acceptedWorker.phone": ratingTargetPhone }, { acceptedBy: ratingTargetPhone }] }, { "rating.stars": { $exists: true, $ne: null } }] },
          { acceptedWorkers: { $elemMatch: { phone: ratingTargetPhone, "rating.stars": { $exists: true, $ne: null } } } },
        ],
      }).lean();

      let totalStars = 0;
      let totalReviews = 0;
      for (const rated of ratedJobs) {
        if ((rated.acceptedBy === ratingTargetPhone || rated.acceptedWorker?.phone === ratingTargetPhone) && rated.rating?.stars) {
          totalStars += rated.rating.stars;
          totalReviews += 1;
        }
        for (const w of rated.acceptedWorkers || []) {
          if (w?.phone === ratingTargetPhone && w?.rating?.stars) {
            totalStars += w.rating.stars;
            totalReviews += 1;
          }
        }
      }

      if (totalReviews > 0) {
        const averageRating = totalStars / totalReviews;
        await WorkerModel.findOneAndUpdate(
          { phone: ratingTargetPhone },
          {
            $set: {
              "performanceMetrics.averageRating": Math.round(averageRating * 10) / 10,
              "performanceMetrics.totalReviews": totalReviews,
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
    if (ratingTargetPhone) {
      const ratingText = `${stars} star${stars > 1 ? "s" : ""}`;
      await NotificationHistory.create({
        recipientPhone: ratingTargetPhone,
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

async function rateContractor({ jobId, stars, feedback, userPhone, userName, deps }) {
  const { emitJobUpdatedToUsers } = deps;

  if (!stars || stars < 1 || stars > 5) {
    return { code: 400, body: { success: false, message: "Rating must be between 1 and 5 stars" } };
  }

  const job = await Job.findById(jobId);
  if (!job) return { code: 404, body: { success: false, message: "Job not found" } };

  // Only assigned worker can rate this contractor.
  if (job.acceptedBy !== userPhone) {
    return { code: 403, body: { success: false, message: "Only assigned worker can rate this contractor" } };
  }

  if (job.paymentStatus !== "Paid" || job.status !== "completed") {
    return { code: 400, body: { success: false, message: "Contractor can be rated only after paid and completed job" } };
  }

  if (job.contractorRating && job.contractorRating.stars) {
    return { code: 400, body: { success: false, message: "Contractor already rated for this job" } };
  }

  job.contractorRating = {
    stars: parseInt(stars, 10),
    feedback: feedback || "",
    ratedAt: new Date(),
    ratedBy: userPhone || userName || "worker",
  };
  await job.save();

  // Recalculate contractor average rating from contractorRating on paid jobs.
  try {
    const contractorPhone = job.contractorPhone;
    if (contractorPhone) {
      const ratedJobs = await Job.find({
        contractorPhone,
        paymentStatus: "Paid",
        "contractorRating.stars": { $exists: true, $ne: null },
      }).select("contractorRating");

      if (ratedJobs.length > 0) {
        const totalStars = ratedJobs.reduce((sum, j) => sum + (j.contractorRating?.stars || 0), 0);
        const averageRating = Math.round((totalStars / ratedJobs.length) * 10) / 10;

        await User.findOneAndUpdate(
          { phone: contractorPhone },
          { $set: { avgRating: averageRating } },
          { new: true }
        );
      } else {
        await User.findOneAndUpdate(
          { phone: contractorPhone },
          { $set: { avgRating: 0 } },
          { new: true }
        );
      }
    }
  } catch (err) {
    console.error("Error updating contractor average rating:", err);
  }

  // Notify contractor that worker rated them.
  try {
    if (job.contractorPhone) {
      const ratingText = `${stars} star${stars > 1 ? "s" : ""}`;
      await NotificationHistory.create({
        recipientPhone: job.contractorPhone,
        senderPhone: userPhone,
        senderName: userName || job.acceptedBy || "Worker",
        type: "rating_received",
        title: `New Contractor Rating: ${ratingText}`,
        body: feedback || `You received a ${ratingText} rating from worker`,
        jobId: job._id,
        metadata: { rating: stars, jobTitle: job.title, actionRequired: false },
        deepLink: "contractor/profile",
        pushNotificationSent: false,
      });
    }
  } catch (e) {
    console.error("Error creating contractor rating notification:", e);
  }

  await emitJobUpdatedToUsers(job, [job.contractorName, job.acceptedBy || job.contractorName]);
  return { code: 200, body: { success: true, message: "Contractor rated successfully", job } };
}

async function cancelJob({ jobId, reason, reasonDescription, userPhone, deps }) {
  const {
    io,
    pendingJobTimeouts,
    pendingJobExpirations,
    logJobEvent,
    emitJobCancelledToUsers,
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

  try {
    if (job.acceptedBy) {
      await createGigHistoryEvent({
        workerPhone: job.acceptedBy,
        workerName: job.acceptedWorker?.name || job.acceptedBy,
        jobId: job._id,
        jobTitle: job.title,
        contractorPhone: job.contractorPhone,
        contractorName: job.contractorName,
        eventType: cancelledBy === "worker" ? "job_cancelled_by_worker" : "job_cancelled_by_contractor",
        status: job.status,
        paymentStatus: job.paymentStatus,
        hoursWorked: 0,
        timeSpentMinutes: 0,
        eventTime: new Date(),
        metadata: { reason, reasonDescription: reasonDescription || "", cancelledBy },
      });
    }
  } catch (e) {
    console.error("Error writing gig history cancel event:", e);
  }

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
  const targetUsers = [
    job.contractorPhone,
    job.contractorName,
    job.acceptedBy,
    ...(Array.isArray(job.acceptedWorkers) ? job.acceptedWorkers.map((w) => w?.phone).filter(Boolean) : []),
  ];
  if (typeof emitJobCancelledToUsers === "function") {
    await emitJobCancelledToUsers(cancellationPayload, targetUsers);
  } else {
    io.emit("jobCancelled", cancellationPayload);
  }

  if (pendingJobTimeouts.has(jobId)) {
    clearTimeout(pendingJobTimeouts.get(jobId));
    pendingJobTimeouts.delete(jobId);
  }
  if (pendingJobExpirations.has(jobId)) {
    clearTimeout(pendingJobExpirations.get(jobId));
    pendingJobExpirations.delete(jobId);
  }
  await cancelDispatchState({ jobId, reason: "job_cancelled" });

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
  rateContractor,
  cancelJob,
  getCancellations,
};
