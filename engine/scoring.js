import { GOALS, goalMatch } from "./goals.js";
import { clamp, r1, fmtL } from "./util.js";

// Weights from the product spec. Each sub-score is 0-100; total = sum(weight * score) / 100.
export const WEIGHTS = { career: 25, academic: 20, budget: 20, course_fit: 15, country: 10, intake: 10 };
export const LABELS = { career: "Career alignment", academic: "Academic & English margin", budget: "Budget fit", course_fit: "Course fit", country: "Country preference", intake: "Intake" };

export function careerScore(course, profile) {
  if (!profile.goals.length) return { score: 50, note: "No career goal given — neutral score" };
  const ms = profile.goals.map((g) => ({ g, ...goalMatch(g, course) }));
  const best = Math.max(...ms.map((m) => m.match));
  const mean = ms.reduce((a, m) => a + m.match, 0) / ms.length;
  let score = 100 * (0.7 * best + 0.3 * mean);
  if (profile.research && /research|thesis|dissertation/i.test(`${course.description || ""} ${course.name}`)) score = Math.min(100, score + 10);
  const top = ms.filter((m) => m.match === best)[0];
  const label = GOALS[top.g].label;
  const note = best === 0
    ? `Little overlap with the stated goal (${profile.goals.map((g) => GOALS[g].label).join(", ")})`
    : `${best >= 1 ? "Direct" : "Partial"} match for ${label} (${[...new Set(top.evidence)].join(", ")})`;
  return { score: r1(score), note };
}

export function academicScore(course, profile, en) {
  const req = course.req;
  let grade = 50, gradeNote = "grade not provided";
  if (profile.percentage != null && req?.min_percentage_equiv != null) {
    const margin = profile.percentage - req.min_percentage_equiv;
    grade = clamp(60 + margin * 2.5);
    gradeNote = `${profile.percentage}% vs ${req.min_percentage_equiv}% minimum (${margin >= 0 ? "+" : ""}${r1(margin)})`;
  }
  let eng = 60, engNote = en.note;
  if (en.margin != null) eng = clamp(en.margin >= 1 ? 100 : en.margin >= 0.5 ? 85 : 70);
  const score = 0.7 * grade + 0.3 * eng;
  return { score: r1(score), note: `${gradeNote}; ${engNote}` };
}

/** Budget fit. `basis` is the INR amount compared against the budget. */
export function budgetScore(cost, profile, scholarshipNote) {
  if (profile.budget_inr == null) return { score: 50, note: "Budget not provided — neutral score", ratio: null };
  const tuitionOnly = profile.budget_scope === "tuition_only";
  const basis = tuitionOnly ? cost.tuition_inr : cost.total_inr_net ?? cost.total_inr;
  if (basis == null) return { score: 35, note: "No cost data — cannot confirm the budget", ratio: null };
  const ratio = basis / profile.budget_inr;
  let score;
  if (ratio <= 0.8) score = 100;
  else if (ratio <= 1) score = 100 - ((ratio - 0.8) / 0.2) * 15;
  else if (ratio <= 1.5) score = 85 - ((ratio - 1) / 0.5) * 85;
  else score = 0;
  const tuitionUnknown = tuitionOnly ? cost.tuition_inr == null : !cost.tuition_known;
  // Unknown tuition must never beat a verified fit: cap the score and treat the known part as a lower bound.
  if (tuitionUnknown) score = Math.min(score, 35);
  const scope = tuitionOnly ? "tuition" : tuitionUnknown ? "housing + living only (tuition unknown)" : cost.imputed.length ? `tuition + housing + living (${cost.imputed.join(" & ")} imputed)` : "tuition + housing + living";
  const note = `${tuitionUnknown ? "At least " : ""}${fmtL(basis)} ${scope} vs ${fmtL(profile.budget_inr)} budget${ratio > 1 ? ` (${Math.round((ratio - 1) * 100)}% over)` : ""}${scholarshipNote || ""}`;
  return { score: r1(score), note, ratio, lowerBound: tuitionUnknown };
}

export function courseFitScore(course, profile, bg) {
  const req = course.req;
  const gre = req?.gre_policy;
  let test = 85, testNote = "";
  if (gre === "required") { test = profile.gre != null ? 100 : 40; testNote = profile.gre != null ? "GRE required — provided" : "GRE required — student has none"; }
  else if (gre === "recommended") { test = profile.gre != null ? 100 : 80; testNote = profile.gre != null ? "" : "GRE recommended — not provided"; }
  else if (gre === "not_required") { test = 100; testNote = "No GRE needed"; }
  else testNote = "GRE policy unknown";
  const level = course.degree_level === "master" ? 100 : 70;
  const score = 0.5 * bg.fit + 0.35 * test + 0.15 * level;
  return { score: r1(score), note: `${bg.note}; ${testNote}` };
}

export function countryScore(course, profile) {
  const slug = course.country.country_slug;
  const name = course.country.name;
  const { mandatory_countries: m, preferred_countries: p, acceptable_countries: a } = profile;
  if (m.length) return { score: 100, note: `${name} is the mandatory destination` };
  if (p.length) {
    if (p.includes(slug)) return { score: 100, note: `${name} is a preferred country` };
    if (a.includes(slug)) return { score: 75, note: `${name} is acceptable to the student (not the first choice)` };
    return { score: 40, note: `${name} is outside the preferred countries — soft penalty only` };
  }
  if (a.length) return a.includes(slug) ? { score: 100, note: `${name} is among the student's open countries` } : { score: 40, note: `${name} was not among the countries the student named` };
  return { score: 70, note: "No country preference — neutral for every course" };
}

export function intakeScore(info, profile) {
  const c = info.chosen;
  if (!c) return { score: 0, note: "No open intake" };
  const when = `${c.start_year}-${String(c.start_month).padStart(2, "0")}`;
  const dl = c.status === "open" ? `deadline ${c.deadline}` : c.status === "rolling" ? "rolling admissions" : "deadline not published";
  if (!profile.intake_year) return { score: 75, note: `Next open intake ${when} (${dl})` };
  const monthOk = !profile.intake_month || c.start_month === profile.intake_month;
  return { score: monthOk ? 100 : 60, note: `${monthOk ? "Matches" : "Same year, different month from"} requested intake — ${when} (${dl})` };
}

export function totalScore(parts) {
  return r1(Object.entries(WEIGHTS).reduce((a, [k, w]) => a + (w * parts[k].score) / 100, 0));
}
