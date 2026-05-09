const mongoose = require("mongoose");

const uploadSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  type: { type: String, enum: ["profilePhoto", "document"], default: "document" },
  fileName: String,
  fileUrl: String,
  cloudinaryPublicId: String,
  status: { type: String, enum: ["uploading", "completed", "failed"], default: "completed" },
  failureReason: String,
  uploadedAt: Date,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Upload", uploadSchema);
