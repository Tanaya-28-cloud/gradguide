import mongoose from "mongoose";

const counsellingSessionSchema = new mongoose.Schema({
  studentId: { type: mongoose.Schema.Types.ObjectId, ref: "Student", required: true, index: true },
  counsellorId: { type: mongoose.Schema.Types.ObjectId, ref: "Counsellor", required: true, index: true },
  status: { type: String, enum: ["active", "completed", "cancelled"], default: "active", index: true },
  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

export default mongoose.model("CounsellingSession", counsellingSessionSchema);
