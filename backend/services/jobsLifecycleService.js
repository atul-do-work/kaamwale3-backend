const Job = require("../models/Jobs");
const WorkerModel = require("../models/Worker");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WorkerEarnings = require("../models/WorkerEarnings");
const NotificationHistory = require("../models/NotificationHistory");
const CancellationLog = require("../models/CancellationLog");
const ActivityLog = require("../models/ActivityLog");
const { updateGigDataOnCompletion } = require("../utils/gigsDataTracker");
const { createGigHistoryEvent } = require("./gigHistoryService");
const { cancelDispatchState } = require("./dispatchStateService");

const payInFlightLocks = new Map();
const payIdempotencyResults = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const cancelInFlightLocks = new Map();
const cancelIdempotencyResults = new Map();
const CANCEL_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const PAYOUT_CYCLE_ANCHOR_ISO = process.env.PAYOUT_CYCLE_ANCHOR_ISO || "2025-02-25T00:00:00+05:30";
const PAYOUT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
const CANCEL_REFUND_BEFORE_ACCEPT = Number(process.env.CANCEL_REFUND_BEFORE_ACCEPT || 25);
const CANCEL_FEE_AFTER_ACCEPT = Number(process.env.CANCEL_FEE_AFTER_ACCEPT || 0);
const ALLOWED_CANCELLATION_REASONS = new Set([
  "no_workers_available",
  "worker_not_responding",
  "location_changed",
  "job_completed_elsewhere",
  "payment_issue",
  "safety_concern",
  "worker_unavailable",
  "technical_issue",
  "contractor_request",
  "contractor_requested",
  "worker_request",
  "worker_requested",
  "admin_action",
  "other",
]);

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

function cleanupCancelIdempotencyCache() {
  const now = Date.now();
  for (const [key, value] of cancelIdempotencyResults.entries()) {
    if (!value || value.expiresAt <= now) {
      cancelIdempotencyResults.delete(key);
    }
  }
}

function getCancelKey({ jobId, userPhone, idempotencyKey }) {
  return `cancel:${jobId}:${userPhone || "unknown"}:${idempotencyKey || ""}`;
}

function getPayoutWeekBounds(now = new Date()) {
  const anchor = new Date(PAYOUT_CYCLE_ANCHOR_ISO);
  if (Number.isNaN(anchor.getTime())) {
    const fallbackStart = new Date(now);
    const day = fallbackStart.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    fallbackStart.setDate(fallbackStart.getDate() + diff);
    fallbackStart.setHours(0, 0, 0, 0);
    const fallbackEnd = new Date(fallbackStart.getTime() + PAYOUT_CYCLE_MS);
    return { start: fallbackStart, endExclusive: fallbackEnd };
  }

  const elapsedMs = now.getTime() - anchor.getTime();
  const cycleIndex = Math.floor(elapsedMs / PAYOUT_CYCLE_MS);
  const cycleStartMs = anchor.getTime() + cycleIndex * PAYOUT_CYCLE_MS;
  const start = new Date(cycleStartMs);
  const endExclusive = new Date(cycleStartMs + PAYOUT_CYCLE_MS);
  return { start, endExclusive };
}

function getUtcWeekNumber(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

async function upsertWorkerEarningForJobPayment({ job, workerPhone, amount, mode }) {
  if (!job?._id || !workerPhone) return;
  const earningAmount = Number(amount || 0);
  if (!Number.isFinite(earningAmount) || earningAmount <= 0) return;

  const normalizedMode = String(mode || "cash").trim().toLowerCase();
  const now = new Date();
  const { start, endExclusive } = getPayoutWeekBounds(now);
  const providerEventId = `manual:${job._id}:${workerPhone}:${normalizedMode}`;

  await WorkerEarnings.findOneAndUpdate(
    { workerPhone, jobId: job._id },
    {
      $setOnInsert: {
        workerPhone,
        jobId: job._id,
        amount: earningAmount,
        currency: "INR",
        status: "earned",
        source: "app",
        provider: "manual",
        orderId: null,
        paymentId: null,
        providerEventId,
        idempotencyKey: providerEventId,
        earnedAt: now,
        payoutWeek: {
          year: start.getUTCFullYear(),
          week: getUtcWeekNumber(start),
          startDate: start,
          endDate: new Date(endExclusive.getTime() - 1),
        },
        contractorName: job.contractorName,
        contractorPhone: job.contractorPhone,
        jobTitle: job.title,
        notes: `Job marked paid (${normalizedMode})`,
        metadata: {
          createdFrom: "jobs/pay",
          paymentMode: normalizedMode,
          balanceType: "available",
        },
      },
    },
    { upsert: true, new: true }
  );
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
      workerWallet.totalEarned = Number(workerWallet.totalEarned || 0) + creditAmount;
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
      await upsertWorkerEarningForJobPayment({
        job,
        workerPhone,
        amount: job.amount,
        mode,
      });
    } catch (earnErr) {
      console.error("Error upserting WorkerEarnings after bulk payment:", earnErr);
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
    workerWallet.totalEarned = Number(workerWallet.totalEarned || 0) + creditAmount;
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

  try {
    await upsertWorkerEarningForJobPayment({
      job,
      workerPhone: job.acceptedBy,
      amount: job.amount,
      mode,
    });
  } catch (earnErr) {
    console.error("Error upserting WorkerEarnings after payment:", earnErr);
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

async function cancelJob({ jobId, reason, reasonDescription, idempotencyKey, userPhone, deps }) {
  cleanupCancelIdempotencyCache();
  const cancelKey = idempotencyKey ? getCancelKey({ jobId, userPhone, idempotencyKey }) : null;
  if (cancelKey && cancelIdempotencyResults.has(cancelKey)) {
    return cancelIdempotencyResults.get(cancelKey).result;
  }

  const lockKey = `${jobId}:${userPhone || "unknown"}`;
  if (cancelInFlightLocks.has(lockKey)) {
    return { code: 409, body: { success: false, message: "Cancellation already processing. Please wait." } };
  }
  cancelInFlightLocks.set(lockKey, true);

  const finalize = (result) => {
    cancelInFlightLocks.delete(lockKey);
    if (cancelKey) {
      cancelIdempotencyResults.set(cancelKey, {
        result,
        expiresAt: Date.now() + CANCEL_IDEMPOTENCY_TTL_MS,
      });
    }
    return result;
  };

  try {
  const {
    io,
    pendingJobTimeouts,
    pendingJobExpirations,
    logJobEvent,
    emitJobCancelledToUsers,
    emitJobUpdatedToUsers,
    updateContractorStats,
  } = deps;

  const normalizedReason = String(reason || "").trim().toLowerCase();
  const normalizedReasonDescription = String(reasonDescription || "").trim().slice(0, 300);

  if (!normalizedReason) {
    return finalize({ code: 400, body: { success: false, message: "Cancellation reason required" } });
  }
  if (!ALLOWED_CANCELLATION_REASONS.has(normalizedReason)) {
    return finalize({
      code: 400,
      body: {
        success: false,
        message: "Invalid cancellation reason",
        allowedReasons: Array.from(ALLOWED_CANCELLATION_REASONS.values()),
      },
    });
  }

  const job = await Job.findById(jobId);
  if (!job) {
    return finalize({ code: 404, body: { success: false, message: "Job not found" } });
  }

  if (job.status === "cancelled" || job.isCancelled === true) {
    const existingCancellation = await CancellationLog.findOne({ jobId: job._id }).sort({ cancelledAt: -1 }).lean();
    return finalize({
      code: 200,
      body: {
        success: true,
        idempotent: true,
        cancellation: existingCancellation || null,
        message: "Job already cancelled",
      },
    });
  }

  let cancelledBy = "admin";
  if (userPhone === job.contractorPhone) cancelledBy = "contractor";
  if (userPhone === job.acceptedBy) cancelledBy = "worker";

  const hasAssignedWorker =
    Boolean(job.acceptedBy) ||
    (Array.isArray(job.acceptedWorkers) && job.acceptedWorkers.some((w) => Boolean(w?.phone)));

  let refundAmount = 0;
  let cancellationFee = 0;
  if (cancelledBy === "contractor" && !hasAssignedWorker) {
    refundAmount = Number.isFinite(CANCEL_REFUND_BEFORE_ACCEPT) ? Math.max(0, CANCEL_REFUND_BEFORE_ACCEPT) : 25;
  }
  if (cancelledBy === "contractor" && hasAssignedWorker) {
    cancellationFee = Number.isFinite(CANCEL_FEE_AFTER_ACCEPT) ? Math.max(0, CANCEL_FEE_AFTER_ACCEPT) : 0;
  }

  if (cancelledBy === "contractor" && cancellationFee > 0) {
    const contractorWallet = await Wallet.findOne({ phone: job.contractorPhone }).select("pocketBalance");
    const currentPocket = Number(contractorWallet?.pocketBalance || 0);
    if (currentPocket < cancellationFee) {
      return finalize({
        code: 400,
        body: {
          success: false,
          message: `Insufficient pocket balance for cancellation fee of ₹${cancellationFee}`,
          pocketBalance: currentPocket,
          requiredFee: cancellationFee,
        },
      });
    }
  }

  const cancellation = new CancellationLog({
    jobId: job._id,
    contractorPhone: job.contractorPhone,
    contractorName: job.contractorName,
    workerPhone: job.acceptedBy,
    cancelledBy,
    reason: normalizedReason,
    reasonDescription: normalizedReasonDescription,
    jobAmount: job.amount,
    cancellationFee,
    refundAmount,
    refundToPhone: job.contractorPhone,
    cancelledAt: new Date(),
    cancellationPolicy: `refund_before_accept=${CANCEL_REFUND_BEFORE_ACCEPT};fee_after_accept=${CANCEL_FEE_AFTER_ACCEPT}`,
    policyExplanation: hasAssignedWorker
      ? `Assigned worker exists; cancellation fee ₹${cancellationFee}`
      : `No assigned worker; refund ₹${refundAmount}`,
  });
  await cancellation.save();

  const oldState = { status: job.status, paymentStatus: job.paymentStatus };
  job.status = "cancelled";
  job.isCancelled = true;
  job.cancelledAt = cancellation.cancelledAt;
  job.cancelledBy = cancelledBy;
  job.cancellationReason = normalizedReason;
  job.cancellationReasonDescription = normalizedReasonDescription || null;
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
        metadata: { reason: normalizedReason, reasonDescription: normalizedReasonDescription || "", cancelledBy },
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
    reasonCode: normalizedReason,
    reasonText: normalizedReasonDescription || normalizedReason,
    metadata: { refundAmount, cancellationFee },
  });

  if (cancelledBy === "contractor" && cancellationFee > 0) {
    let wallet = await Wallet.findOne({ phone: job.contractorPhone });
    if (!wallet) wallet = new Wallet({ phone: job.contractorPhone, balance: 0, availableBalance: 0, pocketBalance: 0 });
    const openingPocket = Number(wallet.pocketBalance || 0);
    wallet.pocketBalance = openingPocket - cancellationFee;
    wallet.transactions.push({
      type: "job_post_fee",
      amount: cancellationFee,
      date: new Date(),
      description: `Cancellation fee charged for job ${job._id}`,
      metadata: { debitedFrom: "pocketBalance", reason: "job_cancel_fee", jobId: job._id, cancellationId: cancellation._id },
    });
    await wallet.save();

    if (io) {
      io.to(job.contractorPhone).emit("walletUpdated", {
        phone: job.contractorPhone,
        type: "job_post_fee",
        amount: cancellationFee,
        balance: Number(wallet.balance || 0),
        availableBalance: Number(wallet.availableBalance ?? wallet.balance ?? 0),
        pocketBalance: Number(wallet.pocketBalance || 0),
        message: `Cancellation fee debited: ₹${cancellationFee}`,
      });
    }
  }

  if (refundAmount > 0 && cancelledBy === "contractor" && !hasAssignedWorker) {
    let wallet = await Wallet.findOne({ phone: job.contractorPhone });
    if (!wallet) wallet = new Wallet({ phone: job.contractorPhone, balance: 0, availableBalance: 0, pocketBalance: 0 });
    wallet.pocketBalance = Number(wallet.pocketBalance || 0) + refundAmount;
    wallet.transactions.push({
      type: "refund",
      amount: refundAmount,
      date: new Date(),
      description: `Refund for cancelled job ${job._id}`,
      metadata: { creditedTo: "pocketBalance", reason: "job_cancel_refund", jobId: job._id, cancellationId: cancellation._id },
    });
    await wallet.save();

    if (io) {
      io.to(job.contractorPhone).emit("walletUpdated", {
        phone: job.contractorPhone,
        type: "refund",
        amount: refundAmount,
        balance: Number(wallet.balance || 0),
        availableBalance: Number(wallet.availableBalance ?? wallet.balance ?? 0),
        pocketBalance: Number(wallet.pocketBalance || 0),
        message: `Refund credited: ₹${refundAmount}`,
      });
    }
  }

  const cancellationPayload = {
    ...job.toObject(),
    _id: job._id.toString(),
    id: job._id.toString(),
    status: "cancelled",
    cancelledBy,
    cancelledAt: cancellation.cancelledAt,
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
  if (typeof emitJobUpdatedToUsers === "function") {
    await emitJobUpdatedToUsers(cancellationPayload, targetUsers);
  } else {
    io.emit("jobUpdated", cancellationPayload);
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
    description: `Job cancelled by ${cancelledBy}: ${normalizedReason}`,
    status: "success",
    metadata: { reason: normalizedReason, refundAmount, cancellationFee },
  });

  try {
    if (typeof updateContractorStats === "function" && job.contractorPhone) {
      await updateContractorStats(job.contractorPhone);
    }
  } catch (statsErr) {
    console.error("Error updating contractor stats after cancellation:", statsErr);
  }

  return finalize({ code: 200, body: { success: true, cancellation, message: "Job cancelled successfully" } });
  } catch (err) {
    cancelInFlightLocks.delete(lockKey);
    throw err;
  }
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
