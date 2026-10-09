import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import Counsellor from "../models/Counsellor.js";

const router = Router();
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 12,
  standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many authentication attempts. Please try again later." }
});
const safeUser = (u) => ({ id: String(u._id), fullName: u.fullName, username: u.username, email: u.email });

router.get("/me", (req, res) => {
  if (!req.session?.counsellor) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, counsellor: req.session.counsellor });
});

router.post("/signup", authLimiter, async (req, res, next) => {
  try {
    const fullName = String(req.body?.fullName || "").trim();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password;
    if (!fullName || fullName.length > 100) return res.status(400).json({ error: "Enter your full name (up to 100 characters)." });
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return res.status(400).json({ error: "Username must be 3–30 characters using letters, numbers, dots, underscores or hyphens." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: "Enter a valid email address." });
    if (typeof password !== "string" || password.length < 8 || password.length > 72) return res.status(400).json({ error: "Password must be 8–72 characters long." });

    const duplicate = await Counsellor.findOne({ $or: [{ username }, { email }] }).lean();
    if (duplicate) return res.status(409).json({ error: "An account with that username or email already exists." });
    const passwordHash = await bcrypt.hash(password, 12);
    const user = await Counsellor.create({ fullName, username, email, passwordHash });

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.counsellor = safeUser(user);
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.status(201).json({ ok: true, counsellor: req.session.counsellor });
      });
    });
  } catch (err) {
    if (err?.code === 11000) return res.status(409).json({ error: "An account with that username or email already exists." });
    next(err);
  }
});

router.post("/login", authLimiter, async (req, res, next) => {
  try {
    const identifier = String(req.body?.identifier || "").trim().toLowerCase();
    const password = req.body?.password;
    if (!identifier || typeof password !== "string" || password.length > 72) return res.status(400).json({ error: "Enter your username/email and password." });
    const user = await Counsellor.findOne({ $or: [{ username: identifier }, { email: identifier }] }).select("+passwordHash");
    const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
    if (!user || !valid) return res.status(401).json({ error: "Invalid username/email or password." });

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.counsellor = safeUser(user);
      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);
        res.json({ ok: true, counsellor: req.session.counsellor });
      });
    });
  } catch (err) { next(err); }
});

router.post("/logout", (req, res, next) => {
  if (!req.session) return res.json({ ok: true });
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("gradguide.sid", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
    res.json({ ok: true });
  });
});
export default router;
