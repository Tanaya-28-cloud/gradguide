import mongoose from "mongoose";
const schema = new mongoose.Schema({
  fullName: { type: String, required: true, trim: true, maxlength: 100 },
  username: { type: String, required: true, trim: true, lowercase: true, minlength: 3, maxlength: 30, match: /^[a-z0-9._-]+$/ },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, match: /^[^\s@]+@[^\s@]+\.[^\s@]+$/ },
  passwordHash: { type: String, required: true, select: false }
}, { timestamps: true, versionKey: false });
schema.index({ username: 1 }, { unique: true });
schema.index({ email: 1 }, { unique: true });
export default mongoose.model("Counsellor", schema);
