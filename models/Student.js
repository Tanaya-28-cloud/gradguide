import mongoose from "mongoose";

const studentSchema = new mongoose.Schema({
  firstName: { type: String, required: true, trim: true, maxlength: 80 },
  lastName: { type: String, required: true, trim: true, maxlength: 80 },
  college: { type: String, required: true, trim: true, maxlength: 180 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  phone: { type: String, required: true, trim: true, maxlength: 25 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Counsellor", required: true, index: true },
}, { timestamps: true, versionKey: false });

export default mongoose.model("Student", studentSchema);
