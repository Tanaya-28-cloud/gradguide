import mongoose from "mongoose";
export async function connectMongo() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured.");
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  console.log("MongoDB connected for counsellor authentication.");
  return mongoose.connection;
}
