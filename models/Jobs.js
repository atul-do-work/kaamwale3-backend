const mongoose = require('mongoose');

const jobSchema = new mongoose.Schema({
  // Note: MongoDB auto-generates _id (ObjectId). No need for custom id field.
  title: { type: String, required: true },
  description: String,
  workerType: String,
  amount: Number,
  contractorName: String,
  contractorPhone: String, // ✅ Store contractor phone for filtering
  lat: Number,
  lon: Number,
  date: { type: Date, default: Date.now },
  status: { type: String, default: 'pending' },
  acceptedBy: String,
  acceptedWorker: { // ✅ Snapshot of worker data when accepted
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
  declinedBy: [String],
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
