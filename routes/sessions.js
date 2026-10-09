import { Router } from "express";
import mongoose from "mongoose";
import Student from "../models/Student.js";
import CounsellingSession from "../models/CounsellingSession.js";

const router = Router();

function counsellorObjectId(req) {
  const id = req.session?.counsellor?.id;
  return id && mongoose.isValidObjectId(id) ? new mongoose.Types.ObjectId(id) : null;
}

// Creates a student record and a separate counselling-session record.
router.post("/", async (req, res) => {
  let student;
  try {
    const counsellorId = counsellorObjectId(req);
    if (!counsellorId) return res.status(401).json({ error: "Please log in again." });

    const firstName = String(req.body?.firstName || "").trim();
    const lastName = String(req.body?.lastName || "").trim();
    const college = String(req.body?.college || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || "").trim();

    if (!firstName || !lastName || !college || !email || !phone) {
      return res.status(400).json({ error: "Please complete all five fields." });
    }
    if (firstName.length > 80 || lastName.length > 80 || college.length > 180 || email.length > 254 || phone.length > 25) {
      return res.status(400).json({ error: "One or more fields exceed the allowed length." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }
    if (!/^[+()\d\s.-]{7,25}$/.test(phone)) {
      return res.status(400).json({ error: "Enter a valid phone number." });
    }

    student = await Student.create({ firstName, lastName, college, email, phone, createdBy: counsellorId });
    const counsellingSession = await CounsellingSession.create({ studentId: student._id, counsellorId });

    return res.status(201).json({
      student: { id: String(student._id), firstName: student.firstName, lastName: student.lastName, college: student.college, email: student.email, phone: student.phone },
      session: { id: String(counsellingSession._id), status: counsellingSession.status, startedAt: counsellingSession.startedAt },
    });
  } catch (error) {
    // Avoid returning database internals or credentials to the browser.
    console.error("Could not create student/session:", error);
    if (student?._id) await Student.deleteOne({ _id: student._id }).catch(() => {});
    return res.status(500).json({ error: "Could not create the student session. Please try again." });
  }
});

// Only the counsellor who owns the session can retrieve it.
router.get("/:id", async (req, res) => {
  try {
    const counsellorId = counsellorObjectId(req);
    if (!counsellorId) return res.status(401).json({ error: "Please log in again." });
    if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: "Session not found." });

    const session = await CounsellingSession.findOne({ _id: req.params.id, counsellorId }).populate("studentId", "firstName lastName college email phone").lean();
    if (!session || !session.studentId) return res.status(404).json({ error: "Session not found." });
    return res.json({
      student: { id: String(session.studentId._id), firstName: session.studentId.firstName, lastName: session.studentId.lastName, college: session.studentId.college, email: session.studentId.email, phone: session.studentId.phone },
      session: { id: String(session._id), status: session.status, startedAt: session.startedAt },
    });
  } catch (error) {
    console.error("Could not load student session:", error);
    return res.status(500).json({ error: "Could not load this session." });
  }
});

export default router;
