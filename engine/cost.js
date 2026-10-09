import { lakh } from "./util.js";

/** Tuition + housing + living for the whole programme, in INR, with explicit unknowns. */
export function computeCost(course, fallbacks = {}) {
  const fx = course.fx_inr_per_unit;
  const toInr = (v) => (v == null || fx == null ? null : v * fx);
  const months = course.duration_months;
  const years = months / 12;
  const flags = [];

  let tuitionLocal = course.tuition_total_local;
  if (tuitionLocal == null && course.tuition_per_year_local != null) {
    tuitionLocal = course.tuition_per_year_local * years;
    flags.push("Tuition derived from per-year fee");
  }
  const tuition = toInr(tuitionLocal);

  const options = course.accom
    .filter((a) => a.monthly_cost_local != null)
    .map((a) => ({ type: a.type, monthly_local: a.monthly_cost_local, monthly_inr: toInr(a.monthly_cost_local), distance_km: a.distance_km, data_quality: a.data_quality, source_url: a.source_url }))
    .sort((a, b) => a.monthly_inr - b.monthly_inr);
  const cheapest = options[0] || null;
  const slug = course.country.country_slug;
  const imputed = [];
  let housingMonthly = cheapest ? cheapest.monthly_inr : null;
  if (housingMonthly == null) {
    const local = fallbacks.housing?.[slug];
    housingMonthly = local != null ? toInr(local) : fallbacks.housingInr ?? null;
    if (housingMonthly != null) { imputed.push("housing"); flags.push(`Housing cost not published — imputed from ${local != null ? `other ${course.country.name} universities` : "the dataset median"}`); }
  }
  const housing = housingMonthly == null ? null : housingMonthly * months;
  let livingMonthly = toInr(course.city.monthly_living_cost_local);
  if (livingMonthly == null) {
    const local = fallbacks.living?.[slug];
    livingMonthly = local != null ? toInr(local) : fallbacks.livingInr ?? null;
    if (livingMonthly != null) { imputed.push("living"); flags.push(`Living cost not published — imputed from ${local != null ? `other ${course.country.name} cities` : "the dataset median"}`); }
  }
  const living = livingMonthly == null ? null : livingMonthly * months;

  if (tuition == null) flags.push("Tuition unknown");
  if (course.data_quality === "estimated") flags.push("Tuition is an estimate");
  if (course.city.data_quality === "estimated") flags.push("Living cost is an estimate");

  const known = [tuition, housing, living].filter((x) => x != null);
  const total = known.length ? known.reduce((a, b) => a + b, 0) : null;
  return {
    currency: course.country.currency,
    duration_months: months,
    tuition_inr: tuition, housing_inr: housing, living_inr: living,
    housing_type: cheapest?.type ?? null,
    housing_options: options,
    living_monthly_inr: livingMonthly,
    total_inr: total,
    complete: tuition != null && housing != null && living != null,
    imputed,
    per_year_inr: total == null ? null : total / years,
    tuition_known: tuition != null,
    lakh: { tuition: lakh(tuition), housing: lakh(housing), living: lakh(living), total: lakh(total), per_year: lakh(total == null ? null : total / years) },
    flags,
  };
}
