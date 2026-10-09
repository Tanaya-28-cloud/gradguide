import { DatabaseSync } from "node:sqlite";
import path from "node:path";

export function openDb(file = process.env.DB_PATH || path.join(import.meta.dirname, "gradguide.db")) {
  return new DatabaseSync(file, { readOnly: true });
}

const all = (db, sql) => db.prepare(sql).all().map((r) => ({ ...r }));

/** Loads the whole (small) dataset into memory once and joins it into course objects. */
export function loadData(db) {
  const countries = all(db, "SELECT * FROM countries");
  const fx = Object.fromEntries(all(db, "SELECT * FROM fx_rates").map((r) => [r.currency, r]));
  const cities = Object.fromEntries(all(db, "SELECT * FROM cities").map((r) => [r.city_slug, r]));
  const unis = Object.fromEntries(all(db, "SELECT * FROM universities").map((r) => [r.uni_slug, r]));
  const countryBySlug = Object.fromEntries(countries.map((c) => [c.country_slug, c]));

  const group = (rows, key) => {
    const m = {};
    for (const r of rows) (m[r[key]] ||= []).push(r);
    return m;
  };
  const tags = group(all(db, "SELECT * FROM course_tags"), "course_slug");
  const intakes = group(all(db, "SELECT * FROM intakes ORDER BY start_year, start_month"), "course_slug");
  const docs = group(all(db, "SELECT * FROM course_documents"), "course_slug");
  const accom = group(all(db, "SELECT * FROM accommodation_options"), "uni_slug");
  const reqs = Object.fromEntries(all(db, "SELECT * FROM course_requirements").map((r) => [r.course_slug, r]));
  const rules = group(all(db, "SELECT * FROM scholarship_rules"), "scholarship_slug");
  const scholarships = all(db, "SELECT * FROM scholarships").map((s) => ({ ...s, rules: rules[s.scholarship_slug] || [] }));

  const courses = all(db, "SELECT * FROM courses ORDER BY course_slug").map((c) => {
    const uni = unis[c.uni_slug];
    const city = cities[uni.city_slug];
    const country = countryBySlug[city.country_slug];
    return {
      ...c,
      uni,
      city,
      country,
      fx_inr_per_unit: fx[country.currency]?.inr_per_unit ?? null,
      tags: (tags[c.course_slug] || []).map((t) => t.tag),
      intakes: intakes[c.course_slug] || [],
      docs: docs[c.course_slug] || [],
      accom: accom[c.uni_slug] || [],
      req: reqs[c.course_slug] || null,
    };
  });

  let demoStudents = [];
  try { demoStudents = all(db, "SELECT * FROM demo_students ORDER BY student_slug"); } catch { /* optional table */ }

  return { countries, countryBySlug, fx, courses, scholarships, demoStudents, fallbacks: buildFallbacks(courses, cities, unis, accom, countryBySlug, fx) };
}

const median = (a) => {
  const v = a.filter((x) => x != null).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/**
 * Blank living/housing costs must not make a course look cheaper than it is. For each missing value we impute the
 * median of the same country (local currency), or the dataset-wide median in INR, and the UI flags it as imputed.
 */
function buildFallbacks(courses, cities, unis, accom, countryBySlug, fx) {
  const inr = (local, country) => local * (fx[countryBySlug[country].currency]?.inr_per_unit ?? NaN);
  const living = {}, housing = {};
  const livingInr = [], housingInr = [];
  for (const city of Object.values(cities)) {
    if (city.monthly_living_cost_local == null) continue;
    (living[city.country_slug] ||= []).push(city.monthly_living_cost_local);
    livingInr.push(inr(city.monthly_living_cost_local, city.country_slug));
  }
  for (const [uniSlug, opts] of Object.entries(accom)) {
    const costs = opts.map((o) => o.monthly_cost_local).filter((x) => x != null);
    if (!costs.length) continue;
    const country = cities[unis[uniSlug].city_slug].country_slug;
    const cheapest = Math.min(...costs);
    (housing[country] ||= []).push(cheapest);
    housingInr.push(inr(cheapest, country));
  }
  const med = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, median(v)]));
  return { living: med(living), housing: med(housing), livingInr: median(livingInr), housingInr: median(housingInr) };
}
