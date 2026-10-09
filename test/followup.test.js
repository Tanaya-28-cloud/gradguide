// Tests for the information-collection flow: several facts in one message, items the counsellor says are unavailable,
// and the completion rule (country and intake must be given or explicitly left flexible before Confirm Profile).
// The LLM is mocked: no network, no API key needed. Run: npm run test:llm
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateExtraction, buildSchema, buildPrompt, MISSING_ITEMS, FLEXIBLE_ITEMS, openPreferences } from "../engine/understand.js";
import { extractProfile } from "../engine/extract.js";
import { normalizeProfile } from "../engine/profile.js";
import { nextQuestion } from "../public/followup.js";

const COUNTRIES = ["usa", "uk", "australia", "canada", "ireland", "new-zealand", "uae"].map((s) => ({ country_slug: s, name: s }));
const SLUGS = COUNTRIES.map((c) => c.country_slug);
const KEY = { apiKey: "test-key", model: "test-model", baseUrl: "http://mock" };
const reply = (data) => async () => ({ data: { corrections: [], ambiguities: [], unavailable: [], has_new_info: true, summary: "", ...data }, model: "m" });

test("schema: 'unavailable' is offered to the model but is optional, and limited to the labels normalizeProfile can report as missing", () => {
    const s = buildSchema(SLUGS);
    assert.deepEqual(s.properties.unavailable.items.enum, MISSING_ITEMS);
    assert.ok(!s.required.includes("unavailable"));
});

test("validate: unavailable keeps only known missing-item labels and removes duplicates", () => {
    const v = validateExtraction({ updates: {}, unavailable: ["English test score", "English test score", "favourite colour", 7] }, SLUGS);
    assert.deepEqual(v.unavailable, ["English test score"]);
    assert.deepEqual(validateExtraction({ updates: {} }, SLUGS).unavailable, []);
});

test("prompt: the model is told what is still missing, so it can use the whole message", () => {
    const p = buildPrompt({ text: "x", profile: { degree: "BTech", missing: ["budget", "English test score"] }, history: [], countries: COUNTRIES, today: "2026-10-09" });
    assert.match(p, /STILL MISSING[^\n]*budget; English test score/);
    const none = buildPrompt({ text: "x", profile: null, history: [], countries: COUNTRIES, today: "2026-10-09" });
    assert.match(none, /STILL MISSING[^\n]*\(none\)/);
});

test("one reply with several facts: all of them are merged, including ones the question did not ask for", async () => {
    const first = await extractProfile("BE computer engineering", COUNTRIES, null, { config: KEY, generate: reply({ updates: { degree: "BE", field_of_study: "computer engineering" } }), log: () => { } });
    assert.deepEqual(first.profile.missing.sort(), ["CGPA / percentage", "English test score", "budget", "career goal"].sort());
    const history = [{ role: "counsellor", text: "BE computer engineering" }, { role: "assistant", text: "What was the student's CGPA?" }];
    const second = await extractProfile("8.2, IELTS 7, wants AI, about 30 lakh, Canada preferred", COUNTRIES, first.profile, {
        config: KEY, history, log: () => { },
        generate: reply({ updates: { cgpa: 8.2, english: { test: "IELTS", score: 7 }, goals: ["ai-ml"], budget_inr: 3000000, preferred_countries: ["canada"] } }),
    });
    assert.deepEqual(second.profile.missing, []);
    assert.equal(second.profile.degree, "BE");
    assert.deepEqual(second.profile.preferred_countries, ["canada"]);
});

test("unavailable is passed through to the caller, and the profile is not changed by it", async () => {
    const before = (await extractProfile("BE computer, 8 CGPA", COUNTRIES, null, { config: KEY, generate: reply({ updates: { degree: "BE", field_of_study: "computer", cgpa: 8 } }), log: () => { } })).profile;
    const r = await extractProfile("hasn't taken any English test yet", COUNTRIES, before, { config: KEY, log: () => { }, generate: reply({ updates: {}, unavailable: ["English test score"], has_new_info: false }) });
    assert.deepEqual(r.unavailable, ["English test score"]);
    assert.ok(r.profile.missing.includes("English test score"), "still flagged as missing in the profile, just not asked about again");
    assert.equal(r.profile.cgpa, 8);
});

test("rule-based fallback reports an empty unavailable list", async () => {
    const r = await extractProfile("BTech cloud, 8 CGPA", COUNTRIES, null, { config: { apiKey: "", model: "m", baseUrl: "http://mock" }, log: () => { } });
    assert.equal(r.extractor, "rules");
    assert.deepEqual(r.unavailable, []);
});

// ---------- completion criteria: country / intake / budget scope ----------
const fullCore = { degree: "BE", field_of_study: "Mechanical Engineering", cgpa: 9, english: { test: "TOEFL", score: 100 }, goals: ["cybersecurity"], budget_inr: 4000000 };
const prof = (over = {}) => normalizeProfile({ ...fullCore, ...over }, SLUGS);
const fresh = () => ({ asked: {}, unavailable: {}, flexible: {}, stated: { budget_scope: true } });

test("completion: all core items present but NO country preference -> the country question is asked, not Confirm Profile", () => {
    const q = nextQuestion(prof({ intake_year: 2027 }), fresh());
    assert.equal(q.key, "country preference");
    assert.match(q.text, /preferred country, or should I consider all supported countries/);
});

test("completion: a missing country is not treated as 'all countries' until the counsellor says so", () => {
    const ctx = fresh();
    assert.equal(nextQuestion(prof({ intake_year: 2027 }), ctx).key, "country preference");
    ctx.flexible["country preference"] = true; // what the LLM layer reports when the counsellor says any country is fine
    assert.equal(nextQuestion(prof({ intake_year: 2027 }), ctx), null);
});

test("completion: any country bucket (mandatory, preferred or acceptable) counts as a country answer", () => {
    for (const bucket of ["mandatory_countries", "preferred_countries", "acceptable_countries"]) {
        assert.equal(nextQuestion(prof({ [bucket]: ["canada"], intake_year: 2027 }), fresh()), null, bucket);
    }
});

test("completion: missing intake is asked; a stated intake or an explicitly flexible intake is accepted", () => {
    const withCountry = { preferred_countries: ["canada"] };
    assert.equal(nextQuestion(prof(withCountry), fresh()).key, "intake");
    assert.equal(nextQuestion(prof({ ...withCountry, intake_year: 2027 }), fresh()), null);
    assert.equal(nextQuestion(prof({ ...withCountry, intake_month: 9 }), fresh()), null);
    const ctx = fresh(); ctx.flexible["intake"] = true;
    assert.equal(nextQuestion(prof(withCountry), ctx), null);
});

test("completion: the exact failing case (mechanical, 9.0, TOEFL, 40 lakh, cybersecurity) still asks about country first, then intake", () => {
    const ctx = fresh();
    const q1 = nextQuestion(prof(), ctx);
    assert.equal(q1.key, "country preference");
    assert.match(q1.text, /add the intake/, "intake is offered in the same reply");
    ctx.asked[q1.key] = 1; ctx.flexible["country preference"] = true;
    assert.equal(nextQuestion(prof(), ctx).key, "intake");
});

test("completion: one question at a time, in priority order, and nothing already supplied is asked again", () => {
    const p = normalizeProfile({ degree: "BE", field_of_study: "Mechanical Engineering" }, SLUGS);
    const q = nextQuestion(p, { ...fresh() });
    assert.equal(q.key, "CGPA / percentage");
    assert.equal((q.text.match(/\?/g) || []).length, 1 + 0, "a single question mark: one question");
    const keys = [];
    const ctx = fresh();
    for (let i = 0; i < 12; i++) { const n = nextQuestion(p, ctx); if (!n) break; keys.push(n.key); ctx.asked[n.key] = (ctx.asked[n.key] || 0) + 1; }
    assert.ok(!keys.includes("degree / background"));
    assert.deepEqual([...new Set(keys)].slice(0, 3), ["CGPA / percentage", "English test score", "career goal"]);
});

test("completion: an item the counsellor said is unavailable (e.g. no English test yet) is not asked again", () => {
    const p = prof({ english: null, preferred_countries: ["canada"], intake_year: 2027 });
    assert.equal(nextQuestion(p, fresh()).key, "English test score");
    const ctx = fresh(); ctx.unavailable["English test score"] = true;
    assert.equal(nextQuestion(p, ctx), null);
});

test("completion: a budget is not complete until its scope has been stated", () => {
    const p = prof({ preferred_countries: ["canada"], intake_year: 2027 });
    const ctx = { asked: {}, unavailable: {}, flexible: {}, stated: {} };
    const q = nextQuestion(p, ctx);
    assert.equal(q.key, "budget scope");
    assert.match(q.text, /₹40 lakh budget cover tuition and living costs together, or tuition only/);
    ctx.stated.budget_scope = true;
    assert.equal(nextQuestion(p, ctx), null);
});

test("completion: optional details never block confirmation, and a question is never asked more than twice", () => {
    const p = prof({ preferred_countries: ["canada"], intake_year: 2027 }); // no GRE, scholarships, gender, category or documents
    assert.equal(nextQuestion(p, fresh()), null);
    const noCountry = prof({ intake_year: 2027 });
    const ctx = fresh(); ctx.asked["country preference"] = 2;
    assert.equal(nextQuestion(noCountry, ctx), null, "after two unanswered asks the counsellor can still confirm and set countries on the form");
});

// ---------- the language layer reports the explicit states ----------
test("schema + validate: 'flexible' only accepts country preference and intake", () => {
    assert.deepEqual(buildSchema(SLUGS).properties.flexible.items.enum, FLEXIBLE_ITEMS);
    assert.ok(!buildSchema(SLUGS).required.includes("flexible"));
    assert.deepEqual(validateExtraction({ updates: {}, flexible: ["intake", "intake", "country preference", "budget", 3] }, SLUGS).flexible, ["intake", "country preference"]);
    assert.deepEqual(validateExtraction({ updates: {} }, SLUGS).flexible, []);
});

test("prompt: open preferences are listed only while no country / intake is recorded", () => {
    assert.deepEqual(openPreferences(null), ["country preference", "intake"]);
    assert.deepEqual(openPreferences({ preferred_countries: ["canada"], mandatory_countries: [], acceptable_countries: [], intake_year: null, intake_month: null }), ["intake"]);
    assert.deepEqual(openPreferences({ acceptable_countries: ["uk"], intake_year: 2027 }), []);
    assert.match(buildPrompt({ text: "x", profile: null, history: [], countries: COUNTRIES, today: "2026-10-09" }), /OPEN PREFERENCES[^\n]*country preference; intake/);
});

test("end to end: 'any country is fine' is reported as flexible, and the profile gains no invented country", async () => {
    const known = (await extractProfile("BE mechanical, 9 CGPA, TOEFL 100, cybersecurity, 40 lakh", COUNTRIES, null, { config: KEY, log: () => { }, generate: reply({ updates: { degree: "BE", field_of_study: "mechanical", cgpa: 9, english: { test: "TOEFL", score: 100 }, goals: ["cybersecurity"], budget_inr: 4000000, budget_scope: "total" } }) })).profile;
    const r = await extractProfile("no preference, any country works", COUNTRIES, known, { config: KEY, log: () => { }, history: [{ role: "assistant", text: "Does the student have a preferred country, or should I consider all supported countries?" }], generate: reply({ updates: {}, flexible: ["country preference"], has_new_info: false }) });
    assert.deepEqual(r.flexible, ["country preference"]);
    assert.deepEqual([r.profile.mandatory_countries, r.profile.preferred_countries, r.profile.acceptable_countries], [[], [], []]);
    assert.deepEqual(r.stated, []);
});

test("end to end: the fields a message states are reported, so budget scope can be told apart from the default", async () => {
    const r = await extractProfile("40 lakh including living", COUNTRIES, null, { config: KEY, log: () => { }, generate: reply({ updates: { budget_inr: 4000000, budget_scope: "total" } }) });
    assert.deepEqual(r.stated.sort(), ["budget_inr", "budget_scope"]);
    const r2 = await extractProfile("around 40 lakh", COUNTRIES, null, { config: KEY, log: () => { }, generate: reply({ updates: { budget_inr: 4000000 } }) });
    assert.ok(!r2.stated.includes("budget_scope"));
});

test("validate: TOEFL and PTE totals are whole numbers, so 'TOEFL 8.24' is rejected instead of stored; IELTS keeps its halves", () => {
    assert.equal(validateExtraction({ updates: { english: { test: "TOEFL", score: 8.24 } } }, SLUGS).updates.english, undefined);
    assert.deepEqual(validateExtraction({ updates: { english: { test: "TOEFL", score: 8.24 } } }, SLUGS).rejected, ["english"]);
    assert.deepEqual(validateExtraction({ updates: { english: { test: "TOEFL", score: 100 } } }, SLUGS).updates.english, { test: "TOEFL", score: 100 });
    assert.deepEqual(validateExtraction({ updates: { english: { test: "IELTS", score: 6.5 } } }, SLUGS).updates.english, { test: "IELTS", score: 6.5 });
});

// ---------- a stated number that cannot be right is queried, not silently dropped ----------
test("validate: 'PTE 7' (PTE runs 10-90) is not stored and produces a precise question", () => {
    const v = validateExtraction({ updates: { english: { test: "PTE", score: 7 }, budget_inr: 6000000 } }, SLUGS);
    assert.equal(v.updates.english, undefined);
    assert.equal(v.updates.budget_inr, 6000000, "the rest of the message is still used");
    assert.equal(v.ambiguities.length, 1);
    assert.match(v.ambiguities[0].question, /PTE scores run from 10 to 90, in whole numbers, so 7 doesn't fit/);
});

test("validate: out-of-scale CGPA / GRE are queried too; valid values and non-numbers are not", () => {
    const v = validateExtraction({ updates: { cgpa: 11, gre: 500 } }, SLUGS);
    assert.deepEqual(v.ambiguities.map((a) => a.field).sort(), ["cgpa", "gre"]);
    assert.equal(validateExtraction({ updates: { cgpa: 8.2 } }, SLUGS).ambiguities.length, 0);
    assert.equal(validateExtraction({ updates: { cgpa: "high" } }, SLUGS).ambiguities.length, 0);
});

test("end to end: the screenshot message keeps budget and country, and the app is told to ask about the PTE score", async () => {
    const r = await extractProfile("pte with a score of 7, budget is 60 lakhs, preffered country is new zealand", COUNTRIES, null, {
        config: KEY, log: () => { },
        generate: reply({ updates: { english: { test: "PTE", score: 7 }, budget_inr: 6000000, preferred_countries: ["new-zealand"] } }),
    });
    assert.equal(r.profile.budget_inr, 6000000);
    assert.deepEqual(r.profile.preferred_countries, ["new-zealand"]);
    assert.equal(r.profile.english, null);
    assert.match(r.ambiguities[0].question, /PTE scores run from 10 to 90/);
});