import { parseJson } from "./util.js";

/** Evaluates one rule against profile+course. -> "pass" | "fail" | "unknown" */
function evalRule(rule, profile, course) {
  const v = parseJson(rule.value);
  const op = rule.operator;
  const norm = (x) => String(x).toLowerCase();
  const has = (list, x) => (Array.isArray(list) ? list : [list]).some((y) => norm(y) === norm(x));
  const cmpIn = (actual) => (actual == null || actual === "" ? "unknown" : (op === "in" ? has(v, actual) : norm(v) === norm(actual)) ? "pass" : "fail");

  switch (rule.attribute) {
    case "nationality": return cmpIn(profile.nationality);
    case "degree_level": return cmpIn(course.degree_level);
    case "field": return cmpIn(course.field);
    case "destination_country": {
      const c = course.country;
      const ok = op === "in" ? has(v, c.country_slug) || has(v, c.name) : norm(v) === norm(c.country_slug) || norm(v) === norm(c.name);
      return ok ? "pass" : "fail";
    }
    case "category": return cmpIn(profile.category);
    case "gender": return cmpIn(profile.gender);
    case "state": return cmpIn(profile.state);
    case "family_income_max_inr":
      return profile.family_income_inr == null ? "unknown" : profile.family_income_inr <= Number(v) ? "pass" : "fail";
    case "min_percentage":
      return profile.percentage == null ? "unknown" : profile.percentage >= Number(v) ? "pass" : "fail";
    default: return "unknown";
  }
}

const NEEDS = { category: "category", gender: "gender", state: "state", family_income_max_inr: "family income", min_percentage: "CGPA/percentage", nationality: "nationality" };

/** Scholarships relevant to this course, split into eligible / possible (needs info) / not eligible. */
export function matchScholarships(course, profile, data) {
  const allScholarships = data.scholarships;
  const out = { eligible: [], possible: [], not_eligible: [] };
  for (const s of allScholarships) {
    if (s.uni_slug && s.uni_slug !== course.uni_slug) continue;
    if (!s.uni_slug && s.country_slug && s.provider_type !== "home_govt" && s.country_slug !== course.country.country_slug) continue;

    // The award is in the scholarship's own country currency (INR for Indian schemes), not necessarily the course's.
    const cur = data.countryBySlug[s.country_slug]?.currency ?? course.country.currency;
    const rate = cur === "INR" ? 1 : data.fx[cur]?.inr_per_unit ?? null;
    const checks = s.rules.map((r) => ({ attribute: r.attribute, status: evalRule(r, profile, course), description: r.description }));
    const failed = checks.filter((c) => c.status === "fail");
    const unknown = checks.filter((c) => c.status === "unknown");
    const item = {
      slug: s.scholarship_slug, name: s.name, provider: s.provider, provider_type: s.provider_type,
      amount_local: s.amount_local, covers: s.covers, deadline: s.deadline, source_url: s.source_url, data_quality: s.data_quality,
      currency: cur,
      amount_inr: s.amount_local == null ? null : rate != null ? s.amount_local * rate : null,
      checks,
      reasons: failed.map((c) => c.description || `${c.attribute} not met`),
      needs: [...new Set(unknown.map((c) => NEEDS[c.attribute] || c.attribute))],
    };
    if (failed.length) out.not_eligible.push(item);
    else if (unknown.length) out.possible.push(item);
    else out.eligible.push(item);
  }
  return out;
}
