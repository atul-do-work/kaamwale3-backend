const mongoose = require('mongoose');

const cityLeaderboardSchema = new mongoose.Schema(
  {
    city: {
      type: String,
      required: true,
      index: true,
    },
    state: {
      type: String,
      required: true,
    },
    totalContractors: {
      type: Number,
      default: 0,
    },
    leaderboard: [
      {
        contractorId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
        phone: String,
        name: String,
        rank: Number,
        score: {
          type: Number,
          default: 0,
        },
        avgRating: {
          type: Number,
          default: 0,
        },
        totalJobsPosted: {
          type: Number,
          default: 0,
        },
        completedJobs: {
          type: Number,
          default: 0,
        },
        daysActive: {
          type: Number,
          default: 0,
        },
        completionRate: {
          type: Number,
          default: 0,
        },
        avgResponseTime: {
          type: Number,
          default: 0,
        },
        tier: {
          type: String,
          enum: ['gold', 'silver', 'bronze', 'rising-star', 'new'],
          default: 'new',
        },
        profilePhoto: String,
      },
    ],
    calculatedAt: {
      type: Date,
      default: Date.now,
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

// TTL Index - automatically delete documents after expiration
cityLeaderboardSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('CityLeaderboard', cityLeaderboardSchema);
