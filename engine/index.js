import { normalizeProfile } from "./profile.js";
import { hardConstraints, intakeInfo, checkBackground, checkEnglish } from "./constraints.js";
import { computeCost } from "./cost.js";
import { matchScholarships } from "./scholarships.js";
import { computeReadiness } from "./readiness.js";
import { WEIGHTS, LABELS, careerScore, academicScore, budgetScore, courseFitScore, countryScore, intakeScore, totalScore } from "./scoring.js";
import { todayIso, fmtL, r1 } from "./util.js";

const STRETCH_RATIO = 1.5; // above this multiple of budget a course is held back (shown as "stretch" only if nothing else fits)

function eligibilityChecks(course, profile, bg, en) {
  const req = course.req || {};
  const items = [];
  items.push({ item: "Degree / background", status: bg.ok === null ? "unknown" : "pass", detail: bg.note });
  items.push({
    item: "Minimum grade",
    status: profile.percentage == null || req.min_percentage_equiv == null ? "unknown" : "pass",
    detail: req.min_percentage_equiv != null ? `${req.min_percentage_equiv}% required${profile.percentage != null ? `, student ${profile.percentage}%` : ""}` : "Not on file",
  });
  items.push({ item: "English test", status: en.ok === null ? "unknown" : "pass", detail: en.note });
  if (req.gre_policy === "required") items.push({ item: "GRE", status: profile.gre != null ? "pass" : "missing", detail: profile.gre != null ? `GRE ${profile.gre}` : "Required — student has not taken it" });
  if (req.min_work_exp_months != null) items.push({ item: "Work experience", status: profile.work_exp_months == null ? "unknown" : "pass", detail: `${req.min_work_exp_months} months required` });
  return items;
}

function buildResult(course, profile, today, data) {
  const fallbacks = data.fallbacks;
  const info = intakeInfo(course, profile, today);
  const { reasons, bg, en } = hardConstraints(course, profile, today, info);
  const cost = computeCost(course, fallbacks);
  const base = {
    course_slug: course.course_slug, name: course.name, university: course.uni.name, city: course.city.name,
    country: course.country.name, country_slug: course.country.country_slug,
  };
  if (reasons.length) return { excluded: { ...base, reasons }, cost };

  const schol = matchScholarships(course, profile, data);

  // Optional: reflect scholarship value in the budget score only when the counsellor says it matters.
  let schNote = "";
  if (profile.wants_scholarships && cost.total_inr != null) {
    const best = schol.eligible.filter((s) => s.amount_inr != null).sort((a, b) => b.amount_inr - a.amount_inr)[0];
    if (best) {
      const years = course.duration_months / 12;
      const saving = Math.min(best.amount_inr * years, cost.tuition_inr ?? Infinity);
      cost.total_inr_net = cost.total_inr - saving;
      schNote = ` after an estimated ${fmtL(saving)} from "${best.name}" (not guaranteed)`;
    }
  }

  const parts = {
    career: careerScore(course, profile),
    academic: academicScore(course, profile, en),
    budget: budgetScore(cost, profile, schNote),
    course_fit: courseFitScore(course, profile, bg),
    country: countryScore(course, profile),
    intake: intakeScore(info, profile),
  };
  const score = totalScore(parts);
  const breakdown = Object.keys(WEIGHTS).map((k) => ({ key: k, label: LABELS[k], weight: WEIGHTS[k], score: parts[k].score, points: r1((WEIGHTS[k] * parts[k].score) / 100), note: parts[k].note }));

  const budgetRatio = parts.budget.ratio;
  const overStretch = budgetRatio != null && budgetRatio > STRETCH_RATIO;

  const warnings = [...cost.flags];
  if (parts.budget.ratio != null && parts.budget.ratio > 1) warnings.push(`Over budget by ${Math.round((parts.budget.ratio - 1) * 100)}%`);
  if (course.req?.gre_policy === "required" && profile.gre == null) warnings.push("GRE required — student has none");
  if (!profile.percentage) warnings.push("Grade not provided — academic fit assumed neutral");
  if (info.chosen?.status === "not_published") warnings.push("Application deadline not published");
  if (en.approx) warnings.push("English requirement compared via approximate conversion");

  const why = [parts.career.note, parts.academic.note, parts.budget.note];
  if (parts.country.score < 100 || profile.mandatory_countries.length) why.push(parts.country.note);

  const readiness = computeReadiness(course, profile, info, eligibilityChecks(course, profile, bg, en));

  return {
    result: {
      ...base,
      degree_level: course.degree_level, field: course.field, duration_months: course.duration_months,
      tags: course.tags, description: course.description, course_url: course.course_url,
      data_quality: course.data_quality, last_verified: course.last_verified,
      score, breakdown, why, warnings, cost,
      intake: { chosen: info.chosen, options: info.options },
      requirements: {
        min_percentage_equiv: course.req?.min_percentage_equiv ?? null, raw_text: course.req?.requirement_raw_text ?? null,
        ielts_min: course.req?.ielts_min ?? null, toefl_min: course.req?.toefl_min ?? null, pte_min: course.req?.pte_min ?? null,
        gre_policy: course.req?.gre_policy ?? null, gmat_policy: course.req?.gmat_policy ?? null, min_work_exp_months: course.req?.min_work_exp_months ?? null,
      },
      scholarships: { eligible: schol.eligible, possible: schol.possible },
      readiness,
    },
    overStretch,
  };
}

/** Why a non-preferred-country course outranks the best preferred-country one. */
function crossBorderNote(results, profile, stretch = []) {
  const pref = new Set([...profile.preferred_countries]);
  if (!pref.size || profile.mandatory_countries.length) return;
  const top = results[0];
  if (!top || pref.has(top.country_slug)) return;
  const bestPref = results.find((r) => pref.has(r.country_slug));
  if (!bestPref) return; // nothing eligible in the preferred country: explained by the country-fallback note in recommend()
  const diffs = top.breakdown
    .map((b, i) => ({ label: b.label, d: r1(b.points - bestPref.breakdown[i].points) }))
    .filter((x) => x.d > 0.5)
    .sort((a, b) => b.d - a.d)
    .slice(0, 2);
  top.cross_border_note = `${top.country} wasn't a preferred destination, but this scores ${r1(top.score - bestPref.score)} points above the best ${bestPref.country} option (${bestPref.name}, ${bestPref.score})` +
    (diffs.length ? `, mainly on ${diffs.map((x) => `${x.label.toLowerCase()} (+${x.d})`).join(" and ")}.` : ".");
}

export function recommend(data, rawProfile, { today = todayIso(), limit = 10 } = {}) {
  const countrySlugs = data.countries.map((c) => c.country_slug);
  const profile = normalizeProfile(rawProfile, countrySlugs);

  const ranked = [], excluded = [], stretch = [];
  for (const course of data.courses) {
    const out = buildResult(course, profile, today, data);
    if (out.excluded) { excluded.push(out.excluded); continue; }
    if (out.overStretch) {
      stretch.push({ ...out.result, stretch: true });
      excluded.push({ course_slug: out.result.course_slug, name: out.result.name, university: out.result.university, country: out.result.country, reasons: [`Cost is more than ${Math.round((STRETCH_RATIO - 1) * 100)}% over budget`], budget_only: true });
      continue;
    }
    ranked.push(out.result);
  }
  // Courses whose tuition is unknown can't be confirmed against the budget, so they rank after verified-cost courses.
  const unverified = (r) => (r.breakdown[2].score <= 35 && !r.cost.tuition_known ? 1 : 0);
  const order = (a, b) => unverified(a) - unverified(b) || b.score - a.score || (a.cost.total_inr ?? Infinity) - (b.cost.total_inr ?? Infinity) || a.course_slug.localeCompare(b.course_slug);
  ranked.sort(order);
  ranked.forEach((r, i) => (r.rank = i + 1));
  crossBorderNote(ranked, profile, stretch);

  // Preferred countries are a soft preference (mandatory countries are the only hard country filter), so courses elsewhere stay in the
  // pool and are scored by the same engine. These tags only label which results are in a preferred country and which are alternatives.
  const soft = profile.preferred_countries.length > 0 && !profile.mandatory_countries.length;
  const isPref = (r) => profile.preferred_countries.includes(r.country_slug);
  if (soft) for (const r of [...ranked, ...stretch]) r.country_match = isPref(r) ? "preferred" : "alternative";

  let stretchOptions = [];
  let notes = [];
  if (ranked.length < 3 && stretch.length) {
    stretchOptions = stretch.sort((a, b) => (soft ? Number(isPref(b)) - Number(isPref(a)) : 0) || (a.cost.total_inr ?? Infinity) - (b.cost.total_inr ?? Infinity)).slice(0, 5);
    stretchOptions.forEach((r, i) => (r.rank = ranked.length + i + 1));
    notes.push(ranked.length ? `Only ${ranked.length} course(s) fit the budget; the closest over-budget options are listed separately.` : "No course fits the budget. The closest options by total cost are shown as stretch options — consider a higher budget, scholarships, or tuition-only budgeting.");
  }
  const nameOf = (slug) => data.countries.find((c) => c.country_slug === slug)?.name || slug;
  let countryFallback = null;
  if (soft && !ranked.some(isPref)) {
    const names = profile.preferred_countries.map(nameOf).join(", ");
    const prefOverBudget = stretch.some(isPref);
    const message = ranked.length
      ? (prefOverBudget
        ? `No course in ${names} fits the budget (the eligible ones cost more than 50% over it), so alternatives from other countries are shown.`
        : `No suitable courses were found in ${names} based on the current profile, so alternatives from other countries are shown.`)
      : (stretchOptions.length
        ? `No suitable courses were found in ${names} within budget, and no other country fits the budget either. The closest over-budget options are listed as stretch.`
        : `No suitable courses were found in ${names} or in any other country. See the excluded list for the reason on each course.`);
    countryFallback = { preferred: profile.preferred_countries, message };
    notes.unshift(message);
  }
  if (profile.mandatory_countries.length && !ranked.length) notes.unshift(`${profile.mandatory_countries.map(nameOf).join(", ")} is marked mandatory, so courses in other countries are never shown. Mark it as preferred instead to see alternatives.`);
  if (!ranked.length && !stretchOptions.length) notes.push("No course passed the hard eligibility checks. See the excluded list for the reason on each course.");
  if (profile.missing.length) notes.push(`Profile incomplete: ${profile.missing.join(", ")}. Missing items get neutral scores and are flagged on each course.`);

  const pool = ranked.length ? ranked : stretchOptions;
  const plan = pool
    .slice(0, Math.max(limit, 10))
    .map((r) => ({ course_slug: r.course_slug, name: r.name, university: r.university, country: r.country, rank: r.rank, score: r.score, readiness: r.readiness.percent, priority: r.readiness.priority, priority_rank: r.readiness.priority_rank, deadline: r.readiness.deadline, reason: r.readiness.reason, next_action: r.readiness.next_action }))
    .sort((a, b) => a.priority_rank - b.priority_rank || (a.deadline?.days_left ?? 9999) - (b.deadline?.days_left ?? 9999) || a.rank - b.rank);

  return {
    profile, today, weights: WEIGHTS, results: ranked.slice(0, limit), alternatives: ranked.slice(limit),
    stretch: stretchOptions, excluded, plan, notes, country_fallback: countryFallback, counts: { evaluated: data.courses.length, eligible: ranked.length, excluded: excluded.length },
  };
}