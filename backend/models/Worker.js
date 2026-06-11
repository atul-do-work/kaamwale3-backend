const mongoose = require("mongoose");

const workerSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  skills: { type: [String], default: [] },
  mainSkill: { type: String, default: null }, // ✅ Primary skill for quick display
  rating: { type: Number, default: 5 },
  isAvailable: { type: Boolean, default: false },
  socketId: { type: String, default: "" },
  isBlocked: { type: Boolean, default: false },
  blockedReason: { type: String, default: "" },
  riskFlags: { type: [String], default: [] },
  forceOfflineAt: { type: Date, default: null },
  forceOfflineReason: { type: String, default: "" },

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
      fiveDaysMilestone: {
        unlocked: { type: Boolean, default: false },
        unlockedDate: { type: Date, default: null },
      },
      tenDaysMilestone: {
        unlocked: { type: Boolean, default: false },
        unlockedDate: { type: Date, default: null },
      },
      twentyDaysMilestone: {
        unlocked: { type: Boolean, default: false },
        unlockedDate: { type: Date, default: null },
      },
    },

    // Active accepted count (in-flight accepted jobs)
    activeAcceptedCount: { type: Number, default: 0 },

    // Incentive eligibility (real-time tracking)
    eligibleFor5Days: { type: Boolean, default: false },
    eligibleFor10Days: { type: Boolean, default: false },
    eligibleFor20Days: { type: Boolean, default: false },

    // Last update timestamp
    lastUpdated: { type: Date, default: Date.now },
    // Work history - sliding window to evaluate consecutive-day milestones
    workHistory: [{
      date: Date,
      hours: Number,
      jobsCompleted: { type: Number, default: 0 },
      declinesCount: { type: Number, default: 0 },
      hasCompletedJob: { type: Boolean, default: false },
      meetsMinimumHours: { type: Boolean, default: false },
      meetsNoDeclines: { type: Boolean, default: true },
      qualified: { type: Boolean, default: false },
      cancelled: { type: Boolean, default: false },
      snapshotAt: { type: Date, default: Date.now },
    }],
  },

  // ✅ Recent gigs summary (last 10 gigs)
  recentGigs: [{
    jobId: mongoose.Schema.Types.ObjectId,
    title: String,
    amount: Number,
    date: Date,
    status: { type: String, enum: ['accepted', 'completed', 'cancelled', 'pending'], default: 'pending' },
    paymentStatus: { type: String, enum: ['paid', 'pending', 'failed'], default: 'pending' },
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

  // Cash-payment compliance rules for online availability.
  compliance: {
    requiresPocketMinimumForOnline: { type: Boolean, default: false },
    pocketMinimumAmount: { type: Number, default: 100 },
    firstCashPaidJobId: { type: mongoose.Schema.Types.ObjectId, default: null },
    ruleActivatedAt: { type: Date, default: null },
  },

  // ✅ Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

workerSchema.index({ location: "2dsphere" });

// ✅ Helper function to fix milestone structure
const fixMilestoneStructure = (doc) => {
  if (!doc) return;
  
  try {
    // Ensure gigsData exists
    if (!doc.gigsData) {
      doc.gigsData = {};
    }

    // Ensure milestonesUnlocked exists
    if (!doc.gigsData.milestonesUnlocked) {
      doc.gigsData.milestonesUnlocked = {};
    }

    // Fix fiveDaysMilestone if it's not an object
    if (typeof doc.gigsData.milestonesUnlocked.fiveDaysMilestone !== 'object' || 
        doc.gigsData.milestonesUnlocked.fiveDaysMilestone === null) {
      doc.gigsData.milestonesUnlocked.fiveDaysMilestone = {
        unlocked: false,
        unlockedDate: null,
      };
    }

    // Fix tenDaysMilestone if it's not an object
    if (typeof doc.gigsData.milestonesUnlocked.tenDaysMilestone !== 'object' || 
        doc.gigsData.milestonesUnlocked.tenDaysMilestone === null) {
      doc.gigsData.milestonesUnlocked.tenDaysMilestone = {
        unlocked: false,
        unlockedDate: null,
      };
    }

    // Fix twentyDaysMilestone if it's not an object
    if (typeof doc.gigsData.milestonesUnlocked.twentyDaysMilestone !== 'object' || 
        doc.gigsData.milestonesUnlocked.twentyDaysMilestone === null) {
      doc.gigsData.milestonesUnlocked.twentyDaysMilestone = {
        unlocked: false,
        unlockedDate: null,
      };
    }
  } catch (err) {
    console.error('Error fixing milestone structure:', err);
  }
};

// ✅ PRE-SAVE HOOK: Ensure milestone structure is correct (fix for old documents)
workerSchema.pre('save', function(next) {
  fixMilestoneStructure(this);
  next();
});

// ✅ POST-FIND HOOKS: Fix documents loaded from database
workerSchema.post('find', function(docs) {
  if (Array.isArray(docs)) {
    docs.forEach(doc => fixMilestoneStructure(doc));
  }
});

workerSchema.post('findOne', function(doc) {
  fixMilestoneStructure(doc);
});

workerSchema.post('findOneAndUpdate', function(doc) {
  fixMilestoneStructure(doc);
});

module.exports = mongoose.model("Worker", workerSchema);
