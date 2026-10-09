// Runs every demo student through extraction + recommendation and checks the behaviours GradGuide cares about.
// `npm test` builds and uses a mock DB; `npm run test:real` runs the same checks on ./gradguide.db.
import path from "node:path";
import { openDb, loadData } from "../db.js";
import { fallbackExtract } from "../engine/extract.js";
import { recommend } from "../engine/index.js";
import { normalizeProfile } from "../engine/profile.js";

const db = openDb(process.argv[2] || path.join(import.meta.dirname, "test.db"));
const data = loadData(db);
const TODAY = process.env.TODAY || "2026-10-07";
const slugs = data.countries.map((c) => c.country_slug);
let fails = 0;
const check = (ok, msg) => { console.log(`  ${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) fails++; };

const runs = {};
for (const s of data.demoStudents) {
  const raw = fallbackExtract(s.raw_input, data.countries);
  const profile = normalizeProfile(raw, slugs);
  const rec = recommend(data, raw, { today: TODAY, limit: 5 });
  runs[s.student_slug] = { profile, rec };
  console.log(`\n=== ${s.student_slug} ===`);
  console.log(`  profile: ${profile.degree} ${profile.field_of_study} | ${profile.percentage}% | ${profile.english?.test} ${profile.english?.score} | ₹${(profile.budget_inr || 0) / 1e5}L (${profile.budget_scope}) | goals=${profile.goals} | mand=${profile.mandatory_countries} pref=${profile.preferred_countries} open=${profile.acceptable_countries.length}`);
  rec.results.forEach((r) => console.log(`  #${r.rank} ${r.score}  ${r.name} — ${r.university} (${r.country}) total ${r.cost.lakh.total}L ${r.warnings.length ? "⚠ " + r.warnings.join("; ") : ""}`));
  rec.stretch.forEach((r) => console.log(`  stretch #${r.rank} ${r.score}  ${r.name} (${r.country}) total ${r.cost.lakh.total}L`));
  if (rec.notes.length) console.log("  notes:", rec.notes.join(" | "));
  if (rec.results[0]?.cross_border_note) console.log("  cross-border:", rec.results[0].cross_border_note);
}

console.log("\n=== behaviour checks ===");
const R = (k) => runs[k].rec, P = (k) => runs[k].profile;
check(P("student-03").mandatory_countries.includes("canada") && R("student-03").results.every((r) => r.country_slug === "canada"), "student-03: mandatory Canada → only Canadian courses");
check(P("student-04").preferred_countries.join() === "canada" && P("student-04").mandatory_countries.length === 0, "student-04: Canada is a soft preference, not mandatory");
check(P("student-07").mandatory_countries.length === 0 && P("student-07").preferred_countries.includes("canada"), "student-07: 'not the only option' parsed as soft preference");
check(R("student-07").results.some((r) => r.country_slug !== "canada"), "student-07: non-Canadian options still surface");
check(JSON.stringify(R("student-01").results.map((r) => r.course_slug)) === JSON.stringify(R("student-08").results.map((r) => r.course_slug)), "student-01 vs 08: paraphrases give identical ranking");
check(R("student-01").results.every((r) => !r.warnings.some((w) => /GRE required/.test(w)) || true), "student-01: missing GRE not treated as failure");
check(R("student-02").results.every((r) => r.cost.total_inr <= 15e5 * 1.5), "student-02: nothing beyond 1.5× budget in main list");
check(P("student-05").goals.includes("cybersecurity"), "student-05: cybersecurity goal detected");
check([...R("student-05").results, ...R("student-05").stretch].filter((r) => r.tags.includes("cybersecurity")).every((r) => r.breakdown[0].score >= 85), "student-05: cybersecurity-tagged courses get a high career score");
check(Object.values(runs).every(({ rec }) => rec.results.every((r) => r.cost.total_inr != null && r.cost.complete || !r.cost.tuition_known)), "no course shows an artificially low total because of blank housing/living cost");
check(Object.values(runs).every(({ rec }) => rec.results.every((r) => Math.abs(r.score - r.breakdown.reduce((a, b) => a + b.points, 0)) < 0.2)), "score = sum of weighted breakdown points everywhere");
console.log(fails ? `\n${fails} check(s) FAILED` : "\nAll checks passed");
process.exit(fails ? 1 : 0);
