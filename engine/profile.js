import { GOALS } from "./goals.js";
import { uniq } from "./util.js";

export const CGPA_TO_PERCENT = 9.5; // common Indian approximation; shown to the counsellor, editable via the percentage field
const num = (v) => (v === null || v === undefined || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** Cleans a raw (LLM / form / fallback) profile into the exact shape the engine expects. */
export function normalizeProfile(raw = {}, countrySlugs = []) {
  const p = {};
  p.degree = str(raw.degree);
  p.field_of_study = str(raw.field_of_study);

  let cgpa = num(raw.cgpa);
  let pct = num(raw.percentage);
  if (cgpa != null && cgpa > 10) { if (cgpa <= 100 && pct == null) pct = cgpa; cgpa = null; }
  if (cgpa != null && cgpa <= 0) cgpa = null;
  if (pct != null && (pct <= 0 || pct > 100)) pct = null;
  p.cgpa = cgpa;
  p.percentage_source = pct != null ? "stated" : null;
  if (pct == null && cgpa != null) { pct = Math.round(cgpa * CGPA_TO_PERCENT * 10) / 10; p.percentage_source = `CGPA × ${CGPA_TO_PERCENT}`; }
  p.percentage = pct;

  const test = str(raw.english?.test)?.toUpperCase();
  const score = num(raw.english?.score);
  p.english = ["IELTS", "TOEFL", "PTE"].includes(test) && score != null ? { test, score } : null;
  p.gre = num(raw.gre);
  p.gmat = num(raw.gmat);
  p.work_exp_months = num(raw.work_exp_months);

  p.goals = uniq((raw.goals || []).filter((g) => GOALS[g]));
  p.research = !!raw.research;

  const b = num(raw.budget_inr);
  p.budget_inr = b && b > 0 ? b : null;
  p.budget_scope = raw.budget_scope === "tuition_only" ? "tuition_only" : "total";

  const valid = (a) => uniq((a || []).filter((c) => countrySlugs.includes(c)));
  p.mandatory_countries = valid(raw.mandatory_countries);
  p.preferred_countries = valid(raw.preferred_countries).filter((c) => !p.mandatory_countries.includes(c));
  p.acceptable_countries = valid(raw.acceptable_countries).filter((c) => !p.mandatory_countries.includes(c) && !p.preferred_countries.includes(c));

  const iy = num(raw.intake_year);
  p.intake_year = iy && iy >= 2026 && iy <= 2032 ? Math.round(iy) : null;
  const im = num(raw.intake_month);
  p.intake_month = im && im >= 1 && im <= 12 ? Math.round(im) : null;

  p.wants_scholarships = !!raw.wants_scholarships;
  p.nationality = str(raw.nationality) || "India";
  p.category = str(raw.category);
  p.gender = str(raw.gender)?.toLowerCase() || null;
  p.state = str(raw.state);
  p.family_income_inr = num(raw.family_income_inr);

  p.docs_ready = {};
  for (const [k, v] of Object.entries(raw.docs_ready || {})) if (v) p.docs_ready[k] = typeof v === "number" ? v : true;

  p.missing = [];
  if (p.percentage == null) p.missing.push("CGPA / percentage");
  if (!p.english) p.missing.push("English test score");
  if (p.budget_inr == null) p.missing.push("budget");
  if (!p.goals.length) p.missing.push("career goal");
  if (!p.degree && !p.field_of_study) p.missing.push("degree / background");
  return p;
}

// ---------- multi-turn profile state ----------
// The profile is built up over several counsellor messages. Each message is extracted into a partial
// "update" (same raw shape normalizeProfile accepts); mergeProfile folds it into what is already known.
// Nothing here ranks or recommends anything — it only keeps the student's facts.

const COUNTRY_BUCKETS = ["mandatory_countries", "preferred_countries", "acceptable_countries"];
const isBlank = (v) => v === null || v === undefined || (typeof v === "number" && Number.isNaN(v)) || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** A normalized profile carries derived values (e.g. CGPA × 9.5); turn it back into what was actually stated. */
function toStated(p = {}) {
  const out = { ...p };
  delete out.missing;
  if (out.percentage_source && out.percentage_source !== "stated") delete out.percentage;
  delete out.percentage_source;
  return out;
}

/**
 * Merges a new partial update into the existing profile and returns a NEW object (inputs are not modified).
 *  - blank / null / empty values in the update never erase what is already known
 *  - a new non-blank value for a field replaces the old one (the counsellor corrected it)
 *  - goals accumulate; research / wants_scholarships stay true once stated; docs_ready accumulates
 *  - a country named in the update moves to the bucket the update puts it in (mandatory > preferred > acceptable);
 *    countries not mentioned in the update keep their existing bucket
 *  - budget_scope: "tuition_only" is always applied; the default "total" only travels with a new budget figure,
 *    so a message about countries cannot silently reset an earlier "tuition only"
 */
export function mergeProfile(existing = {}, update = {}) {
  const base = toStated(existing);
  const next = toStated(update);
  const out = { ...base };

  for (const [key, value] of Object.entries(next)) {
    if (COUNTRY_BUCKETS.includes(key)) continue; // handled below
    switch (key) {
      case "english":
        if (value && !isBlank(value.test) && !isBlank(value.score)) out.english = { test: value.test, score: value.score };
        break;
      case "goals":
        if (Array.isArray(value)) out.goals = uniq([...(base.goals || []), ...value.filter((g) => !isBlank(g))]);
        break;
      case "docs_ready":
        if (value && typeof value === "object") out.docs_ready = { ...(base.docs_ready || {}), ...Object.fromEntries(Object.entries(value).filter(([, v]) => v)) };
        break;
      case "research":
      case "wants_scholarships":
        if (value === true) out[key] = true;
        break;
      case "budget_scope":
        if (value === "tuition_only" || (value === "total" && !isBlank(next.budget_inr))) out.budget_scope = value;
        break;
      default:
        if (!isBlank(value)) out[key] = value;
    }
  }

  const claimed = new Set();
  const incoming = { mandatory_countries: [], preferred_countries: [], acceptable_countries: [] };
  for (const bucket of COUNTRY_BUCKETS) {
    for (const c of Array.isArray(next[bucket]) ? next[bucket] : []) {
      if (isBlank(c) || claimed.has(c)) continue;
      claimed.add(c);
      incoming[bucket].push(c);
    }
  }
  for (const bucket of COUNTRY_BUCKETS) {
    const kept = (Array.isArray(base[bucket]) ? base[bucket] : []).filter((c) => !claimed.has(c));
    out[bucket] = uniq([...kept, ...incoming[bucket]]);
  }

  return structuredClone(out);
}