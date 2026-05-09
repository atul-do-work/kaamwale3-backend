const mongoose = require("mongoose");
const Job = require("../models/Jobs");
const WorkerModel = require("../models/Worker");
const User = require("../models/User");
const Wallet = require("../models/Wallet");
const WorkerEarnings = require("../models/WorkerEarnings");
const NotificationHistory = require("../models/NotificationHistory");
const CancellationLog = require("../models/CancellationLog");
const ActivityLog = require("../models/ActivityLog");
const CashDeposit = require("../models/CashDeposit");
const { updateGigDataOnCompletion, updateGigDataOnCancellation } = require("../utils/gigsDataTracker");
const { normalizePhoneNumber } = require("../utils/dataNormalization");
const { createGigHistoryEvent } = require("./gigHistoryService");
const { cancelDispatchState } = require("./dispatchStateService");

const payInFlightLocks = new Map();
const payIdempotencyResults = new Map();
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const cancelInFlightLocks = new Map();
const cancelIdempotencyResults = new Map();
const CANCEL_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
const depositInFlightLocks = new Map();
const depositIdempotencyResults = new Map();
const PAYOUT_CYCLE_ANCHOR_ISO = process.env.PAYOUT_CYCLE_ANCHOR_ISO || "2025-02-25T00:00:00+05:30";
const PAYOUT_CYCLE_MS = 7 * 24 * 60 * 60 * 1000;
const CANCEL_REFUND_BEFORE_ACCEPT = Number(process.env.CANCEL_REFUND_BEFORE_ACCEPT || 25);
const CANCEL_FEE_AFTER_ACCEPT = Number(process.env.CANCEL_FEE_AFTER_ACCEPT || 0);
const WORKER_CANCEL_WINDOW_MINUTES = Number(process.env.WORKER_CANCEL_WINDOW_MINUTES || 10);
const WORKER_CANCEL_LATE_FEE = Number(process.env.WORKER_CANCEL_LATE_FEE || 100);
const WORKER_CANCEL_MAX_IN_WINDOW = Number(process.env.WORKER_CANCEL_MAX_IN_WINDOW || 3);
const WORKER_CANCEL_WINDOW_HOURS = Number(process.env.WORKER_CANCEL_WINDOW_HOURS || 168);
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

function normalizeWorkerPhone(phone) {
  return normalizePhoneNumber(phone);
}

function areSamePhone(a, b) {
  const first = normalizeWorkerPhone(a);
  const second = normalizeWorkerPhone(b);
  return first && second && first === second;
}

function getPayKey({ jobId, workerPhone, mode, idempotencyKey }) {
  const target = `${jobId}:${normalizeWorkerPhone(workerPhone) || "single"}:${String(mode || "cash").toLowerCase()}`;
  return `${target}:${idempotencyKey || ""}`;
}

function normalizePaidJobStatus(status) {
  const normalized = String(status || "").toLowerCase();
  if (normalized === "cancelled" || normalized === "expired" || normalized === "completed") {
    return status;
  }
  return "completed";
}

async function rollbackJobPayment(job, oldJobState, target = null, oldTargetState = null) {
  if (!job || !oldJobState) return;
  try {
    if (target && oldTargetState) {
      target.paymentStatus = oldTargetState.paymentStatus;
      target.paymentMode = oldTargetState.paymentMode;
      target.paymentTime = oldTargetState.paymentTime;
    }
    job.paymentStatus = oldJobState.paymentStatus;
    job.paymentMode = oldJobState.paymentMode;
    job.paymentTime = oldJobState.paymentTime;
    job.status = oldJobState.status;
    await job.save();
  } catch (err) {
    console.error("Error rolling back payment state:", err);
  }
}

async function setWorkerOfflineByPhone(phone) {
  if (!phone || !String(phone).trim()) return;
  const normalizedPhone = String(phone).trim();
  try {
    await User.findOneAndUpdate(
      { phone: normalizedPhone },
      { $set: { isAvailable: false, updatedAt: new Date() } }
    );
  } catch (err) {
    console.error("Error marking user offline after payment:", err);
  }
  try {
    await WorkerModel.findOneAndUpdate(
      { phone: normalizedPhone },
      { $set: { isAvailable: false, updatedAt: new Date() } }
    );
  } catch (err) {
    console.error("Error marking worker offline after payment:", err);
  }
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

  const normalizedStatus = String(status || "").trim().toLowerCase();
  const allowedStatuses = new Set(["present", "absent"]);
  if (!allowedStatuses.has(normalizedStatus)) {
    return { code: 400, body: { success: false, message: "Invalid attendance status. Allowed values: Present, Absent" } };
  }
  const canonicalStatus = normalizedStatus === "present" ? "Present" : "Absent";

  if (job.bulkHiring && workerPhone) {
    if (!areSamePhone(userPhone, job.contractorPhone)) {
      return { code: 403, body: { success: false, message: "Only the contractor can mark attendance for this bulk job" } };
    }
    const normalizedWorkerPhone = normalizeWorkerPhone(workerPhone);
    const target = (job.acceptedWorkers || []).find((w) => normalizeWorkerPhone(w?.phone) === normalizedWorkerPhone);
    if (!target) {
      return { code: 404, body: { success: false, message: "Worker not found on this bulk job" } };
    }

    target.attendanceStatus = canonicalStatus;
    target.attendanceTime = new Date();
    if (canonicalStatus === "Present" && job.status === "accepted") {
      job.status = "in_progress";
    }

    const anyPresent = (job.acceptedWorkers || []).some((w) => String(w?.attendanceStatus || "").toLowerCase() === "present");
    job.attendanceStatus = anyPresent ? "Present" : null;
    job.attendanceTime = anyPresent ? target.attendanceTime : null;

    await job.save();

    if (trackingJobs.has(jobId)) trackingJobs.delete(jobId);
    await emitJobUpdatedToUsers(job, [job.contractorPhone, workerPhone, job.acceptedBy || job.contractorPhone]);
    return { code: 200, body: { success: true, job } };
  }

  // 🔐 CRITICAL: Validate that user marking attendance is actually the contractor
  // and that a valid worker has accepted this job
  if (userPhone !== job.contractorPhone) {
    return { code: 403, body: { success: false, message: "Only the contractor can mark attendance" } };
  }

  if (!job.acceptedBy && (!job.acceptedWorkers || job.acceptedWorkers.length === 0)) {
    return { code: 400, body: { success: false, message: "No worker has accepted this job yet" } };
  }

  const oldState = { status: job.status, attendanceStatus: job.attendanceStatus, paymentStatus: job.paymentStatus };
  job.attendanceStatus = canonicalStatus;
  job.attendanceTime = new Date();
  if (canonicalStatus === "Present" && job.status === "accepted") {
    job.status = "in_progress";
  }
  await job.save();

  await logJobEvent({
    jobId: job._id,
    eventType: canonicalStatus === "Present" ? "job_started" : "attendance_marked",
    actorType: "contractor",
    actorPhone: userPhone,
    source: "app",
    oldState,
    newState: { status: job.status, attendanceStatus: job.attendanceStatus, paymentStatus: job.paymentStatus },
    metadata: { attendanceTime: job.attendanceTime },
  });

  if (trackingJobs.has(jobId)) trackingJobs.delete(jobId);
  await emitJobUpdatedToUsers(job, [
    job.contractorPhone,
    job.acceptedBy || job.contractorPhone,
  ]);
  return { code: 200, body: { success: true, job } };
}

async function payJob({ jobId, mode, workerPhone, idempotencyKey, userPhone, userName, deps }) {
  cleanupIdempotencyCache();
  const idemKey = idempotencyKey ? getPayKey({ jobId, workerPhone, mode, idempotencyKey }) : null;
  if (idemKey && payIdempotencyResults.has(idemKey)) {
    return payIdempotencyResults.get(idemKey).result;
  }

  const normalizedWorkerPhone = normalizeWorkerPhone(workerPhone);
  const lockKey = `${jobId}:${normalizedWorkerPhone || "single"}`;
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
  const { updateContractorStats, emitJobUpdatedToUsers, logJobEvent, io } = deps;
  const job = await Job.findById(jobId);
  if (!job) return finalize({ code: 404, body: { message: "Job not found" } });

  if (!areSamePhone(job.contractorPhone, userPhone)) {
    return finalize({ code: 403, body: { success: false, message: "Only the contractor can make payments for this job" } });
  }

  if (["cancelled", "expired"].includes(String(job.status || "").toLowerCase()) || job.isCancelled) {
    return finalize({ code: 400, body: { success: false, message: "Payment not allowed for cancelled or expired jobs" } });
  }

  if (job.bulkHiring && !workerPhone) {
    return finalize({ code: 400, body: { success: false, message: "Worker phone is required for bulk payments" } });
  }

  if (job.bulkHiring && workerPhone) {
    const normalizedWorkerPhone = normalizeWorkerPhone(workerPhone);
    const target = (job.acceptedWorkers || []).find((w) =>
      normalizeWorkerPhone(w?.phone) === normalizedWorkerPhone
    );
    if (!target) {
      return finalize({ code: 404, body: { success: false, message: "Worker not found on this bulk job" } });
    }
    if (String(target.attendanceStatus || "").toLowerCase() !== "present") {
      return finalize({ code: 400, body: { success: false, message: "Payment allowed only for PRESENT workers" } });
    }
    if (String(target.paymentStatus || "").toLowerCase() === "paid") {
      return finalize({ code: 400, body: { success: false, message: "This worker is already paid for this job" } });
    }

    const oldState = { status: job.status, paymentStatus: job.paymentStatus, paymentMode: job.paymentMode, paymentTime: job.paymentTime };
    const oldTargetState = {
      paymentStatus: target.paymentStatus,
      paymentMode: target.paymentMode,
      paymentTime: target.paymentTime,
    };
    target.paymentStatus = "paid";
    target.paymentMode = mode;
    target.paymentTime = new Date();

    const allPaid = (job.acceptedWorkers || []).length > 0 &&
      (job.acceptedWorkers || []).every((w) => w.paymentStatus === "paid");
    if (allPaid) {
      job.paymentStatus = "paid";
      job.paymentTime = target.paymentTime;
      job.status = normalizePaidJobStatus(job.status);
    } else if (job.paymentStatus !== "paid") {
      job.paymentStatus = "pending";
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
        recipientPhone: normalizedWorkerPhone,
        senderPhone: userPhone,
        senderName: userName || job.contractorName || "Contractor",
        type: "payment_received",
        title: `Payment Received: ₹${job.amount}`,
        body: `Payment for ${job.title} has been transferred to your wallet`,
        jobId: job._id,
        metadata: { jobTitle: job.title, amount: job.amount, actionRequired: false, workerPhone: normalizedWorkerPhone },
        deepLink: "worker/wallet",
        pushNotificationSent: false,
      });
    } catch (e) {
      console.error("Error creating payment notification:", e);
    }

    try {
      const normalizedMode = String(mode || "").trim().toLowerCase();
      if (normalizedMode === "cash") {
        // For cash payments, create a pending cash deposit record instead of crediting wallet
        const depositDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

        // ✅ Use upsert to handle idempotency - if duplicate exists, update it instead of failing
        const existingDeposit = await CashDeposit.findOne({
          jobId: job._id,
          workerPhone: normalizedWorkerPhone,
        });

        if (!existingDeposit) {
          console.log(`[jobsLifecycleService] creating CashDeposit jobId=${job._id} workerPhone=${normalizedWorkerPhone} amount=${job.amount} isBulk=true`);
          const created = await CashDeposit.create({
            jobId: job._id,
            workerPhone: normalizedWorkerPhone,
            contractorPhone: job.contractorPhone,
            amount: job.amount,
            status: 'pending',
            paymentMode: 'cash',
            depositDeadline,
            jobTitle: job.title,
            contractorName: job.contractorName,
            workerName: target.name,
            isBulkJob: true,
          });
          console.log(`[jobsLifecycleService] CashDeposit created id=${created?._id}`);
        } else {
          // Update existing deposit if found (idempotency handling)
          await CashDeposit.findOneAndUpdate(
            { jobId: job._id, workerPhone: normalizedWorkerPhone },
            {
              $set: {
                status: 'pending',
                depositDeadline,
                amount: job.amount,
                updatedAt: new Date(),
              }
            },
            { new: true }
          );
        }

        // Send notification to worker about cash deposit requirement
        // Only send if this is a new deposit
        if (!existingDeposit) {
          await NotificationHistory.create({
            recipientPhone: normalizedWorkerPhone,
            senderPhone: userPhone,
            senderName: userName || job.contractorName || "Contractor",
            type: "cash_deposit_required",
            title: `Cash Deposit Required: ₹${job.amount}`,
            body: `You received ₹${job.amount} in cash for "${job.title}". Please deposit this amount back to your app wallet within 24 hours.`,
            jobId: job._id,
            metadata: {
              jobTitle: job.title,
              amount: job.amount,
              actionRequired: true,
              depositDeadline: depositDeadline.toISOString(),
              workerPhone: normalizedWorkerPhone
            },
            deepLink: "worker/wallet",
            pushNotificationSent: false,
          });
        }
      } else {
        // For non-cash payments, credit wallet immediately
        let workerWallet = await Wallet.findOne({ phone: normalizedWorkerPhone });
        if (!workerWallet) {
          workerWallet = new Wallet({ phone: normalizedWorkerPhone, balance: 0, availableBalance: 0, pocketBalance: 0 });
          await workerWallet.save();
        }

        const creditAmount = Number(job.amount) || 0;
        if (creditAmount <= 0) {
          console.error("Invalid payment amount for job:", job._id);
          throw new Error("Invalid payment amount");
        }

        const updatedWorkerWallet = await Wallet.findOneAndUpdate(
          { phone: normalizedWorkerPhone },
          {
            $inc: {
              balance: creditAmount,
              availableBalance: creditAmount,
              totalEarned: creditAmount
            },
            $push: {
              transactions: {
                type: "payment",
                amount: creditAmount,
                date: new Date(),
                jobId: job._id,
                source: "app",
                provider: "internal",
                status: "completed",
                description: `Job payment credited to available balance (${job.title})`,
                metadata: { balanceType: "available", workerPhone: normalizedWorkerPhone },
              }
            }
          },
          { new: true }
        );

        if (!updatedWorkerWallet) {
          throw new Error("Failed to update worker wallet");
        }
      }
    } catch (walletErr) {
      console.error("Error processing bulk payment:", walletErr);
      await rollbackJobPayment(job, oldState, target, oldTargetState);
      return finalize({ code: 500, body: { success: false, message: "Payment failed. Job state rolled back." } });
    }

    try {
      await upsertWorkerEarningForJobPayment({
        job,
        workerPhone: normalizedWorkerPhone,
        amount: job.amount,
        mode,
      });
    } catch (earnErr) {
      console.error("Error upserting WorkerEarnings after bulk payment:", earnErr);
    }

    try {
      await updateGigDataOnCompletion(normalizedWorkerPhone, {
        jobId: job._id.toString(),
        title: job.title,
        amount: job.amount,
        workerType: job.workerType,
        timeSpentMinutes: job.timeSpentMinutes || 0,
      });
    } catch (e) {
      console.error("Error updating gigs data on completion:", e);
    }

    await setWorkerOfflineByPhone(normalizedWorkerPhone);
    if (io && normalizedWorkerPhone) {
      try {
        io.to(normalizedWorkerPhone).emit("workerStatusUpdate", {
          isAvailable: false,
          phone: normalizedWorkerPhone,
          source: "payment",
          jobId: job._id.toString(),
          timestamp: new Date(),
        });
      } catch (emitErr) {
        console.error("Error emitting workerStatusUpdate after bulk payment:", emitErr);
      }
    }
    await updateContractorStats(userPhone);
    await emitJobUpdatedToUsers(job, [job.contractorPhone, normalizedWorkerPhone, job.acceptedBy || job.contractorPhone]);
    return finalize({ code: 200, body: { success: true, message: "Payment successful", job, workerPhone: normalizedWorkerPhone } });
  }

  if (job.attendanceStatus !== "Present") {
    return finalize({ code: 400, body: { success: false, message: "Payment allowed only for PRESENT workers" } });
  }

  const oldState = { status: job.status, paymentStatus: job.paymentStatus, paymentMode: job.paymentMode, paymentTime: job.paymentTime };
  job.paymentStatus = "paid";
  job.paymentMode = mode;
  job.paymentTime = new Date();
  job.status = normalizePaidJobStatus(job.status);
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
    // 🔐 CRITICAL: Verify contractor has sufficient funds before crediting worker (phantom credit prevention)
    const contractorWallet = await Wallet.findOne({ phone: job.contractorPhone });
    if (!contractorWallet) {
      console.warn(`Warning: Contractor wallet not found for ${job.contractorPhone}`);
    }

    const creditAmount = Number(job.amount) || 0;
    if (creditAmount <= 0) {
      console.error("Invalid payment amount for job:", job._id);
      return finalize({ code: 400, body: { success: false, message: "Invalid payment amount" } });
    }

    const normalizedMode = String(mode || "").trim().toLowerCase();
    if (normalizedMode === "cash") {
      // For cash payments, create a pending cash deposit record instead of crediting wallet
      const depositDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

      // ✅ Use upsert to handle idempotency - if duplicate exists, update it instead of failing
      const existingDeposit = await CashDeposit.findOne({
        jobId: job._id,
        workerPhone: job.acceptedBy,
      });

      if (!existingDeposit) {
        console.log(`[jobsLifecycleService] creating CashDeposit jobId=${job._id} workerPhone=${job.acceptedBy} amount=${job.amount} isBulk=false`);
        const created = await CashDeposit.create({
          jobId: job._id,
          workerPhone: job.acceptedBy,
          contractorPhone: job.contractorPhone,
          amount: job.amount,
          status: 'pending',
          paymentMode: 'cash',
          depositDeadline,
          jobTitle: job.title,
          contractorName: job.contractorName,
          workerName: job.acceptedWorker?.name,
          isBulkJob: false,
        });
        console.log(`[jobsLifecycleService] CashDeposit created id=${created?._id}`);
      } else {
        // Update existing deposit if found (idempotency handling)
        await CashDeposit.findOneAndUpdate(
          { jobId: job._id, workerPhone: job.acceptedBy },
          {
            $set: {
              status: 'pending',
              depositDeadline,
              amount: job.amount,
              updatedAt: new Date(),
            }
          },
          { new: true }
        );
      }

      // Send notification to worker about cash deposit requirement
      // Only send if this is a new deposit
      if (!existingDeposit) {
        await NotificationHistory.create({
          recipientPhone: job.acceptedBy,
          senderPhone: userPhone,
          senderName: userName || job.contractorName || "Contractor",
          type: "cash_deposit_required",
          title: `Cash Deposit Required: ₹${job.amount}`,
          body: `You received ₹${job.amount} in cash for "${job.title}". Please deposit this amount back to your app wallet within 24 hours.`,
          jobId: job._id,
          metadata: {
            jobTitle: job.title,
            amount: job.amount,
            actionRequired: true,
            depositDeadline: depositDeadline.toISOString(),
          },
          deepLink: "worker/wallet",
          pushNotificationSent: false,
        });
      }
    } else {
      // For non-cash payments, credit wallet immediately
      const updatedWorkerWallet = await Wallet.findOneAndUpdate(
        { phone: job.acceptedBy },
        {
          $inc: {
            balance: creditAmount,
            availableBalance: creditAmount,
            totalEarned: creditAmount
          },
          $push: {
            transactions: {
              type: "payment",
              amount: creditAmount,
              date: new Date(),
              jobId: job._id,
              source: "app",
              provider: "internal",
              status: "completed",
              description: `Job payment credited to available balance (${job.title})`,
              metadata: { balanceType: "available" },
            }
          }
        },
        { new: true, upsert: true }
      );

      if (!updatedWorkerWallet) {
        throw new Error("Failed to update worker wallet");
      }
    }
  } catch (walletErr) {
    console.error("Error processing payment:", walletErr);
    await rollbackJobPayment(job, oldState);
    return finalize({ code: 500, body: { success: false, message: "Payment failed. Job state rolled back." } });
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
        paymentStatus: "paid",
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

  if (normalizedWorkerPhone || job.acceptedBy) {
    await setWorkerOfflineByPhone(normalizedWorkerPhone || job.acceptedBy);
  }

  await updateContractorStats(userPhone);

  try {
    const targetPhone = normalizedWorkerPhone || job.acceptedBy;
    if (io && targetPhone) {
      try {
        io.to(targetPhone).emit("workerStatusUpdate", {
          isAvailable: false,
          phone: targetPhone,
          source: "payment",
          jobId: job._id.toString(),
          timestamp: new Date(),
        });
      } catch (emitErr) {
        console.error("Error emitting workerStatusUpdate after payment:", emitErr);
      }

      // ✅ CRITICAL: Emit real-time cash deposit update for cash payments
      const normalizedMode = String(mode || "").trim().toLowerCase();
      if (normalizedMode === "cash") {
        try {
          const cashDeposit = await CashDeposit.findOne({
            jobId: job._id,
            workerPhone: targetPhone,
          });
          if (cashDeposit) {
            // Notify worker about pending cash deposit
            console.log(`[jobsLifecycleService] emitting cashDepositCreated to ${targetPhone} depositId=${cashDeposit._id}`);
            io.to(targetPhone).emit("cashDepositCreated", {
              depositId: cashDeposit._id,
              jobId: job._id,
              amount: job.amount,
              depositDeadline: cashDeposit.depositDeadline,
              jobTitle: job.title,
              timestamp: new Date(),
            });
          }
        } catch (cashEmitErr) {
          console.error("Error emitting cashDepositCreated event:", cashEmitErr);
        }
      }
    }

    await updateGigDataOnCompletion(targetPhone, {
      jobId: job._id.toString(),
      title: job.title,
      amount: job.amount,
      workerType: job.workerType,
      timeSpentMinutes: job.timeSpentMinutes || 0,
    });
  } catch (e) {
    console.error("Error updating gigs data on completion:", e);
  }

  // ✅ CRITICAL: Emit job update to both contractor and worker so UI updates in real-time
  await emitJobUpdatedToUsers(job, [job.contractorPhone, normalizedWorkerPhone || job.acceptedBy || job.contractorPhone]);

  // ✅ CRITICAL: Emit wallet update to contractor for real-time UI refresh
  if (io && job.contractorPhone) {
    try {
      const normalizedMode = String(mode || "").trim().toLowerCase();
      if (normalizedMode === "cash") {
        // For cash payments, emit a specific cash payment notification
        io.to(job.contractorPhone).emit("cashPaymentCreated", {
          jobId: job._id,
          workerId: normalizedWorkerPhone || job.acceptedBy,
          amount: job.amount,
          jobTitle: job.title,
          timestamp: new Date(),
          message: `Cash payment initiated for ₹${job.amount}`,
        });
      }
    } catch (contractorEmitErr) {
      console.error("Error emitting cash payment event to contractor:", contractorEmitErr);
    }
  }
  return finalize({ code: 200, body: { success: true, message: "Payment successful", job } });
  } catch (err) {
    payInFlightLocks.delete(lockKey);
    throw err;
  }
}

async function depositCash({ jobId, workerPhone, idempotencyKey, deps }) {
  const { emitJobUpdatedToUsers, logJobEvent, io } = deps;

  // Normalize phone number
  const normalizedWorkerPhone = normalizeWorkerPhone(workerPhone);

  // Check for idempotency
  const depositKey = `${jobId}:${normalizedWorkerPhone || ""}:${idempotencyKey || ""}`;
  if (depositIdempotencyResults.has(depositKey)) {
    return depositIdempotencyResults.get(depositKey).result;
  }

  const lockKey = `${jobId}:${normalizedWorkerPhone}`;
  if (depositInFlightLocks.has(lockKey)) {
    return { code: 409, body: { success: false, message: "Deposit already processing. Please wait." } };
  }
  depositInFlightLocks.set(lockKey, true);

  const finalize = (result) => {
    depositInFlightLocks.delete(lockKey);
    if (idempotencyKey) {
      depositIdempotencyResults.set(depositKey, {
        result,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      });
    }
    return result;
  };

  try {
    // Find the cash deposit record
    const cashDeposit = await CashDeposit.findOne({
      jobId,
      workerPhone: normalizedWorkerPhone,
      status: 'pending'
    });

    if (!cashDeposit) {
      return finalize({ code: 404, body: { success: false, message: "No pending cash deposit found for this job" } });
    }

    // Check if deposit deadline has passed
    if (new Date() > cashDeposit.depositDeadline) {
      cashDeposit.status = 'expired';
      await cashDeposit.save();
      return finalize({ code: 400, body: { success: false, message: "Cash deposit deadline has expired" } });
    }

    // Find the job to verify it's still valid
    const job = await Job.findById(jobId);
    if (!job) {
      return finalize({ code: 404, body: { success: false, message: "Job not found" } });
    }

    if (job.status !== 'completed' || job.paymentStatus !== 'paid' || job.paymentMode !== 'cash') {
      return finalize({ code: 400, body: { success: false, message: "Job is not in a valid state for cash deposit" } });
    }

    // Update cash deposit status
    cashDeposit.status = 'completed';
    cashDeposit.depositedAt = new Date();
    await cashDeposit.save();

    // Credit the worker's wallet
    const updatedWorkerWallet = await Wallet.findOneAndUpdate(
      { phone: normalizedWorkerPhone },
      {
        $inc: {
          balance: cashDeposit.amount,
          availableBalance: cashDeposit.amount,
          totalEarned: cashDeposit.amount
        },
        $push: {
          transactions: {
            type: "cash_deposit",
            amount: cashDeposit.amount,
            date: new Date(),
            jobId: job._id,
            source: "app",
            provider: "cash_deposit",
            status: "completed",
            description: `Cash deposit credited to available balance (${job.title})`,
            metadata: { balanceType: "available", workerPhone: normalizedWorkerPhone },
          }
        }
      },
      { new: true, upsert: true }
    );

    if (!updatedWorkerWallet) {
      throw new Error("Failed to update worker wallet after cash deposit");
    }

    // Update gig data and earnings
    try {
      await upsertWorkerEarningForJobPayment({
        job,
        workerPhone: normalizedWorkerPhone,
        amount: cashDeposit.amount,
        mode: 'cash',
      });
    } catch (earnErr) {
      console.error("Error upserting WorkerEarnings after cash deposit:", earnErr);
    }

    try {
      await updateGigDataOnCompletion(normalizedWorkerPhone, {
        jobId: job._id.toString(),
        title: job.title,
        amount: cashDeposit.amount,
        workerType: job.workerType,
        timeSpentMinutes: job.timeSpentMinutes || 0,
      });
    } catch (e) {
      console.error("Error updating gigs data on cash deposit:", e);
    }

    // Log the deposit event
    await logJobEvent({
      jobId: job._id,
      eventType: "cash_deposit_completed",
      actorType: "worker",
      actorPhone: normalizedWorkerPhone,
      source: "app",
      oldState: { cashDepositStatus: 'pending' },
      newState: { cashDepositStatus: 'completed' },
      metadata: { amount: cashDeposit.amount, depositedAt: cashDeposit.depositedAt },
    });

    // Send confirmation notification
    try {
      await NotificationHistory.create({
        recipientPhone: normalizedWorkerPhone,
        senderPhone: job.contractorPhone,
        senderName: job.contractorName || "Contractor",
        type: "cash_deposit_completed",
        title: `Cash Deposit Confirmed: ₹${cashDeposit.amount}`,
        body: `Your cash deposit for "${job.title}" has been confirmed. The amount is now available in your wallet.`,
        jobId: job._id,
        metadata: {
          jobTitle: job.title,
          amount: cashDeposit.amount,
          actionRequired: false,
        },
        deepLink: "worker/wallet",
        pushNotificationSent: false,
      });
    } catch (e) {
      console.error("Error creating cash deposit notification:", e);
    }

    // Emit real-time updates
    await emitJobUpdatedToUsers(job, [job.contractorPhone, normalizedWorkerPhone]);

    if (io && normalizedWorkerPhone) {
      try {
        io.to(normalizedWorkerPhone).emit("walletUpdated", {
          phone: normalizedWorkerPhone,
          type: "cash_deposit",
          amount: cashDeposit.amount,
          balance: Number(updatedWorkerWallet.balance || 0),
          availableBalance: Number(updatedWorkerWallet.availableBalance ?? updatedWorkerWallet.balance ?? 0),
          pocketBalance: Number(updatedWorkerWallet.pocketBalance || 0),
          message: `Cash deposit credited: ₹${cashDeposit.amount}`,
        });
      } catch (emitErr) {
        console.error("Error emitting wallet update after cash deposit:", emitErr);
      }
    }

    return finalize({
      code: 200,
      body: {
        success: true,
        message: "Cash deposit successful",
        job,
        cashDeposit,
        wallet: {
          balance: updatedWorkerWallet.balance,
          availableBalance: updatedWorkerWallet.availableBalance,
          pocketBalance: updatedWorkerWallet.pocketBalance
        }
      }
    });

  } catch (err) {
    console.error("Error processing cash deposit:", err);
    depositInFlightLocks.delete(lockKey);
    throw err;
  }
}

async function depositCashById({ depositId, workerPhone, idempotencyKey, deps }) {
  const { emitJobUpdatedToUsers, logJobEvent, io } = deps;

  // Normalize phone number
  const normalizedWorkerPhone = normalizeWorkerPhone(workerPhone);

  // Check for idempotency
  const depositKey = `deposit:${depositId}:${normalizedWorkerPhone || ""}:${idempotencyKey || ""}`;
  if (depositIdempotencyResults.has(depositKey)) {
    return depositIdempotencyResults.get(depositKey).result;
  }

  const lockKey = `deposit:${depositId}:${normalizedWorkerPhone}`;
  if (depositInFlightLocks.has(lockKey)) {
    return { code: 409, body: { success: false, message: "Deposit already processing. Please wait." } };
  }
  depositInFlightLocks.set(lockKey, true);

  const finalize = (result) => {
    depositInFlightLocks.delete(lockKey);
    if (idempotencyKey) {
      depositIdempotencyResults.set(depositKey, {
        result,
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
      });
    }
    return result;
  };

  try {
    // Find the cash deposit record by ID
    const cashDeposit = await CashDeposit.findById(depositId);

    if (!cashDeposit) {
      return finalize({ code: 404, body: { success: false, message: "Cash deposit not found" } });
    }

    // Verify the deposit belongs to the requesting worker
    if (cashDeposit.workerPhone !== normalizedWorkerPhone) {
      return finalize({ code: 403, body: { success: false, message: "You are not authorized to deposit this cash" } });
    }

    if (cashDeposit.status !== 'pending') {
      return finalize({ code: 400, body: { success: false, message: `Cash deposit is already ${cashDeposit.status}` } });
    }

    // Check if deposit deadline has passed
    if (new Date() > cashDeposit.depositDeadline) {
      cashDeposit.status = 'expired';
      await cashDeposit.save();
      return finalize({ code: 400, body: { success: false, message: "Cash deposit deadline has expired" } });
    }

    // Find the job to verify it's still valid
    const job = await Job.findById(cashDeposit.jobId);
    if (!job) {
      return finalize({ code: 404, body: { success: false, message: "Associated job not found" } });
    }

    if (job.status !== 'completed' || job.paymentStatus !== 'paid' || job.paymentMode !== 'cash') {
      return finalize({ code: 400, body: { success: false, message: "Job is not in a valid state for cash deposit" } });
    }

    // Update cash deposit status
    cashDeposit.status = 'completed';
    cashDeposit.depositedAt = new Date();
    await cashDeposit.save();

    // Credit the worker's wallet
    const updatedWorkerWallet = await Wallet.findOneAndUpdate(
      { phone: normalizedWorkerPhone },
      {
        $inc: {
          balance: cashDeposit.amount,
          availableBalance: cashDeposit.amount,
          totalEarned: cashDeposit.amount
        },
        $push: {
          transactions: {
            type: "cash_deposit",
            amount: cashDeposit.amount,
            date: new Date(),
            jobId: job._id,
            source: "app",
            provider: "cash_deposit",
            status: "completed",
            description: `Cash deposit credited to available balance (${job.title})`,
            metadata: { balanceType: "available", workerPhone: normalizedWorkerPhone },
          }
        }
      },
      { new: true, upsert: true }
    );

    if (!updatedWorkerWallet) {
      throw new Error("Failed to update worker wallet after cash deposit");
    }

    // Update gig data and earnings
    try {
      await upsertWorkerEarningForJobPayment({
        job,
        workerPhone: normalizedWorkerPhone,
        amount: cashDeposit.amount,
        mode: 'cash',
      });
    } catch (earnErr) {
      console.error("Error upserting WorkerEarnings after cash deposit:", earnErr);
    }

    try {
      await updateGigDataOnCompletion(normalizedWorkerPhone, {
        jobId: job._id.toString(),
        title: job.title,
        amount: cashDeposit.amount,
        workerType: job.workerType,
        timeSpentMinutes: job.timeSpentMinutes || 0,
      });
    } catch (e) {
      console.error("Error updating gigs data on cash deposit:", e);
    }

    // Log the deposit event
    await logJobEvent({
      jobId: job._id,
      eventType: "cash_deposit_completed",
      actorType: "worker",
      actorPhone: normalizedWorkerPhone,
      source: "app",
      oldState: { cashDepositStatus: 'pending' },
      newState: { cashDepositStatus: 'completed' },
      metadata: { amount: cashDeposit.amount, depositedAt: cashDeposit.depositedAt },
    });

    // Send confirmation notification
    try {
      await NotificationHistory.create({
        recipientPhone: normalizedWorkerPhone,
        senderPhone: job.contractorPhone,
        senderName: job.contractorName || "Contractor",
        type: "cash_deposit_completed",
        title: `Cash Deposit Confirmed: ₹${cashDeposit.amount}`,
        body: `Your cash deposit for "${job.title}" has been confirmed. The amount is now available in your wallet.`,
        jobId: job._id,
        metadata: {
          jobTitle: job.title,
          amount: cashDeposit.amount,
          actionRequired: false,
        },
        deepLink: "worker/wallet",
        pushNotificationSent: false,
      });
    } catch (e) {
      console.error("Error creating cash deposit notification:", e);
    }

    // Emit real-time updates
    await emitJobUpdatedToUsers(job, [job.contractorPhone, normalizedWorkerPhone]);

    if (io && normalizedWorkerPhone) {
      try {
        io.to(normalizedWorkerPhone).emit("walletUpdated", {
          phone: normalizedWorkerPhone,
          type: "cash_deposit",
          amount: cashDeposit.amount,
          balance: Number(updatedWorkerWallet.balance || 0),
          availableBalance: Number(updatedWorkerWallet.availableBalance ?? updatedWorkerWallet.balance ?? 0),
          pocketBalance: Number(updatedWorkerWallet.pocketBalance || 0),
          message: `Cash deposit credited: ₹${cashDeposit.amount}`,
        });
      } catch (emitErr) {
        console.error("Error emitting wallet update after cash deposit:", emitErr);
      }
    }

    return finalize({
      code: 200,
      body: {
        success: true,
        message: "Cash deposit successful",
        job,
        cashDeposit,
        wallet: {
          balance: updatedWorkerWallet.balance,
          availableBalance: updatedWorkerWallet.availableBalance,
          pocketBalance: updatedWorkerWallet.pocketBalance
        }
      }
    });

  } catch (err) {
    console.error("Error processing cash deposit by ID:", err);
    depositInFlightLocks.delete(lockKey);
    throw err;
  }
}

async function rateJob({ jobId, stars, feedback, workerPhone, userPhone, userName, deps }) {
  if (!stars || stars < 1 || stars > 5) {
    return { code: 400, body: { message: "Rating must be between 1 and 5 stars" } };
  }

  // 🔐 Fetch fresh job state to prevent race conditions (multiple rating attempts)
  const job = await Job.findById(jobId);
  if (!job) return { code: 404, body: { message: "Job not found" } };

  if (!areSamePhone(job.contractorPhone, userPhone)) {
    return { code: 403, body: { success: false, message: "Only the contractor can rate this worker" } };
  }

  const isBulkTarget = job.bulkHiring && workerPhone;
  let ratingTargetPhone = workerPhone || job.acceptedWorker?.phone || job.acceptedBy;

  // 🔐 EDGE CASE: Rating attempted before payment settled
  // Webhook may still be processing or payment response not received yet
  // Must enforce strict payment state validation
  if (isBulkTarget) {
    const normalizedWorkerPhone = normalizeWorkerPhone(workerPhone);
    const target = (job.acceptedWorkers || []).find((w) => normalizeWorkerPhone(w?.phone) === normalizedWorkerPhone);
    if (!target) {
      return { code: 404, body: { success: false, message: "Worker not found on this bulk job" } };
    }
    
    // 🔐 STRICT: Only "paid" status allows rating (not "authorized" or "captured")
    const normalizedPaymentStatus = String(target.paymentStatus || "").toLowerCase();
    if (normalizedPaymentStatus !== "paid") {
      return { code: 400, body: { success: false, message: `Can only rate workers with payment status 'paid'. Current status: ${normalizedPaymentStatus}. Please wait for payment settlement.` } };
    }
    
    if (target.attendanceStatus !== "Present") {
      return { code: 400, body: { success: false, message: "Can only rate workers marked as Present" } };
    }
    
    // 🔐 EDGE CASE: User submits rating twice (duplicate submission)
    // Return success idempotently if same rating submitted again
    if (target.rating?.stars) {
      const existingRating = target.rating;
      // If attempting exact same rating, return success (idempotent)
      if (existingRating.stars === parseInt(stars, 10) && existingRating.feedback === (feedback || "")) {
        return { code: 200, body: { success: true, message: "Rating already submitted", isDuplicate: true, job } };
      }
      // Different rating attempt on already-rated worker = block with clear message
      return { code: 400, body: { success: false, message: "Rating is final. Cannot change an existing rating. Contact support if changes needed." } };
    }
    
    target.rating = {
      stars: parseInt(stars, 10),
      feedback: feedback || "",
      ratedAt: new Date(),
      ratedBy: userPhone || job.contractorName,
    };
  } else {
    // 🔐 STRICT: Only "paid" status allows rating (not "authorized" or "captured")
    const normalizedPaymentStatus = String(job.paymentStatus || "").toLowerCase();
    if (normalizedPaymentStatus !== "paid") {
      return { code: 400, body: { message: `Can only rate jobs with payment status 'paid'. Current status: ${normalizedPaymentStatus}. Please wait for payment settlement.` } };
    }
    
    if (job.attendanceStatus !== "Present") {
      return { code: 400, body: { message: "Can only rate workers marked as Present" } };
    }
    
    // 🔐 EDGE CASE: Duplicate rating submission
    if (job.rating?.stars) {
      const existingRating = job.rating;
      // If attempting exact same rating, return success (idempotent)
      if (existingRating.stars === parseInt(stars, 10) && existingRating.feedback === (feedback || "")) {
        return { code: 200, body: { success: true, message: "Rating already submitted", isDuplicate: true, job } };
      }
      // Different rating attempt on already-rated job = block
      return { code: 400, body: { success: false, message: "Rating is final. Cannot change an existing rating. Contact support if changes needed." } };
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

  await emitJobUpdatedToUsers(job, [job.contractorPhone, job.acceptedBy || job.contractorPhone]);
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

  if (job.paymentStatus !== "paid" || job.status !== "completed") {
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
        paymentStatus: "paid",
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

  await emitJobUpdatedToUsers(job, [job.contractorPhone, job.acceptedBy || job.contractorPhone]);
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

  let cancellationFee = 0;
  let cancelledBy = "admin";
  if (areSamePhone(userPhone, job.contractorPhone)) cancelledBy = "contractor";
  if (areSamePhone(userPhone, job.acceptedBy)) cancelledBy = "worker";
  if (cancelledBy === "worker" && Array.isArray(job.acceptedWorkers)) {
    const acceptedWorkerIndex = job.acceptedWorkers.findIndex((w) => areSamePhone(w?.phone, userPhone));
    if (acceptedWorkerIndex !== -1) cancelledBy = "worker";
  }

  if (cancelledBy === "worker") {
    const allowed = new Set(["accepted", "in_progress"]);
    if (!allowed.has(job.status)) {
      return finalize({
        code: 403,
        body: {
          success: false,
          message: "Worker cancel is only allowed for accepted or in_progress jobs.",
        },
      });
    }

    if (String(job.paymentStatus || "").toLowerCase() === "paid" || job.status === "completed") {
      return finalize({
        code: 403,
        body: {
          success: false,
          message: "Cancellation is not allowed after payment or completion.",
        },
      });
    }

    const normalizedWorkerPhone = normalizeWorkerPhone(userPhone);
    const acceptedWorkerEntry = Array.isArray(job.acceptedWorkers)
      ? job.acceptedWorkers.find((w) => normalizeWorkerPhone(w?.phone) === normalizedWorkerPhone)
      : null;
    const acceptanceTime = acceptedWorkerEntry?.acceptedAt
      ? new Date(acceptedWorkerEntry.acceptedAt)
      : job.acceptedAt
      ? new Date(job.acceptedAt)
      : null;

    if (!acceptanceTime || Number.isNaN(acceptanceTime.getTime())) {
      return finalize({
        code: 400,
        body: {
          success: false,
          message: "Cannot determine accepted time for cancellation policy.",
        },
      });
    }

    const minutesSinceAcceptance = Math.round((Date.now() - acceptanceTime.getTime()) / 60000);
    if (minutesSinceAcceptance > WORKER_CANCEL_WINDOW_MINUTES) {
      cancellationFee = WORKER_CANCEL_LATE_FEE;
    }

    const worker = await WorkerModel.findOne({ phone: userPhone });
    if (worker) {
      const cutoff = new Date(Date.now() - WORKER_CANCEL_WINDOW_HOURS * 60 * 60 * 1000);
      const recentCancellations = (worker.gigsData?.cancellationDates || []).filter((date) => date && new Date(date) >= cutoff);
      if (recentCancellations.length >= WORKER_CANCEL_MAX_IN_WINDOW) {
        worker.isBlocked = true;
        worker.blockedReason = "Exceeded worker cancellation limit";
        await worker.save();

        return finalize({
          code: 429,
          body: {
            success: false,
            message: "Cancellation blocked because your cancellation rate is too high. Please contact support.",
          },
        });
      }

      if (minutesSinceAcceptance > WORKER_CANCEL_WINDOW_MINUTES) {
        worker.riskFlags = Array.isArray(worker.riskFlags) ? worker.riskFlags : [];
        if (!worker.riskFlags.includes("late_cancellation")) {
          worker.riskFlags.push("late_cancellation");
        }
        await worker.save();
      }
    }
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

  const hasAssignedWorker =
    Boolean(job.acceptedBy) ||
    (Array.isArray(job.acceptedWorkers) && job.acceptedWorkers.some((w) => Boolean(w?.phone)));

  let refundAmount = 0;
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
  let reopened = false;
  if (cancelledBy === "worker") {
    const isAcceptedReopen = job.status === "accepted";
    const isInProgressCancel = job.status === "in_progress";

    if (job.bulkHiring) {
      const normalizedUserPhone = normalizeWorkerPhone(userPhone);
      job.acceptedWorkers = (job.acceptedWorkers || []).filter(
        (w) => normalizeWorkerPhone(w?.phone) !== normalizedUserPhone
      );
      const remaining = job.acceptedWorkers.length;
      const anyPresent = job.acceptedWorkers.some((w) => String(w?.attendanceStatus || "") === "Present");
      job.attendanceStatus = anyPresent ? "Present" : null;
      job.attendanceTime = anyPresent ? new Date() : null;

      if (isAcceptedReopen) {
        if (remaining < (job.requiredWorkers || 1)) {
          job.status = "pending";
        }
        reopened = true;
      } else if (isInProgressCancel) {
        if (remaining > 0) {
          job.status = "in_progress";
        } else {
          job.status = "cancelled";
          job.isCancelled = true;
          job.cancelledAt = cancellation.cancelledAt;
          job.cancelledBy = cancelledBy;
          job.cancellationReason = normalizedReason;
          job.cancellationReasonDescription = normalizedReasonDescription || null;
        }
      }
    } else if (isAcceptedReopen) {
      job.status = "pending";
      job.acceptedBy = null;
      job.acceptedWorker = null;
      job.acceptedAt = null;
      reopened = true;
    } else if (isInProgressCancel) {
      job.status = "cancelled";
      job.isCancelled = true;
      job.cancelledAt = cancellation.cancelledAt;
      job.cancelledBy = cancelledBy;
      job.cancellationReason = normalizedReason;
      job.cancellationReasonDescription = normalizedReasonDescription || null;
    }

    if (reopened) {
      job.attendanceStatus = null;
      job.attendanceTime = null;
      job.isCancelled = false;
      job.cancelledAt = null;
      job.cancelledBy = null;
      job.cancellationReason = null;
      job.cancellationReasonDescription = null;
    }
  } else {
    job.status = "cancelled";
    job.isCancelled = true;
    job.cancelledAt = cancellation.cancelledAt;
    job.cancelledBy = cancelledBy;
    job.cancellationReason = normalizedReason;
    job.cancellationReasonDescription = normalizedReasonDescription || null;
    job.attendanceStatus = null;
    job.attendanceTime = null;
  }

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
    status: job.status,
    cancelledBy,
    cancelledAt: cancellation.cancelledAt,
  };
  const targetUsers = [
    job.contractorPhone,
    job.acceptedBy,
    ...(Array.isArray(job.acceptedWorkers) ? job.acceptedWorkers.map((w) => w?.phone).filter(Boolean) : []),
  ];

  if (reopened) {
    if (typeof emitJobUpdatedToUsers === "function") {
      await emitJobUpdatedToUsers(cancellationPayload, targetUsers);
    } else {
      io.emit("jobUpdated", cancellationPayload);
    }
    if (typeof deps?.offerJobToNextWorker === "function") {
      try {
        await deps.offerJobToNextWorker(job);
      } catch (err) {
        console.error("Error auto reassigning job after worker cancellation:", err);
      }
    }
  } else {
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

async function getCashDeposits({ workerPhone }) {
  const normalizedWorkerPhone = normalizeWorkerPhone(workerPhone);

  try {
    console.log(`[jobsLifecycleService] getCashDeposits for workerPhone=${workerPhone}, normalized=${normalizedWorkerPhone}`);
    const deposits = await CashDeposit.find({
      workerPhone: normalizedWorkerPhone,
      status: { $in: ['pending', 'expired'] }
    })
    .populate('jobId', 'title amount contractorName')
    .sort({ createdAt: -1 })
    .lean();
    console.log(`[jobsLifecycleService] found ${Array.isArray(deposits) ? deposits.length : 0} deposits`);

    return {
      code: 200,
      body: {
        success: true,
        deposits: deposits.map(deposit => ({
          id: deposit._id,
          jobId: deposit.jobId?._id,
          jobTitle: deposit.jobId?.title || deposit.jobTitle,
          amount: deposit.amount,
          status: deposit.status,
          depositDeadline: deposit.depositDeadline,
          createdAt: deposit.createdAt,
          contractorName: deposit.jobId?.contractorName || deposit.contractorName,
        }))
      }
    };
  } catch (err) {
    console.error("Error fetching cash deposits:", err);
    return {
      code: 500,
      body: { success: false, message: "Error fetching cash deposits" }
    };
  }
}

module.exports = {
  markAttendance,
  payJob,
  depositCash,
  depositCashById,
  getCashDeposits,
  rateJob,
  rateContractor,
  cancelJob,
  getCancellations,
};
