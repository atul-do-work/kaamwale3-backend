const mongoose = require("mongoose");

const workerSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  skills: { type: [String], default: [] },
  mainSkill: { type: String, default: null }, // ✅ Primary skill for quick display
  rating: { type: Number, default: 5 },
  isAvailable: { type: Boolean, default: true },
  socketId: { type: String, default: "" },

  location: {
    type: { type: String, enum: ["Point"], default: "Point" },
    coordinates: { type: [Number], default: [0, 0] }, // [longitude, latitude]
  },

  // ✅ Gigs Data for Incentive Tracking
  gigsData: {
    // Consecutive work days tracking
    consecutiveDays: { type: Number, default: 0 },
    lastWorkDate: { type: Date, default: null },
    streakStartDate: { type: Date, default: null },

    // Hours tracking
    totalHours: { type: Number, default: 0 },
    hoursPerDay: { type: Map, of: Number, default: {} }, // { "2026-02-08": 8, "2026-02-09": 7 }

    // Cancellation tracking
    totalCancellations: { type: Number, default: 0 },
    cancellationDates: { type: [Date], default: [] },

    // Gig statistics
    totalGigsAccepted: { type: Number, default: 0 },
    totalGigsCompleted: { type: Number, default: 0 },
    totalGigsCancelled: { type: Number, default: 0 },
    totalGigsPending: { type: Number, default: 0 },

    // Earnings tracking
    totalEarnings: { type: Number, default: 0 },
    earningsPerDay: { type: Map, of: Number, default: {} }, // { "2026-02-08": 500, "2026-02-09": 420 }

    // Milestone tracking
    milestonesUnlocked: {
      fiveDaysMilestone: { type: Boolean, default: false, unlockedDate: Date },
      tenDaysMilestone: { type: Boolean, default: false, unlockedDate: Date },
      twentyDaysMilestone: { type: Boolean, default: false, unlockedDate: Date },
    },

    // Incentive eligibility (real-time tracking)
    eligibleFor5Days: { type: Boolean, default: false },
    eligibleFor10Days: { type: Boolean, default: false },
    eligibleFor20Days: { type: Boolean, default: false },

    // Last update timestamp
    lastUpdated: { type: Date, default: Date.now },
    // Work history - sliding window to evaluate consecutive-day milestones
    workHistory: [{ date: Date, hours: Number, cancelled: { type: Boolean, default: false } }],
  },

  // ✅ Recent gigs summary (last 10 gigs)
  recentGigs: [{
    jobId: mongoose.Schema.Types.ObjectId,
    title: String,
    amount: Number,
    date: Date,
    status: { type: String, enum: ['accepted', 'completed', 'cancelled', 'pending'], default: 'pending' },
    paymentStatus: { type: String, enum: ['Paid', 'Pending', 'Failed'], default: 'Pending' },
    contractorName: String,
    rating: {
      stars: { type: Number, min: 1, max: 5 },
      feedback: String,
      ratedAt: Date,
      ratedBy: String,
    },
    acceptedAt: Date,
    completedAt: Date,
    cancelledAt: Date,
    paymentTime: Date,
    hoursWorked: { type: Number, default: 0 },
  }],

  // ✅ Performance metrics
  performanceMetrics: {
    completionRate: { type: Number, default: 0 }, // percentage
    averageRating: { type: Number, default: 0 },
    totalReviews: { type: Number, default: 0 },
    cancellationRate: { type: Number, default: 0 }, // percentage
    averageHoursPerGig: { type: Number, default: 0 },
    averageEarningsPerGig: { type: Number, default: 0 },
  },

  // ✅ Decline tracking for worker behavior analytics
  declineTracking: {
    totalDeclines: { type: Number, default: 0 }, // Total job declines ever
    monthlyDeclines: { type: Map, of: Number, default: {} }, // { "2026-02": 5, "2026-03": 3 }
    declineHistory: [{ 
      jobId: mongoose.Schema.Types.ObjectId,
      jobTitle: String,
      declinedAt: Date,
      reason: String, // optional reason for decline
      contractorPhone: String, // for analytics
    }],
    monthlyJobDays: { type: Map, of: Number, default: {} }, // Days worked per month { "2026-02": 12, "2026-03": 15 }
  },

  // ✅ Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

workerSchema.index({ location: "2dsphere" });

/**
 * Record a work entry and update milestone eligibility.
 * - date: ISO string or Date
 * - hours: number of hours worked that day
 * - wasCancelled: whether the offer was cancelled for that day
 *
 * This method updates: workHistory (sliding window), hoursPerDay, totalHours,
 * consecutiveDays, cancellationDates/totalCancellations, and eligibleFor5Days/10Days.
 */
workerSchema.methods.recordWork = function (date, hours = 0, wasCancelled = false) {
  try {
    const d = date instanceof Date ? date : new Date(date);
    const dayKey = d.toISOString().slice(0, 10); // YYYY-MM-DD

    // Update hoursPerDay map and totalHours
    if (!this.gigsData) this.gigsData = {};
    if (!this.gigsData.hoursPerDay) this.gigsData.hoursPerDay = new Map();

    const prevHours = this.gigsData.hoursPerDay.get(dayKey) || 0;
    this.gigsData.hoursPerDay.set(dayKey, Math.max(prevHours, hours));

    // Update totalHours by recomputing from map for safety
    let total = 0;
    for (const val of this.gigsData.hoursPerDay.values()) total += val;
    this.gigsData.totalHours = total;

    // Push to workHistory and keep last 30 entries
    if (!Array.isArray(this.gigsData.workHistory)) this.gigsData.workHistory = [];
    // If an entry for the same date exists, replace it
    const existingIndex = this.gigsData.workHistory.findIndex(e => e.date && new Date(e.date).toISOString().slice(0,10) === dayKey);
    const entry = { date: d, hours, cancelled: !!wasCancelled };
    if (existingIndex >= 0) {
      this.gigsData.workHistory[existingIndex] = entry;
    } else {
      this.gigsData.workHistory.push(entry);
    }
    // Keep newest last - sort by date and trim
    this.gigsData.workHistory.sort((a,b) => new Date(a.date) - new Date(b.date));
    if (this.gigsData.workHistory.length > 60) this.gigsData.workHistory = this.gigsData.workHistory.slice(-60);

    // Update cancellation tracking
    const cancellations = this.gigsData.workHistory.filter(w => w.cancelled).map(w => new Date(w.date));
    this.gigsData.totalCancellations = cancellations.length;
    this.gigsData.cancellationDates = cancellations;

    // Compute consecutiveDays where each day has hours >= 7
    let cons = 0;
    const today = new Date(dayKey);
    for (let i = 0; i < 30; i++) {
      const check = new Date(today);
      check.setDate(today.getDate() - i);
      const key = check.toISOString().slice(0,10);
      const h = this.gigsData.hoursPerDay.get(key) || 0;
      if (h >= 7) cons++; else break;
    }
    this.gigsData.consecutiveDays = cons;

    // Eligibility rules:
    // - Window: last 10 days
    // - At most 1 cancellation allowed in that 10-day window
    // - Each counted day must have >=7 hours
    const windowDays = 10;
    const windowStart = new Date(d);
    windowStart.setDate(d.getDate() - (windowDays - 1));
    let daysMet = 0;
    let cancellationsInWindow = 0;
    for (const w of this.gigsData.workHistory) {
      const wd = new Date(w.date);
      if (wd >= windowStart && wd <= d) {
        if (w.cancelled) cancellationsInWindow++;
        if ((w.hours || 0) >= 7 && !w.cancelled) daysMet++;
      }
    }

    // Mark eligibility
    this.gigsData.eligibleFor5Days = daysMet >= 5 && cancellationsInWindow <= 1;
    this.gigsData.eligibleFor10Days = daysMet >= 10 && cancellationsInWindow <= 1;
    this.gigsData.eligibleFor20Days = daysMet >= 20 && cancellationsInWindow <= 1;

    // Unlock milestones if newly eligible
    if (this.gigsData.eligibleFor5Days && !this.gigsData.milestonesUnlocked?.fiveDaysMilestone) {
      this.gigsData.milestonesUnlocked = this.gigsData.milestonesUnlocked || {};
      this.gigsData.milestonesUnlocked.fiveDaysMilestone = { value: true, unlockedDate: new Date() };
    }
    if (this.gigsData.eligibleFor10Days && !this.gigsData.milestonesUnlocked?.tenDaysMilestone) {
      this.gigsData.milestonesUnlocked = this.gigsData.milestonesUnlocked || {};
      this.gigsData.milestonesUnlocked.tenDaysMilestone = { value: true, unlockedDate: new Date() };
    }

    this.gigsData.lastUpdated = new Date();
  } catch (e) {
    // don't throw inside method - caller handles persistence
    console.error('recordWork error', e);
  }
};

module.exports = mongoose.model("Worker", workerSchema);
