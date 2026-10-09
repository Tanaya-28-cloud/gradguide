const DEFAULT_DOCS = [
  { doc_type: "SOP", quantity: 1, effort_days: 5 },
  { doc_type: "RESUME", quantity: 1, effort_days: 2 },
  { doc_type: "TRANSCRIPT", quantity: 1, effort_days: 7 },
  { doc_type: "DEGREE_CERTIFICATE", quantity: 1, effort_days: 7 },
  { doc_type: "ENGLISH_TEST", quantity: 1, effort_days: 0 },
  { doc_type: "PASSPORT", quantity: 1, effort_days: 3 },
];
const CAL_FACTOR = 1.5; // effort_days are working days; convert to calendar days

/** Fraction (0-1) of one document that is ready, from profile data + counsellor ticks. */
function docFraction(d, profile) {
  const qty = d.quantity || 1;
  const ticked = profile.docs_ready?.[d.doc_type];
  if (ticked) return typeof ticked === "number" ? Math.min(1, ticked / qty) : 1;
  if (d.doc_type === "ENGLISH_TEST" && profile.english) return 1;
  if (d.doc_type === "GRE" && profile.gre != null) return 1;
  return 0;
}

export function computeReadiness(course, profile, info, checks) {
  const isDefault = course.docs.length === 0;
  const docs = (isDefault ? DEFAULT_DOCS : course.docs).map((d) => {
    const frac = docFraction(d, profile);
    const effort = d.effort_days ?? 1;
    return { doc_type: d.doc_type, quantity: d.quantity, effort_days: effort, ready_fraction: frac, status: frac >= 1 ? "ready" : frac > 0 ? "partial" : "missing", remaining_effort: effort * (1 - frac) };
  });
  const totalEffort = docs.reduce((a, d) => a + d.effort_days, 0);
  const remaining = docs.reduce((a, d) => a + d.remaining_effort, 0);
  const percent = totalEffort === 0 ? 100 : Math.round(100 * (1 - remaining / totalEffort));

  const dl = info.chosen;
  const missing = docs.filter((d) => d.status !== "ready").map((d) => (d.quantity > 1 ? `${d.doc_type} ×${d.quantity}` : d.doc_type));
  let priority, reason, rank;
  if (!dl) { priority = "CLOSED"; reason = "No open intake"; rank = 9; }
  else if (dl.status === "not_published") { priority = "LOW"; reason = "Deadline not published — confirm with the university"; rank = 3; }
  else if (dl.status === "rolling") { priority = "MEDIUM"; reason = "Rolling admissions — earlier applications are usually favoured"; rank = 2; }
  else {
    const slack = dl.days_left - remaining * CAL_FACTOR;
    if (dl.days_left <= 60 || slack < 14) { priority = "HIGH"; rank = 1; }
    else if (dl.days_left <= 120 || slack < 45) { priority = "MEDIUM"; rank = 2; }
    else { priority = "LOW"; rank = 3; }
    reason = `${dl.days_left} days to deadline (${dl.deadline}); about ${Math.round(remaining * CAL_FACTOR)} calendar days of document work left`;
  }
  return {
    percent, priority, priority_rank: rank, reason,
    deadline: dl ? { date: dl.deadline, days_left: dl.days_left, status: dl.status, intake: `${dl.start_year}-${String(dl.start_month).padStart(2, "0")}` } : null,
    docs, missing, remaining_effort_days: Math.round(remaining * 10) / 10, default_checklist: isDefault,
    checks,
    next_action: dl
      ? missing.length ? `Start ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ` +${missing.length - 3} more` : ""}` : "All documents ready — submit application"
      : "No open intake",
  };
}
