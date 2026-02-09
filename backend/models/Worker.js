const mongoose = require("mongoose");

const workerSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  skills: { type: [String], default: [] },
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

  // ✅ Timestamps
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

workerSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("Worker", workerSchema);
