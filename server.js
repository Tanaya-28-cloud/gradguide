import "dotenv/config";
import express from "express";
import path from "node:path";
import session from "express-session";
import MongoStore from "connect-mongo";

import { openDb, loadData } from "./db.js";
import { recommend } from "./engine/index.js";
import { extractProfile } from "./engine/extract.js";
import { GOALS } from "./engine/goals.js";
import { geminiConfig } from "./engine/llm/gemini.js";

import { connectMongo } from "./config/mongo.js";
import authRouter from "./routes/auth.js";
import sessionRouter from "./routes/sessions.js";
import { requireAuth } from "./middleware/requireAuth.js";

const db = openDb();
const data = loadData(db);
const app = express();
app.use(express.json({ limit: "200kb" }));

const startServer = async () => {
  await connectMongo();
  if (!process.env.SESSION_SECRET) throw new Error("SESSION_SECRET is missing. Add it to your .env file.");

  app.use(session({
    name: "gradguide.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI, collectionName: "sessions", ttl: 60 * 60 * 8 }),
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 8,
      path: "/",
    },
  }));

  app.use("/api/auth", authRouter);

  app.get("/", (req, res) => {
    if (!req.session?.counsellor?.id) return res.redirect("/login.html");
    return res.sendFile(path.join(import.meta.dirname, "public", "index.html"));
  });
  app.get("/index.html", (req, res) => {
    if (!req.session?.counsellor?.id) return res.redirect("/login.html");
    return res.sendFile(path.join(import.meta.dirname, "public", "index.html"));
  });

  app.use(express.static(path.join(import.meta.dirname, "public")));
  app.use("/api", requireAuth);
  app.use("/api/sessions", sessionRouter);

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: "An unexpected server error occurred." });
  });

  // Existing GradGuide metadata and recommendation logic remains unchanged.
  app.get("/api/meta", (req, res) => {
    res.json({
      countries: data.countries.map((c) => ({ slug: c.country_slug, name: c.name }))
        .filter((c) => data.courses.some((x) => x.country.country_slug === c.slug)),
      goals: Object.entries(GOALS).map(([id, g]) => ({ id, label: g.label })),
      llm: !!process.env.GEMINI_API_KEY,
      llm_model: geminiConfig().model,
      course_count: data.courses.length,
    });
  });

  const cleanHistory = (h) => (Array.isArray(h) ? h : [])
    .filter((t) => t && (t.role === "assistant" || t.role === "counsellor") && typeof t.text === "string")
    .slice(-12)
    .map((t) => ({ role: t.role, text: t.text.slice(0, 600) }));

  app.post("/api/extract", wrap(async (req, res) => {
    const text = String(req.body?.text || "").slice(0, 4000);
    if (!text.trim()) return res.status(400).json({ error: "text is required" });
    res.json(await extractProfile(text, data.countries, req.body?.profile, { history: cleanHistory(req.body?.history) }));
  }));

  app.post("/api/recommend", wrap(async (req, res) => {
    res.json(recommend(data, req.body?.profile || {}, { limit: Math.min(Number(req.body?.limit) || 5, 30) }));
  }));

  app.get("/api/search", (req, res) => {
    const q = String(req.query.q || "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!q.length) return res.json([]);
    const hits = data.courses.map((c) => {
      const hay = [c.name, c.uni.name, c.city.name, c.country.name, c.field, c.degree_level, c.description, ...c.tags].join(" ").toLowerCase();
      const score = q.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
      return { c, score };
    }).filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name)).slice(0, 15);
    res.json(hits.map(({ c }) => ({
      course_slug: c.course_slug, name: c.name, university: c.uni.name, country: c.country.name, city: c.city.name,
      duration_months: c.duration_months, tuition_total_local: c.tuition_total_local, currency: c.country.currency,
      tuition_inr_lakh: c.tuition_total_local != null && c.fx_inr_per_unit ? Math.round((c.tuition_total_local * c.fx_inr_per_unit) / 1000) / 100 : null,
      tags: c.tags, description: c.description, course_url: c.course_url,
      min_percentage_equiv: c.req?.min_percentage_equiv ?? null, ielts_min: c.req?.ielts_min ?? null, gre_policy: c.req?.gre_policy ?? null,
      intakes: c.intakes.map((i) => ({ start: `${i.start_year}-${String(i.start_month).padStart(2, "0")}`, deadline: i.application_deadline, rolling: !!i.is_rolling })),
    })));
  });

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`GradGuide Copilot running at http://localhost:${port} (LLM extraction: ${process.env.GEMINI_API_KEY ? `Gemini ${geminiConfig().model}` : "OFF — rule-based fallback; set GEMINI_API_KEY"})`));
};

startServer().catch((error) => {
  console.error("Failed to start GradGuide:", error);
  process.exit(1);
});
