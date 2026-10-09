// Language understanding: turns ONE counsellor message into a validated, structured update.
// The model sees the current profile, the recent conversation (including the assistant's last question) and the field
// definitions. It returns JSON; everything it returns is validated here before anything else touches it.
// It never recommends, ranks or judges eligibility. Merging into the profile is engine/apply.js; ranking is engine/index.js.
import { GOALS } from "./goals.js";
import { uniq } from "./util.js";
import { generateJson } from "./llm/gemini.js";

export class ExtractionError extends Error {
    constructor(message) {
        super(message);
        this.name = "ExtractionError";
        this.kind = "malformed";
    }
}

export const DOC_TYPES = ["SOP", "LOR", "RESUME", "TRANSCRIPT", "DEGREE_CERTIFICATE", "PASSPORT"];
export const COUNTRY_KEYS = ["mandatory_countries", "preferred_countries", "acceptable_countries"];
// Fields the counsellor can explicitly change. "countries" means all three country buckets.
export const CORRECTABLE = [
    "degree", "field_of_study", "cgpa", "percentage", "english", "gre", "gmat", "work_exp_months", "goals", "research", "budget_inr",
    "budget_scope", "countries", "intake_year", "intake_month", "wants_scholarships", "nationality", "category", "gender", "state",
    "family_income_inr", "docs_ready",
];
// The labels normalizeProfile puts in profile.missing. The model may name one of these as "unavailable" (see SYSTEM_PROMPT).
export const MISSING_ITEMS = ["degree / background", "CGPA / percentage", "English test score", "career goal", "budget"];
// Preferences the counsellor can explicitly leave open ("any country is fine", "intake is flexible"). Not mentioning them is a different state.
export const FLEXIBLE_ITEMS = ["country preference", "intake"];
// IELTS scores come in halves; TOEFL iBT and PTE totals are whole numbers.
const ENGLISH_RANGE = { IELTS: [0, 9], TOEFL: [0, 120], PTE: [10, 90] };
const ENGLISH_WHOLE = ["TOEFL", "PTE"];

// ---------- validation ----------
const str = (v, max = 80) => {
    if (typeof v !== "string") return null;
    const s = v.trim();
    return s && s.length <= max ? s : null;
};
const numIn = (v, min, max, { int = false, minExclusive = false } = {}) => {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    if (!Number.isFinite(n) || (minExclusive ? n <= min : n < min) || n > max || (int && !Number.isInteger(n))) return null;
    return n;
};
const isEmpty = (v) => v === null || v === undefined || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0);

const SCALARS = {
    degree: (v) => str(v, 40),
    field_of_study: (v) => str(v, 80),
    nationality: (v) => str(v, 40),
    state: (v) => str(v, 40),
    cgpa: (v) => numIn(v, 0, 10, { minExclusive: true }),
    percentage: (v) => numIn(v, 0, 100, { minExclusive: true }),
    gre: (v) => numIn(v, 260, 340),
    gmat: (v) => numIn(v, 200, 800),
    work_exp_months: (v) => numIn(v, 0, 600),
    budget_inr: (v) => numIn(v, 0, 1e10, { minExclusive: true }),
    family_income_inr: (v) => numIn(v, 0, 1e10),
    intake_year: (v) => numIn(v, 2026, 2032, { int: true }),
    intake_month: (v) => numIn(v, 1, 12, { int: true }),
    budget_scope: (v) => (v === "total" || v === "tuition_only" ? v : null),
    category: (v) => {
        const s = str(v, 10)?.toUpperCase();
        if (!s) return null;
        if (s === "GENERAL" || s === "OPEN") return "General";
        return ["SC", "ST", "OBC", "EWS"].includes(s) ? s : null;
    },
    gender: (v) => {
        const s = str(v, 10)?.toLowerCase();
        return s === "male" || s === "female" ? s : null;
    },
};
const BOOLEANS = ["research", "wants_scholarships"];

// Plain-language scale of each numeric field, used to ask a precise question when a stated number does not fit its scale.
const SCALE = {
    cgpa: ["the CGPA", "0 to 10"], percentage: ["the percentage", "0 to 100"], gre: ["the GRE score", "260 to 340"], gmat: ["the GMAT score", "200 to 800"],
    intake_year: ["the intake year", "2026 to 2032"],
};

function sanitizeUpdates(raw, countrySlugs) {
    const updates = {};
    const rejected = [];
    const invalid = []; // numbers that were stated but do not fit their scale: asked about instead of silently dropped
    const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
    const keepList = (key, value, allowed) => {
        const list = Array.isArray(value) ? uniq(value.filter((x) => typeof x === "string" && allowed(x))) : [];
        if (list.length) updates[key] = list; else rejected.push(key);
    };
    for (const [key, value] of Object.entries(src)) {
        if (isEmpty(value)) continue;
        if (SCALARS[key]) {
            const v = SCALARS[key](value);
            if (v == null) {
                rejected.push(key);
                if (SCALE[key] && Number.isFinite(Number(value))) invalid.push({ field: key, issue: `${value} is outside ${SCALE[key][1]}`, question: `${value} doesn't fit ${SCALE[key][0]} (it should be ${SCALE[key][1]}). What should I record?` });
            } else updates[key] = v;
        } else if (key === "english") {
            const test = value && typeof value === "object" ? str(value.test, 10)?.toUpperCase() : null;
            const range = ENGLISH_RANGE[test];
            const score = range ? numIn(value.score, range[0], range[1], { int: ENGLISH_WHOLE.includes(test) }) : null;
            if (score == null) {
                rejected.push(key);
                if (range && Number.isFinite(Number(value.score))) {
                    const whole = ENGLISH_WHOLE.includes(test) ? ", in whole numbers" : "";
                    invalid.push({ field: "english", issue: `${test} ${value.score} is outside ${range[0]} to ${range[1]}`, question: `${test} scores run from ${range[0]} to ${range[1]}${whole}, so ${value.score} doesn't fit. Which test did the student take and what was the score?` });
                }
            } else updates.english = { test, score };
        } else if (BOOLEANS.includes(key)) {
            if (typeof value === "boolean") updates[key] = value; else rejected.push(key);
        } else if (key === "goals") {
            keepList(key, value, (g) => Boolean(GOALS[g]));
        } else if (COUNTRY_KEYS.includes(key)) {
            keepList(key, value, (c) => countrySlugs.includes(c));
        } else if (key === "docs_ready") {
            const docs = Array.isArray(value) ? uniq(value.filter((d) => DOC_TYPES.includes(d))) : [];
            if (docs.length) updates.docs_ready = Object.fromEntries(docs.map((d) => [d, true])); else rejected.push(key);
        } else {
            rejected.push(key); // a field that is not in the profile schema
        }
    }
    return { updates, rejected, invalid };
}

/**
 * Validates the model's JSON and returns { updates, corrections, ambiguities, has_new_info, summary, rejected }.
 * `updates` is in the raw profile shape that normalizeProfile / mergeProfile accept. Anything invalid is dropped, never repaired by guessing.
 * Throws ExtractionError when the payload is not usable at all.
 */
export function validateExtraction(data, countrySlugs) {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ExtractionError("The model reply is not a JSON object.");
    if (!data.updates || typeof data.updates !== "object" || Array.isArray(data.updates)) throw new ExtractionError("The model reply has no 'updates' object.");

    const { updates, rejected, invalid } = sanitizeUpdates(data.updates, countrySlugs);
    const corrections = uniq((Array.isArray(data.corrections) ? data.corrections : []).filter((f) => CORRECTABLE.includes(f)));
    const ambiguities = (Array.isArray(data.ambiguities) ? data.ambiguities : [])
        .map((a) => ({ field: str(a?.field, 40) || "unknown", issue: str(a?.issue, 200) || "", question: str(a?.question, 200) }))
        .filter((a) => a.question);
    ambiguities.push(...invalid.filter((i) => !ambiguities.some((a) => a.field === i.field))); // a value that cannot be right is queried, never guessed
    ambiguities.splice(2);
    // Items the counsellor said do not exist yet / are not known. Only labels from MISSING_ITEMS survive; the item is not "stated", just closed.
    const unavailable = uniq((Array.isArray(data.unavailable) ? data.unavailable : []).filter((x) => MISSING_ITEMS.includes(x)));
    const flexible = uniq((Array.isArray(data.flexible) ? data.flexible : []).filter((x) => FLEXIBLE_ITEMS.includes(x)));
    return {
        updates,
        corrections,
        ambiguities,
        unavailable,
        flexible,
        has_new_info: Object.keys(updates).length > 0 || corrections.length > 0, // computed from what survived validation, not taken on trust
        summary: str(data.summary, 200) || "",
        rejected,
    };
}

// ---------- schema sent to Gemini (validation above still runs on whatever comes back) ----------
export function buildSchema(countrySlugs) {
    const nullable = (type) => ({ type: [type, "null"] });
    const countries = { type: "array", items: { type: "string", enum: countrySlugs } };
    return {
        type: "object",
        properties: {
            updates: {
                type: "object",
                properties: {
                    degree: nullable("string"), field_of_study: nullable("string"),
                    cgpa: nullable("number"), percentage: nullable("number"),
                    english: { type: ["object", "null"], properties: { test: { type: "string", enum: Object.keys(ENGLISH_RANGE) }, score: { type: "number" } }, required: ["test", "score"] },
                    gre: nullable("number"), gmat: nullable("number"), work_exp_months: nullable("number"),
                    goals: { type: "array", items: { type: "string", enum: Object.keys(GOALS) } },
                    research: nullable("boolean"), budget_inr: nullable("number"), budget_scope: nullable("string"),
                    mandatory_countries: countries, preferred_countries: countries, acceptable_countries: countries,
                    intake_year: nullable("integer"), intake_month: nullable("integer"),
                    wants_scholarships: nullable("boolean"), nationality: nullable("string"), category: nullable("string"),
                    gender: nullable("string"), state: nullable("string"), family_income_inr: nullable("number"),
                    docs_ready: { type: "array", items: { type: "string", enum: DOC_TYPES } },
                },
            },
            corrections: { type: "array", items: { type: "string", enum: CORRECTABLE } },
            ambiguities: {
                type: "array",
                items: { type: "object", properties: { field: { type: "string" }, issue: { type: "string" }, question: { type: "string" } }, required: ["field", "issue", "question"] },
            },
            unavailable: { type: "array", items: { type: "string", enum: MISSING_ITEMS } },
            flexible: { type: "array", items: { type: "string", enum: FLEXIBLE_ITEMS } },
            has_new_info: { type: "boolean" },
            summary: { type: "string" },
        },
        required: ["updates", "corrections", "ambiguities", "has_new_info", "summary"],
    };
}

// ---------- prompt ----------
export const SYSTEM_PROMPT = `You are the language-understanding step of a study-abroad counselling assistant that a human counsellor uses live.
The counsellor types notes about a student in any style: full sentences, fragments, abbreviations, or short replies to a question the assistant asked.
Your only job is to turn the latest counsellor message into structured updates to the student's profile. You never recommend, rank, filter, or judge the eligibility of courses or countries.

How to read the input
- KNOWN PROFILE is what is already recorded. Do not repeat a value unless the latest message states it again or changes it.
- CONVERSATION holds the earlier turns. When ASSISTANT'S MOST RECENT QUESTION is present, the latest message is probably an answer to it: use the question to decide what a short or unlabelled reply refers to. The counsellor may also ignore the question or answer several things at once; extract what the message actually says.
- Extract only facts about the student that the latest message states or unambiguously implies. Never guess, never fill gaps from general knowledge, never invent values. A fact that is not stated is omitted.
- Keep numbers apart by meaning: academic grade (cgpa or percentage), English test score, GRE or GMAT score, money, durations, and years.
- Country intent is a matter of meaning: a hard requirement, a favoured option, or merely acceptable. A negated requirement is not a requirement.
- Corrections: when the counsellor explicitly changes something recorded earlier, put the new value in updates and name the field in corrections. Naming "countries" or "goals" in corrections means the updates for those fields replace the whole recorded set instead of adding to it.
- Ambiguity: if a statement could reasonably mean two different things and choosing one would materially change the profile, leave it out of updates and add an ambiguities entry with the field, a short issue, and one short question the assistant can ask the counsellor to resolve it.
- Read the WHOLE message, not just the part that answers the assistant's question. The counsellor may give several facts at once, including ones nobody asked for; extract every one of them.
- Unavailable: STILL MISSING lists what the profile still lacks. Name an item in "unavailable" only when the counsellor says it does not exist yet, is not decided, or is not known, so asking again would not help. An item that is simply not mentioned is NOT unavailable. Never put an item in both updates and unavailable.
- Flexible: OPEN PREFERENCES lists preferences that are not recorded yet. Name one in "flexible" only when the counsellor explicitly says it does not matter (every supported country is acceptable / no country preference; the intake timing is flexible or any). Use the assistant's most recent question to read a short reply such as "no" or "any". A preference that is merely not mentioned is NOT flexible. If the counsellor names a country or an intake, put that in updates instead.
- has_new_info is true only when updates or corrections are not empty. summary is one short plain sentence about what was learned.
Return only the JSON object.`;

const compactNumber = (n) => (Number.isInteger(n) ? n : Number(n.toFixed(2)));

/** The facts actually stated so far: derived values (CGPA→%) and defaults are left out so the model does not treat them as stated. */
export function knownFacts(profile) {
    if (!profile || typeof profile !== "object") return {};
    const out = {};
    for (const [k, v] of Object.entries(profile)) {
        if (["missing", "percentage_source"].includes(k)) continue;
        if (k === "percentage" && profile.percentage_source && profile.percentage_source !== "stated") continue;
        if (k === "nationality" && v === "India") continue;
        if (k === "budget_scope" && v !== "tuition_only") continue;
        if (isEmpty(v) || v === false || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length)) continue;
        out[k] = typeof v === "number" ? compactNumber(v) : v;
    }
    return out;
}

/** Preferences with no recorded value: no country in any bucket, no intake year or month. */
export function openPreferences(profile) {
    const p = profile && typeof profile === "object" ? profile : {};
    const open = [];
    if (!COUNTRY_KEYS.some((k) => Array.isArray(p[k]) && p[k].length)) open.push("country preference");
    if (p.intake_year == null && p.intake_month == null) open.push("intake");
    return open;
}

export function buildPrompt({ text, profile, history = [], countries, today }) {
    const slugs = countries.map((c) => c.country_slug);
    const turns = (Array.isArray(history) ? history : []).slice(-8).filter((t) => t && typeof t.text === "string");
    const convo = turns.length ? turns.map((t) => `${t.role === "assistant" ? "Assistant" : "Counsellor"}: ${t.text.slice(0, 500)}`).join("\n") : "(no earlier turns)";
    const lastTurn = turns[turns.length - 1];
    const question = lastTurn?.role === "assistant" ? lastTurn.text.slice(0, 500) : "(none)";
    const goals = Object.entries(GOALS).map(([id, g]) => `${id} (${g.label})`).join("; ");
    return `TODAY: ${today}

FIELDS (include only those the latest message states; omit all others):
- degree: bachelor's degree type as stated.  field_of_study: branch or major.
- cgpa: undergraduate CGPA on a 10-point scale.  percentage: undergraduate percentage 0-100, only when a percentage rather than a CGPA is given.
- english: { test: IELTS | TOEFL | PTE, score }.  gre, gmat: scores.  work_exp_months: total work experience in months.
- goals: career or study directions; allowed ids: ${goals}.  research: true when a research-oriented programme is wanted.
- budget_inr: total budget in whole rupees (1 lakh = 100000, 1 crore = 10000000).  budget_scope: "total" when the message says the budget covers tuition and living costs, "tuition_only" when it says living costs are excluded; omit it when the message does not say.
- mandatory_countries / preferred_countries / acceptable_countries: hard requirement / favoured but not limited to / merely open to. Allowed slugs: ${slugs.join(", ")}.
- intake_year: 4-digit year.  intake_month: 1-12.
- wants_scholarships, category (SC | ST | OBC | EWS | General), gender (male | female), state (Indian home state), family_income_inr (annual, rupees), nationality, docs_ready (any of: ${DOC_TYPES.join(", ")}).

KNOWN PROFILE:
${JSON.stringify(knownFacts(profile))}

STILL MISSING (important items the profile lacks; may be empty): ${(Array.isArray(profile?.missing) ? profile.missing : []).filter((m) => MISSING_ITEMS.includes(m)).join("; ") || "(none)"}
OPEN PREFERENCES (not recorded yet; may be empty): ${openPreferences(profile).join("; ") || "(none)"}

CONVERSATION (oldest first):
${convo}

ASSISTANT'S MOST RECENT QUESTION: ${question}

LATEST COUNSELLOR MESSAGE:
"""${text}"""`;
}

/** Runs the model on one message and returns { extraction, model }. Throws GeminiError (transport) or ExtractionError (unusable reply). */
export async function understandMessage({ text, profile, history = [], countries, today, generate = generateJson, config }) {
    const slugs = countries.map((c) => c.country_slug);
    const { data, model } = await generate({ system: SYSTEM_PROMPT, prompt: buildPrompt({ text, profile, history, countries, today }), schema: buildSchema(slugs), config });
    return { extraction: validateExtraction(data, slugs), model };
}