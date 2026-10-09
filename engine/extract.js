import { GOALS } from "./goals.js";
import { buildCountryMatchers, mentionsCountry } from "./countries.js";
import { normalizeProfile } from "./profile.js";
import { generateJson, geminiConfig } from "./llm/gemini.js";
import { understandMessage } from "./understand.js";
import { applyExtraction, countStated } from "./apply.js";
import { todayIso } from "./util.js";

const STATES = ["Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand", "West Bengal", "Delhi", "Jammu and Kashmir"];
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12, fall: 9, autumn: 9, spring: 1, winter: 1 };

const toInr = (n, unit) => {
  n = Number(n);
  if (!unit) return n >= 100000 ? n : null;
  unit = unit.toLowerCase();
  if (/^cr/.test(unit)) return n * 1e7;
  return n * 1e5; // lakh / lac / L
};

/** Rule-based extractor — works offline and is the safety net when the LLM is unavailable. */
export function fallbackExtract(text, countries) {
  const raw = { goals: [], preferred_countries: [], mandatory_countries: [], acceptable_countries: [], docs_ready: {} };

  // degree + background
  const dm = text.match(/\b(B\.?E\.?|B\.?Tech|BTech|B\.?Sc|BSc|BCA|BCS)\b(?:\s+in)?\s+([A-Za-z&][A-Za-z& ]*?)(?=\s+(?:student|graduate|degree|with|at|and)\b|[,.]|\s*$)/);
  if (dm) { raw.degree = dm[1].replace(/\./g, ""); raw.field_of_study = dm[2].trim(); }
  else { const d2 = text.match(/\b(B\.?E\.?|B\.?Tech|BTech)\b/); if (d2) raw.degree = d2[1].replace(/\./g, ""); }

  // grades
  const cg = text.match(/(\d(?:\.\d+)?)\s*(?:CGPA|GPA)/i) || text.match(/(?:CGPA|GPA)\s*(?:of|is|:)?\s*(\d(?:\.\d+)?)/i);
  if (cg) raw.cgpa = Number(cg[1]);
  const pc = text.match(/(\d{2}(?:\.\d+)?)\s*(?:%|percent)/i);
  if (pc) raw.percentage = Number(pc[1]);

  // English
  const ie = text.match(/IELTS\s*(?:score\s*)?(?:of|is|:)?\s*(\d(?:\.\d)?)/i);
  const to = text.match(/TOEFL\s*(?:score\s*)?(?:of|is|:)?\s*(\d{2,3})/i);
  const pt = text.match(/PTE\s*(?:score\s*)?(?:of|is|:)?\s*(\d{2})/i);
  if (ie) raw.english = { test: "IELTS", score: Number(ie[1]) };
  else if (to) raw.english = { test: "TOEFL", score: Number(to[1]) };
  else if (pt) raw.english = { test: "PTE", score: Number(pt[1]) };
  const gre = text.match(/GRE\s*(?:score\s*)?(?:of|is|:)?\s*(3\d{2})/i);
  if (gre) raw.gre = Number(gre[1]);
  const gm = text.match(/GMAT\s*(?:score\s*)?(?:of|is|:)?\s*(\d{3})/i);
  if (gm) raw.gmat = Number(gm[1]);

  // work experience
  const we = text.match(/(\d+(?:\.\d+)?)\s*(years?|yrs?|months?)\s*(?:of\s*)?(?:work\s*|industry\s*)?experience/i);
  if (we) raw.work_exp_months = Math.round(Number(we[1]) * (/^m/i.test(we[2]) ? 1 : 12));

  // family income (removed before budget parsing so it is not mistaken for the budget)
  let rest = text;
  const inc = text.match(/(?:family|household|annual)\s+income[^.\d₹]*(?:₹|Rs\.?|INR)?\s*(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|L\b|crores?)?/i);
  if (inc) { raw.family_income_inr = toInr(inc[1], inc[2] || "lakh"); rest = text.replace(inc[0], " "); }

  // budget
  const bm = rest.match(/(?:₹|Rs\.?|INR)\s*(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|L\b|crores?|cr\b)?/i) || rest.match(/(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?)\b/i);
  if (bm) { const v = toInr(bm[1], bm[2]); if (v) raw.budget_inr = v; }
  raw.budget_scope = /\btuition\b/i.test(text) && !/living|accommodation|housing|overall|total|full degree/i.test(text) ? "tuition_only" : "total";

  // goals, in order of appearance
  const found = Object.entries(GOALS).map(([id, g]) => ({ id, at: text.search(g.detect) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  raw.goals = found.map((x) => x.id);
  raw.research = /research/i.test(text);
  raw.wants_scholarships = /scholarship|funding|financial aid|fee waiver/i.test(text);

  // countries — classified clause by clause: mandatory / preferred / merely acceptable
  const matchers = buildCountryMatchers(countries);
  const clauses = text.split(/(?<=[.!?])\s+/).flatMap((s) => s.split(/,?\s*\bbut\b|;/i));
  for (const cl of clauses) {
    const hit = matchers.filter((m) => mentionsCountry(m, cl));
    if (!hit.length) continue;
    const hasOnly = /\bonly\b/i.test(cl) && !/\b(not|n't|no)\b[^.]*\bonly\b/i.test(cl);
    const mandatory = /\b(mandatory|compulsory|must|non-negotiable)\b/i.test(cl) || hasOnly;
    const preferred = /\b(prefer|preferably|would like|i'd like|if possible|rather|ideally|first choice|dream)\b/i.test(cl);
    const bucket = mandatory ? "mandatory_countries" : preferred ? "preferred_countries" : "acceptable_countries";
    for (const h of hit) raw[bucket].push(h.slug);
  }

  // intake
  const im = text.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|fall|autumn|spring|winter)\b\s*(?:intake\s*)?(20\d\d)/i);
  if (im) { raw.intake_month = MONTHS[im[1].toLowerCase()]; raw.intake_year = Number(im[2]); }
  else { const y = text.match(/\b(20[23]\d)\s*intake|intake\s*(?:in|of)?\s*(20[23]\d)/i); if (y) raw.intake_year = Number(y[1] || y[2]); }

  // optional scholarship attributes
  const cat = text.match(/\b(SC|ST|OBC|EWS)\b/) || text.match(/category\s*(?:is|:)?\s*(General|Open)/i);
  if (cat) raw.category = cat[1].toUpperCase();
  if (/\b(female|woman|girl)\b/i.test(text)) raw.gender = "female";
  else if (/\b(male|man|boy)\b/i.test(text)) raw.gender = "male";
  const st = STATES.find((s) => new RegExp(`\\b${s}\\b`, "i").test(text));
  if (st) raw.state = st;

  return raw;
}

// ---------- extraction pipeline ----------
// 1. Gemini reads the message in context (profile + conversation) and returns validated JSON   -> engine/understand.js
// 2. The validated update is merged into the accumulated profile                                -> engine/apply.js + profile.js
// 3. The merged profile is normalised into the exact shape the deterministic engine expects     -> normalizeProfile
// If Gemini cannot be used, fallbackExtract (above) is used instead and the response says so, with the reason.

const FALLBACK_SUFFIX = "Using the basic rule-based parser for this message; informal or conversational answers may be missed.";
const fallbackNote = (kind, message) => (kind === "no_key"
  ? `Gemini is not configured (add GEMINI_API_KEY to .env). ${FALLBACK_SUFFIX}`
  : `Gemini could not be used: ${message} ${FALLBACK_SUFFIX}`);

/**
 * extractProfile(text, countries, existing?, options?)
 *  - existing: profile from earlier messages (merged, never overwritten by an empty or failed extraction)
 *  - options.history: recent turns [{ role: "assistant" | "counsellor", text }], oldest first, NOT including `text`
 * Returns { profile, extractor: "gemini" | "rules", note, llm_error, has_new_info, ambiguities, unavailable, flexible, stated, corrections, summary }.
 * `unavailable` lists missing items the counsellor said do not exist or are not known yet (never asked about again).
 * `flexible` lists preferences the counsellor explicitly left open ("country preference", "intake"); `stated` lists the profile fields this message stated.
 */
export async function extractProfile(text, countries, existing = null, {
  history = [], today = todayIso(), generate = generateJson, config = geminiConfig(), log = console.warn,
} = {}) {
  const slugs = countries.map((c) => c.country_slug);
  const hasExisting = Boolean(existing) && typeof existing === "object" && !Array.isArray(existing) && Object.keys(existing).length > 0;
  const known = hasExisting ? existing : null;

  let extraction, extractor = "gemini", note = null, llmError = null;
  if (!config.apiKey) {
    extractor = "rules";
    llmError = { kind: "no_key", message: "GEMINI_API_KEY is not set." };
  } else {
    try {
      ({ extraction } = await understandMessage({ text, profile: known, history, countries, today, generate, config }));
    } catch (e) {
      extractor = "rules";
      llmError = { kind: e?.kind || "unexpected", message: e?.message || String(e) };
      log(`[gemini] ${llmError.kind}: ${llmError.message}`);
    }
  }

  if (extractor === "rules") {
    const update = fallbackExtract(text, countries);
    extraction = { updates: update, corrections: [], ambiguities: [], unavailable: [], flexible: [], has_new_info: countStated(update) > 0, summary: "", rejected: [] };
    note = fallbackNote(llmError.kind, llmError.message);
  }

  const merged = applyExtraction(known, extraction);
  return {
    profile: normalizeProfile(merged, slugs),
    extractor,
    note,
    llm_error: llmError,
    has_new_info: extraction.has_new_info,
    ambiguities: extraction.ambiguities,
    unavailable: extraction.unavailable || [],
    flexible: extraction.flexible || [],
    stated: Object.keys(extraction.updates || {}),
    corrections: extraction.corrections,
    summary: extraction.summary,
  };
}