import { daysBetween } from "./util.js";

// ---------- background matching ----------
const BG_RULES = [
  ["computer-science", /computer sci|\bcse\b|\bcs\b|\bcomputing\b/i],
  ["information-technology", /information technology|\bit\b|infotech/i],
  ["computer-engineering", /computer eng|\bcomp\.? eng/i],
  ["electronics", /electronic|\bece\b|\bentc\b|e&tc|telecom/i],
  ["ai-data", /artificial intelligence|\bai\b|data science|machine learning|\baiml\b|\bai&ds\b/i],
  ["software", /software/i],
  ["mathematics", /mathematic|statistic/i],
  ["engineering", /engineering|\bb\.?e\.?\b|\bb\.?tech\b/i],
];
const COMPUTING = new Set(["computer-science", "information-technology", "computer-engineering", "software", "ai-data"]);

export function backgroundTags(text, degree) {
  const t = `${text || ""} ${degree || ""}`;
  const tags = new Set(BG_RULES.filter(([, re]) => re.test(t)).map(([id]) => id));
  if (degree && /^b\.?e\.?$|^b\.?tech$/i.test(degree.trim())) tags.add("engineering");
  return tags;
}

/** -> { ok, fit (0-100), note } ; ok=null means unknown (student background not given). */
export function checkBackground(course, profile) {
  const accepted = course.req?.accepted_backgrounds;
  if (!accepted) return { ok: true, fit: 70, note: "No background restriction listed" };
  if (!profile.degree && !profile.field_of_study) return { ok: null, fit: 60, note: "Student background not provided" };
  const st = backgroundTags(profile.field_of_study, profile.degree);
  const entries = accepted.split(";").map((s) => s.trim()).filter(Boolean);
  const accTags = new Set(entries.flatMap((e) => [...backgroundTags(e, null)]));
  if (entries.some((e) => /\b(any|all disciplines|related|relevant)\b/i.test(e))) return { ok: true, fit: 75, note: "Accepts related/any discipline" };
  const exact = [...st].filter((t) => accTags.has(t) && t !== "engineering");
  if (exact.length) return { ok: true, fit: 100, note: `Background matches accepted list (${entries.join(", ")})` };
  if ([...st].some((t) => COMPUTING.has(t)) && [...accTags].some((t) => COMPUTING.has(t))) return { ok: true, fit: 85, note: "Close computing-family background" };
  if (st.has("engineering") && accTags.has("engineering")) return { ok: true, fit: 70, note: "General engineering degree accepted" };
  return { ok: false, fit: 0, note: `Background "${profile.field_of_study || profile.degree}" not in accepted list (${entries.join(", ")})` };
}

// ---------- English ----------
const toIelts = (test, s) => {
  if (test === "IELTS") return s;
  if (test === "TOEFL") return s >= 110 ? 8 : s >= 102 ? 7.5 : s >= 94 ? 7 : s >= 79 ? 6.5 : s >= 60 ? 6 : 5.5;
  if (test === "PTE") return s >= 83 ? 8 : s >= 79 ? 7.5 : s >= 73 ? 7 : s >= 65 ? 6.5 : s >= 58 ? 6 : 5.5;
  return null;
};

/** -> { ok, margin (IELTS-equivalent), approx, note } */
export function checkEnglish(req, profile) {
  if (!profile.english) return { ok: null, margin: null, note: "English score not provided" };
  const { test, score } = profile.english;
  const direct = { IELTS: req?.ielts_min, TOEFL: req?.toefl_min, PTE: req?.pte_min }[test];
  if (direct != null) {
    const margin = test === "IELTS" ? score - direct : toIelts(test, score) - toIelts(test, direct);
    return { ok: score >= direct, margin, approx: false, note: `${test} ${score} vs ${direct} required` };
  }
  const reqIelts = req?.ielts_min ?? (req?.toefl_min != null ? toIelts("TOEFL", req.toefl_min) : req?.pte_min != null ? toIelts("PTE", req.pte_min) : null);
  if (reqIelts == null) return { ok: null, margin: null, note: "Course English requirement not on file" };
  const eq = toIelts(test, score);
  return { ok: eq >= reqIelts, margin: eq - reqIelts, approx: true, note: `${test} ${score} ≈ IELTS ${eq} vs ${reqIelts} required (approximate conversion)` };
}

// ---------- intake ----------
export function intakeInfo(course, profile, today) {
  const options = course.intakes.map((i) => {
    let status = "open", days_left = null;
    if (i.is_rolling) status = "rolling";
    else if (!i.application_deadline) status = "not_published";
    else { days_left = daysBetween(today, i.application_deadline); status = days_left < 0 ? "closed" : "open"; }
    return { start_month: i.start_month, start_year: i.start_year, deadline: i.application_deadline, is_rolling: !!i.is_rolling, status, days_left };
  });
  const yearOk = (o) => !profile.intake_year || o.start_year === profile.intake_year;
  const inYear = options.filter(yearOk);
  const usable = inYear.filter((o) => o.status !== "closed");
  const rank = (o) => (profile.intake_month && o.start_month === profile.intake_month ? 0 : 1);
  const when = (o) => (o.days_left ?? 9999);
  const chosen = [...usable].sort((a, b) => rank(a) - rank(b) || when(a) - when(b))[0] || null;
  return { options, inYear, usable, chosen };
}

// ---------- hard constraints ----------
/** Returns { reasons: [..excluding reasons..], budgetOnly } — empty reasons = eligible. */
export function hardConstraints(course, profile, today, info) {
  const reasons = [];
  const req = course.req;

  if (profile.mandatory_countries.length && !profile.mandatory_countries.includes(course.country.country_slug)) {
    reasons.push(`Outside mandatory country (${profile.mandatory_countries.join(", ")})`);
  }
  if (req?.min_percentage_equiv != null && profile.percentage != null && profile.percentage < req.min_percentage_equiv) {
    reasons.push(`Below minimum grade: ${profile.percentage}% vs ${req.min_percentage_equiv}% required`);
  }
  const bg = checkBackground(course, profile);
  if (bg.ok === false) reasons.push(bg.note);
  const en = checkEnglish(req, profile);
  if (en.ok === false) reasons.push(`English below minimum: ${en.note}`);
  if (req?.min_work_exp_months != null && profile.work_exp_months != null && profile.work_exp_months < req.min_work_exp_months) {
    reasons.push(`Needs ${req.min_work_exp_months} months work experience, student has ${profile.work_exp_months}`);
  }
  if (profile.intake_year && !info.inYear.length) reasons.push(`No ${profile.intake_year} intake listed`);
  else if (info.inYear.length && !info.usable.length) {
    const last = info.inYear.map((o) => o.deadline).filter(Boolean).sort().pop();
    reasons.push(`Application deadline passed${last ? ` (${last})` : ""}`);
  }
  return { reasons, bg, en };
}
