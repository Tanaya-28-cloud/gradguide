// Tests for the natural-language extraction layer. The LLM is mocked everywhere: no network, no API key needed.
// Run: npm run test:llm
import { test } from "node:test";
import assert from "node:assert/strict";
import { GeminiError, generateJson, geminiConfig, listModels, DEFAULT_MODEL } from "../engine/llm/gemini.js";
import { validateExtraction, buildSchema, buildPrompt, knownFacts, understandMessage, ExtractionError, CORRECTABLE } from "../engine/understand.js";
import { applyExtraction, countStated } from "../engine/apply.js";
import { extractProfile } from "../engine/extract.js";
import { normalizeProfile } from "../engine/profile.js";

const COUNTRIES = ["usa", "uk", "australia", "canada", "ireland", "new-zealand", "uae"].map((s) => ({ country_slug: s, name: s }));
const SLUGS = COUNTRIES.map((c) => c.country_slug);
const KEY = { apiKey: "test-key", model: "test-model", baseUrl: "http://mock" };
const quiet = () => { };
const ok = (updates, extra = {}) => ({ data: { updates, corrections: [], ambiguities: [], has_new_info: true, summary: "", ...extra } });
const mockGenerate = (...replies) => { const calls = []; const fn = async (args) => { calls.push(args); const r = replies[Math.min(calls.length - 1, replies.length - 1)]; if (r instanceof Error) throw r; return r; }; fn.calls = calls; return fn; };

// ---------- schema contract ----------
test("schema: the fields the model may return are exactly the raw profile fields normalizeProfile reads", () => {
    const props = Object.keys(buildSchema(SLUGS).properties.updates.properties).sort();
    const expected = ["degree", "field_of_study", "cgpa", "percentage", "english", "gre", "gmat", "work_exp_months", "goals", "research", "budget_inr", "budget_scope", "mandatory_countries", "preferred_countries", "acceptable_countries", "intake_year", "intake_month", "wants_scholarships", "nationality", "category", "gender", "state", "family_income_inr", "docs_ready"].sort();
    assert.deepEqual(props, expected);
    assert.deepEqual(buildSchema(SLUGS).required.sort(), ["ambiguities", "corrections", "has_new_info", "summary", "updates"]);
    assert.ok(CORRECTABLE.includes("countries"));
});

// ---------- validation ----------
test("validate: accepts a well-formed reply and keeps the raw profile shape", () => {
    const v = validateExtraction({ updates: { degree: "BTech", cgpa: 8.4, english: { test: "ielts", score: 7 }, goals: ["cloud-devops", "cloud-devops"], preferred_countries: ["canada"], budget_inr: 2800000, docs_ready: ["SOP"] }, corrections: [], ambiguities: [], has_new_info: true, summary: "ok" }, SLUGS);
    assert.deepEqual(v.updates, { degree: "BTech", cgpa: 8.4, english: { test: "IELTS", score: 7 }, goals: ["cloud-devops"], preferred_countries: ["canada"], budget_inr: 2800000, docs_ready: { SOP: true } });
    assert.equal(v.has_new_info, true);
});

test("validate: drops invalid values instead of repairing them, and reports what it dropped", () => {
    const v = validateExtraction({ updates: { cgpa: 84, english: { test: "IELTS", score: 12 }, intake_year: 1999, intake_month: 13, goals: ["astrology"], preferred_countries: ["mars"], gre: "abc", gender: "x", budget_inr: -5, mystery_field: 1, research: "yes" } }, SLUGS);
    assert.deepEqual(v.updates, {});
    assert.deepEqual(v.rejected.sort(), ["budget_inr", "cgpa", "english", "gender", "goals", "gre", "intake_month", "intake_year", "mystery_field", "preferred_countries", "research"]);
    assert.equal(v.has_new_info, false);
});

test("validate: has_new_info comes from what survived validation, not from the model's claim", () => {
    assert.equal(validateExtraction({ updates: { cgpa: 99 }, has_new_info: true }, SLUGS).has_new_info, false);
    assert.equal(validateExtraction({ updates: {}, corrections: ["goals"], has_new_info: false }, SLUGS).has_new_info, true);
});

test("validate: normalises category/gender, accepts numeric strings, ignores null and empty values", () => {
    const v = validateExtraction({ updates: { category: "general", gender: "Female", cgpa: "8.1", gre: null, goals: [], state: "  " } }, SLUGS);
    assert.deepEqual(v.updates, { category: "General", gender: "female", cgpa: 8.1 });
});

test("validate: unknown correction fields are ignored; ambiguities need a question and are capped at two", () => {
    const v = validateExtraction({ updates: {}, corrections: ["goals", "nonsense", "goals"], ambiguities: [{ field: "budget_inr", issue: "unit unclear", question: "Is that in lakh?" }, { field: "x", issue: "no question" }, { field: "a", issue: "i", question: "q1" }, { field: "b", issue: "i", question: "q2" }] }, SLUGS);
    assert.deepEqual(v.corrections, ["goals"]);
    assert.deepEqual(v.ambiguities.map((a) => a.question), ["Is that in lakh?", "q1"]);
});

test("validate: unusable payloads throw ExtractionError", () => {
    for (const bad of [null, "text", [], 42, {}, { updates: null }, { updates: [] }, { updates: "x" }]) assert.throws(() => validateExtraction(bad, SLUGS), ExtractionError);
});

// ---------- prompt / context ----------
test("prompt: carries the known profile, the conversation, the assistant's last question, today's date and the allowed slugs", () => {
    const profile = normalizeProfile({ degree: "BTech", cgpa: 8.4, goals: ["cloud-devops"], mandatory_countries: ["canada"] }, SLUGS);
    const p = buildPrompt({ text: "28", profile, history: [{ role: "counsellor", text: "BTech CSE, 8.4 CGPA" }, { role: "assistant", text: "What is the student's budget?" }], countries: COUNTRIES, today: "2026-10-09" });
    assert.match(p, /TODAY: 2026-10-09/);
    assert.match(p, /cloud-devops/);
    assert.match(p, /Counsellor: BTech CSE, 8\.4 CGPA/);
    assert.match(p, /ASSISTANT'S MOST RECENT QUESTION: What is the student's budget\?/);
    assert.match(p, /new-zealand/);
    assert.match(p, /"""28"""/);
});

test("prompt: no question is shown when the last turn was not the assistant's; derived and default values are not presented as stated", () => {
    const p = buildPrompt({ text: "x", profile: normalizeProfile({ cgpa: 8.4 }, SLUGS), history: [{ role: "assistant", text: "Q?" }, { role: "counsellor", text: "A" }], countries: COUNTRIES, today: "2026-10-09" });
    assert.match(p, /ASSISTANT'S MOST RECENT QUESTION: \(none\)/);
    const facts = knownFacts(normalizeProfile({ cgpa: 8.4 }, SLUGS));
    assert.deepEqual(facts, { cgpa: 8.4 }); // no derived 79.8%, no default nationality / budget scope / empty arrays
});

test("understandMessage sends the schema and returns a validated extraction", async () => {
    const generate = mockGenerate(ok({ budget_inr: 2800000 }));
    const { extraction } = await understandMessage({ text: "28 lakh", profile: null, history: [], countries: COUNTRIES, today: "2026-10-09", generate, config: KEY });
    assert.deepEqual(extraction.updates, { budget_inr: 2800000 });
    assert.equal(generate.calls[0].schema.type, "object");
    assert.ok(generate.calls[0].system.length > 100);
});

// ---------- profile merging ----------
test("apply: an empty extraction leaves the profile exactly as it was", () => {
    const existing = normalizeProfile({ degree: "BTech", cgpa: 8.4, english: { test: "IELTS", score: 7 }, goals: ["cloud-devops"], preferred_countries: ["canada"], budget_inr: 2800000 }, SLUGS);
    const merged = applyExtraction(existing, { updates: {}, corrections: [] });
    assert.deepEqual(normalizeProfile(merged, SLUGS), existing);
});

test("apply: new facts are added and nothing earlier is lost", () => {
    const p1 = normalizeProfile(applyExtraction(null, { updates: { degree: "BTech", cgpa: 8.4 }, corrections: [] }), SLUGS);
    const p2 = normalizeProfile(applyExtraction(p1, { updates: { english: { test: "IELTS", score: 7 }, goals: ["cloud-devops"] }, corrections: [] }), SLUGS);
    const p3 = normalizeProfile(applyExtraction(p2, { updates: { goals: ["ai-ml"], budget_inr: 2500000 }, corrections: [] }), SLUGS);
    assert.equal(p3.cgpa, 8.4);
    assert.deepEqual(p3.english, { test: "IELTS", score: 7 });
    assert.deepEqual(p3.goals, ["cloud-devops", "ai-ml"]); // goals accumulate unless explicitly corrected
    assert.equal(p3.budget_inr, 2500000);
});

test("apply: an explicit correction replaces lists and country sets instead of adding to them", () => {
    const existing = normalizeProfile({ goals: ["cloud-devops", "cybersecurity"], mandatory_countries: ["canada"], preferred_countries: ["uk"], research: true }, SLUGS);
    const merged = normalizeProfile(applyExtraction(existing, { updates: { goals: ["ai-ml"], acceptable_countries: ["ireland"], research: false }, corrections: ["goals", "countries", "research"] }), SLUGS);
    assert.deepEqual(merged.goals, ["ai-ml"]);
    assert.deepEqual(merged.mandatory_countries, []);
    assert.deepEqual(merged.preferred_countries, []);
    assert.deepEqual(merged.acceptable_countries, ["ireland"]);
    assert.equal(merged.research, false);
});

test("apply: a corrected scalar replaces the old value; the input objects are not mutated", () => {
    const existing = normalizeProfile({ budget_inr: 2800000, cgpa: 8.4 }, SLUGS);
    const copy = structuredClone(existing);
    const merged = normalizeProfile(applyExtraction(existing, { updates: { budget_inr: 3000000 }, corrections: ["budget_inr"] }), SLUGS);
    assert.equal(merged.budget_inr, 3000000);
    assert.equal(merged.cgpa, 8.4);
    assert.deepEqual(existing, copy);
});

test("apply: countStated ignores the extractor's defaults", () => {
    assert.equal(countStated({ goals: [], research: false, budget_scope: "total", docs_ready: {} }), 0);
    assert.equal(countStated({ budget_scope: "total", cgpa: 8 }), 1);
});

// ---------- end-to-end extraction (mocked LLM) ----------
test("extractProfile: a multi-turn conversation accumulates, and passes context to the model each turn", async () => {
    const opts = (generate, history) => ({ generate, history, config: KEY, today: "2026-10-09", log: quiet });
    const g1 = mockGenerate(ok({ degree: "BTech", field_of_study: "CSE", cgpa: 8.4, english: { test: "IELTS", score: 7 }, goals: ["cloud-devops"] }));
    const r1 = await extractProfile("first message", COUNTRIES, null, opts(g1, []));
    assert.equal(r1.extractor, "gemini");
    assert.equal(r1.note, null);
    assert.equal(r1.llm_error, null);

    const g2 = mockGenerate(ok({ budget_inr: 2800000 }));
    const history = [{ role: "counsellor", text: "first message" }, { role: "assistant", text: "What's the budget?" }];
    const r2 = await extractProfile("28", COUNTRIES, r1.profile, opts(g2, history));
    assert.match(g2.calls[0].prompt, /What's the budget\?/);
    assert.match(g2.calls[0].prompt, /cloud-devops/);
    assert.equal(r2.profile.budget_inr, 2800000);
    assert.equal(r2.profile.cgpa, 8.4);
    assert.deepEqual(r2.profile.goals, ["cloud-devops"]);
    assert.deepEqual(r2.profile.missing, []);
});

test("extractProfile: ambiguity is reported and the uncertain value is not applied", async () => {
    const existing = normalizeProfile({ degree: "BTech" }, SLUGS);
    const g = mockGenerate({ data: { updates: {}, corrections: [], has_new_info: false, summary: "", ambiguities: [{ field: "cgpa", issue: "7 could be CGPA or IELTS", question: "Is the 7 the student's CGPA or an IELTS score?" }] } });
    const r = await extractProfile("7", COUNTRIES, existing, { generate: g, config: KEY, log: quiet });
    assert.equal(r.extractor, "gemini");
    assert.equal(r.ambiguities.length, 1);
    assert.equal(r.has_new_info, false);
    assert.equal(r.profile.cgpa, null);
    assert.equal(r.profile.degree, "BTech");
});

// ---------- failure handling ----------
test("extractProfile: a malformed model reply falls back to the rules, keeps the profile and says so", async () => {
    const existing = normalizeProfile({ degree: "BTech", cgpa: 8.4, budget_inr: 2800000 }, SLUGS);
    for (const reply of [{ data: { not: "the contract" } }, { data: "plain text" }, new GeminiError("malformed", "Gemini returned text that is not valid JSON.")]) {
        const r = await extractProfile("IELTS 7", COUNTRIES, existing, { generate: mockGenerate(reply), config: KEY, log: quiet });
        assert.equal(r.extractor, "rules");
        assert.equal(r.llm_error.kind, "malformed");
        assert.match(r.note, /rule-based/i);
        assert.deepEqual(r.profile.english, { test: "IELTS", score: 7 }); // the fallback still understood what it can
        assert.equal(r.profile.cgpa, 8.4); // existing information survived
        assert.equal(r.profile.budget_inr, 2800000);
    }
});

test("extractProfile: every Gemini failure kind falls back visibly, with its own reason, and never erases the profile", async () => {
    const existing = normalizeProfile({ degree: "BTech", cgpa: 8.4 }, SLUGS);
    const kinds = [["bad_model", /not found/], ["auth", /API key/], ["rate_limit", /rate limit/], ["unavailable", /unavailable/]];
    const messages = { bad_model: 'Gemini model "x" was not found, or this API key has no access to it (HTTP 404).', auth: "Gemini rejected the API key (HTTP 403).", rate_limit: "Gemini rate limit or quota reached (HTTP 429).", unavailable: "Gemini is temporarily unavailable (HTTP 503)." };
    for (const [kind, re] of kinds) {
        const logs = [];
        const r = await extractProfile("nothing useful here", COUNTRIES, existing, { generate: mockGenerate(new GeminiError(kind, messages[kind])), config: KEY, log: (m) => logs.push(m) });
        assert.equal(r.extractor, "rules");
        assert.equal(r.llm_error.kind, kind);
        assert.match(r.note, re);
        assert.equal(r.profile.cgpa, 8.4);
        assert.equal(r.profile.degree, "BTech");
        assert.equal(logs.length, 1); // the cause is logged on the server, not swallowed
    }
});

test("extractProfile: without an API key the model is never called and the fallback is announced", async () => {
    const generate = mockGenerate(ok({}));
    const r = await extractProfile("BTech CSE with 8.4 CGPA", COUNTRIES, null, { generate, config: { ...KEY, apiKey: "" }, log: quiet });
    assert.equal(generate.calls.length, 0);
    assert.equal(r.extractor, "rules");
    assert.equal(r.llm_error.kind, "no_key");
    assert.match(r.note, /GEMINI_API_KEY/);
    assert.equal(r.profile.cgpa, 8.4);
});

test("extractProfile: an unexpected programming error in the LLM path also degrades to the fallback", async () => {
    const r = await extractProfile("IELTS 6.5", COUNTRIES, null, { generate: async () => { throw new TypeError("boom"); }, config: KEY, log: quiet });
    assert.equal(r.extractor, "rules");
    assert.equal(r.llm_error.kind, "unexpected");
    assert.deepEqual(r.profile.english, { test: "IELTS", score: 6.5 });
});

// ---------- Gemini client (mocked fetch) ----------
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const reply = (obj) => json(200, { candidates: [{ content: { parts: [{ text: typeof obj === "string" ? obj : JSON.stringify(obj) }] } }] });
const sequence = (...responses) => { const calls = []; const fn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body || "null"), headers: init.headers }); const r = responses[Math.min(calls.length - 1, responses.length - 1)]; return r instanceof Error ? Promise.reject(r) : r.clone(); }; fn.calls = calls; return fn; };
const base = { prompt: "p", system: "s", schema: { type: "object" }, config: KEY, sleep: async () => { } };

test("client: sends system instruction, JSON mime type, schema and the key header; parses the reply", async () => {
    const fetchImpl = sequence(reply({ a: 1 }));
    const out = await generateJson({ ...base, fetchImpl });
    assert.deepEqual(out.data, { a: 1 });
    const c = fetchImpl.calls[0];
    assert.equal(c.url, "http://mock/models/test-model:generateContent");
    assert.equal(c.headers["x-goog-api-key"], "test-key");
    assert.equal(c.body.systemInstruction.parts[0].text, "s");
    assert.equal(c.body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(c.body.generationConfig.responseJsonSchema, { type: "object" });
    assert.equal(c.body.generationConfig.temperature, 0);
});

test("client: tolerates a fenced JSON reply", async () => {
    const out = await generateJson({ ...base, fetchImpl: sequence(reply("```json\n{\"a\": 2}\n```")) });
    assert.deepEqual(out.data, { a: 2 });
});

test("client: HTTP 404 is a bad_model error that names the model and the fix, and is not retried", async () => {
    const fetchImpl = sequence(json(404, { error: { message: "models/test-model is not found for API version v1beta" } }));
    await assert.rejects(generateJson({ ...base, fetchImpl }), (e) => e instanceof GeminiError && e.kind === "bad_model" && /test-model/.test(e.message) && /GEMINI_MODEL/.test(e.message) && /check:gemini/.test(e.message));
    assert.equal(fetchImpl.calls.length, 1);
});

test("client: 401/403 and an invalid-key 400 are auth errors and are not retried", async () => {
    for (const res of [json(401, { error: { message: "x" } }), json(403, { error: { message: "x" } }), json(400, { error: { message: "API key not valid. Please pass a valid API key." } })]) {
        const fetchImpl = sequence(res);
        await assert.rejects(generateJson({ ...base, fetchImpl }), (e) => e.kind === "auth");
        assert.equal(fetchImpl.calls.length, 1);
    }
});

test("client: 429 and 5xx are retried and can recover; a persistent 429 ends as rate_limit", async () => {
    const recovered = sequence(json(429, { error: { message: "slow down" } }, { "retry-after": "1" }), json(503, {}), reply({ ok: true }));
    assert.deepEqual((await generateJson({ ...base, fetchImpl: recovered })).data, { ok: true });
    assert.equal(recovered.calls.length, 3);

    const stuck = sequence(json(429, { error: { message: "quota" } }));
    await assert.rejects(generateJson({ ...base, fetchImpl: stuck }), (e) => e.kind === "rate_limit" && e.status === 429);
    assert.equal(stuck.calls.length, 3); // 1 try + 2 retries
});

test("client: network failure and timeout become unavailable errors after retries", async () => {
    const down = sequence(new TypeError("fetch failed"));
    await assert.rejects(generateJson({ ...base, fetchImpl: down }), (e) => e.kind === "unavailable" && /fetch failed/.test(e.message));
    assert.equal(down.calls.length, 3);
    const slow = sequence(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await assert.rejects(generateJson({ ...base, fetchImpl: slow, retries: 0 }), (e) => e.kind === "unavailable" && /timed out/.test(e.message));
});

test("client: a malformed reply is retried once, then reported as malformed", async () => {
    const bad = sequence(reply("this is not json"));
    await assert.rejects(generateJson({ ...base, fetchImpl: bad }), (e) => e.kind === "malformed");
    assert.equal(bad.calls.length, 2);
    const healed = sequence(reply("nope"), reply({ ok: 1 }));
    assert.deepEqual((await generateJson({ ...base, fetchImpl: healed })).data, { ok: 1 });
});

test("client: an empty reply or a blocked prompt is malformed", async () => {
    await assert.rejects(generateJson({ ...base, fetchImpl: sequence(json(200, { candidates: [] })) }), (e) => e.kind === "malformed");
    await assert.rejects(generateJson({ ...base, fetchImpl: sequence(json(200, { promptFeedback: { blockReason: "SAFETY" } })) }), (e) => e.kind === "malformed" && /SAFETY/.test(e.message));
});

test("client: if the API rejects the response schema itself it retries once without it", async () => {
    const fetchImpl = sequence(json(400, { error: { message: "Invalid JSON payload received. Unknown name responseJsonSchema" } }), reply({ ok: 1 }));
    const out = await generateJson({ ...base, fetchImpl });
    assert.deepEqual(out.data, { ok: 1 });
    assert.ok(fetchImpl.calls[0].body.generationConfig.responseJsonSchema);
    assert.equal(fetchImpl.calls[1].body.generationConfig.responseJsonSchema, undefined);
});

test("client: another 400 is a bad_request and is not retried; a missing key fails before any request", async () => {
    const fetchImpl = sequence(json(400, { error: { message: "Request contains an invalid argument." } }));
    await assert.rejects(generateJson({ ...base, schema: null, fetchImpl }), (e) => e.kind === "bad_request");
    assert.equal(fetchImpl.calls.length, 1);
    const never = sequence(reply({}));
    await assert.rejects(generateJson({ ...base, config: { ...KEY, apiKey: "" }, fetchImpl: never }), (e) => e.kind === "no_key");
    assert.equal(never.calls.length, 0);
});

test("client: config reads the environment at call time, with a safe default model", () => {
    assert.equal(geminiConfig({}).model, DEFAULT_MODEL);
    assert.ok(!/^gemini-2\.5/.test(DEFAULT_MODEL));
    const c = geminiConfig({ GEMINI_API_KEY: " k ", GEMINI_MODEL: "m", GEMINI_BASE_URL: "http://x/" });
    assert.deepEqual(c, { apiKey: "k", model: "m", baseUrl: "http://x" });
});

test("client: listModels returns only generateContent models, following pages", async () => {
    const fetchImpl = sequence(
        json(200, { models: [{ name: "models/a", supportedGenerationMethods: ["generateContent"] }, { name: "models/emb", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "t2" }),
        json(200, { models: [{ name: "models/b", supportedGenerationMethods: ["generateContent", "countTokens"] }] }),
    );
    assert.deepEqual(await listModels({ config: KEY, fetchImpl }), ["a", "b"]);
    assert.match(fetchImpl.calls[1].url, /pageToken=t2/);
});