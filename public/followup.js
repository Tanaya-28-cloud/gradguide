// Follow-up question selection. Pure logic (no DOM, no network), so it can be tested in Node.
// Completion is decided HERE from the accumulated profile, never by the language model saying "I have enough".
//
// An item is asked about while it is open, i.e. it has no value AND the counsellor has not resolved it:
//   - "unavailable": the counsellor said it does not exist / is not known (e.g. no English test yet)
//   - "flexible":    the counsellor explicitly said any country / any intake is fine
// Not mentioning a country or intake is NOT the same as saying it is flexible, so those stay open until one of the two happens.
// Optional details (GRE/GMAT, scholarships, gender, category, documents ...) are never asked here, so they never block confirmation.
// Priority is the order of the keys below. Each item is asked at most `max` times, so a counsellor who ignores a question cannot be stuck in a loop.

const bgLabel = (p) => [p.degree, p.field_of_study].filter(Boolean).join(" ");
const lakh = (inr) => `₹${Number((inr / 1e5).toFixed(2))} lakh`;

export const ASK = {
    "degree / background": {
        max: 2, what: "degree and branch",
        open: (p, c) => p.missing.includes("degree / background") && !c.unavailable["degree / background"],
        text: (p, n) => n ? "Sorry, I couldn't pick that up. Which degree and branch did the student complete?" : "Which degree and branch is the student coming from?",
    },
    "CGPA / percentage": {
        max: 2, what: "CGPA or percentage",
        open: (p, c) => p.missing.includes("CGPA / percentage") && !c.unavailable["CGPA / percentage"],
        text: (p, n) => n ? "Sorry, I still don't have the grades. What was the student's CGPA or percentage?" : (bgLabel(p) ? `What was the student's CGPA or percentage in their ${bgLabel(p)}?` : "What is the student's CGPA or percentage?"),
    },
    "English test score": {
        max: 2, what: "English test and score (or that none has been taken yet)",
        open: (p, c) => p.missing.includes("English test score") && !c.unavailable["English test score"],
        text: (p, n) => n ? "Sorry, I couldn't find the English score. Which test did the student take (IELTS, TOEFL or PTE) and what was the score?" : "Has the student taken an English test yet — IELTS, TOEFL or PTE? If so, what was the score?",
    },
    "career goal": {
        max: 2, what: "career direction",
        open: (p, c) => p.missing.includes("career goal") && !c.unavailable["career goal"],
        text: (p, n) => n ? "Sorry, I couldn't tell the direction. Is the student aiming for AI/ML, data science, cybersecurity, cloud/DevOps or software engineering?" : "What does the student want to specialise in or move into — for example AI/ML, data science, cybersecurity, cloud/DevOps or software engineering?",
    },
    "budget": {
        max: 2, what: "budget",
        open: (p, c) => p.missing.includes("budget") && !c.unavailable["budget"],
        text: (p, n) => n ? "Sorry, I didn't get a figure. Roughly how much can the family spend in total, in ₹ lakh?" : "What is the student's approximate budget for the complete master's programme?",
    },
    // A budget figure alone does not say what it covers; the profile defaults to "total", so we track whether the counsellor actually stated it.
    "budget scope": {
        max: 2, what: "whether the budget includes living costs",
        open: (p, c) => p.budget_inr != null && !c.stated.budget_scope,
        text: (p, n) => n ? "Sorry, I didn't catch that. Should I treat the budget as covering tuition plus living costs, or tuition only?" : `Does the ${lakh(p.budget_inr)} budget cover tuition and living costs together, or tuition only?`,
    },
    "country preference": {
        max: 2, what: "country preference (or that any country is fine)",
        open: (p, c) => !(p.mandatory_countries.length || p.preferred_countries.length || p.acceptable_countries.length) && !c.flexible["country preference"],
        text: (p, n) => n ? "Sorry, I didn't catch that. Does the student have a preferred country, or should I consider all supported countries?" : "Does the student have a preferred country, or should I consider all supported countries?",
    },
    "intake": {
        max: 2, what: "intake (or that it is flexible)",
        open: (p, c) => p.intake_year == null && p.intake_month == null && !c.flexible["intake"],
        text: (p, n) => n ? "Sorry, I didn't catch that. Which intake is the student targeting, for example September 2027, or is the intake flexible?" : "Which intake is the student targeting — for example September 2027? Or is the intake flexible?",
    },
};

const joinList = (a) => (a.length < 2 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`);

/**
 * profile: the normalized profile. ctx: { asked, unavailable, flexible, stated } (all plain objects keyed by item label / field name).
 * Returns the single most important question still worth asking as { key, text }, or null when nothing important is left.
 * When several items are open the question is about the top one and says the others can be added in the same reply.
 */
export function nextQuestion(profile, ctx = {}) {
    const c = { asked: ctx.asked || {}, unavailable: ctx.unavailable || {}, flexible: ctx.flexible || {}, stated: ctx.stated || {} };
    const open = Object.keys(ASK).filter((label) => ASK[label].open(profile, c) && (c.asked[label] || 0) < ASK[label].max);
    if (!open.length) return null;
    const [label, ...rest] = open;
    const tail = rest.length ? ` If you have them, you can add the ${joinList(rest.map((l) => ASK[l].what))} in the same reply.` : "";
    return { key: label, text: ASK[label].text(profile, c.asked[label] || 0) + tail };
}