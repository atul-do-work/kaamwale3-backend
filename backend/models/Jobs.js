const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  // Note: MongoDB auto-generates _id (ObjectId). No need for custom id field.
  title: { type: String, required: true },
  description: String,
  workerType: String,
  amount: Number,
  contractorName: String,
  contractorPhone: String, // ✅ Store contractor phone for filtering
  imageUrl: String, // ✅ URL of job image uploaded by contractor
  lat: Number,
  lon: Number,
  date: { type: Date, default: Date.now },
  startTime: String, // ✅ Start time like "09:00" or "9 AM"
  endTime: String, // ✅ End time like "18:00" or "6 PM"
  numberOfDays: { type: Number, default: 1 }, // ✅ Job duration in days (1-30) - only for premium contractors
  status: { type: String, default: 'pending' },
  acceptedBy: String, // ✅ Legacy: first accepted worker phone
  acceptedWorker: { // ✅ Snapshot of worker data when accepted - legacy, use acceptedWorkers for bulk
    id: String,
    name: String,
    phone: String,
    skills: [String],
    profilePhoto: String,
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: [Number], // [longitude, latitude]
    }
  },
  // ✅ NEW: Bulk hiring fields
  bulkHiring: { type: Boolean, default: false }, // Whether this is a bulk hiring job
  requiredWorkers: { type: Number, default: 1 }, // How many workers needed
  acceptedWorkers: [{ // Array of accepted workers with snapshot data
    phone: String,
    name: String,
    profilePhoto: String,
    acceptedAt: Date,
    skills: [String],
    location: {
      type: { type: String, enum: ["Point"], default: "Point" },
      coordinates: [Number],
    }
  }],
  declinedBy: [String],
  isCancelled: { type: Boolean, default: false }, // ✅ Flag to exclude cancelled jobs from counts
  attendanceStatus: String,
  attendanceTime: Date,
  paymentStatus: String,
  paymentMode: String,
  paymentTime: Date,
  // Time tracking fields
  acceptedAt: Date, // when worker accepts the job
  timeSpentMinutes: Number, // duration from acceptance to payment in minutes
  // Rating fields - contractor rates worker after payment
  rating: {
    stars: { type: Number, min: 1, max: 5 }, // 1-5 star rating
    feedback: String, // optional feedback text
    ratedAt: Date, // when rating was given
    ratedBy: String, // contractor name/phone who rated
  },
}, { timestamps: true });

module.exports = mongoose.model('Job', jobSchema);
