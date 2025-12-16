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
  }
});

workerSchema.index({ location: "2dsphere" });

module.exports = mongoose.model("Worker", workerSchema);
