// Folds a validated extraction into the accumulated profile. Pure logic, no language understanding and no network.
// mergeProfile (engine/profile.js) does the actual merge; this only handles the counsellor's explicit corrections first.
import { mergeProfile } from "./profile.js";

const COUNTRY_BUCKETS = ["mandatory_countries", "preferred_countries", "acceptable_countries"];
const LIST_FIELDS = new Set(["goals"]);

const isBlank = (v) => v === null || v === undefined || v === false || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && !Object.keys(v).length);

/** How many fields an update really states (empty arrays, false and the extractor's default budget scope do not count). */
export function countStated(update = {}) {
    return Object.entries(update).filter(([k, v]) => !(k === "budget_scope" && v === "total") && !isBlank(v)).length;
}

/**
 * existing: the accumulated profile (normalized or raw); extraction: the validated output of understandMessage.
 * Fields named in extraction.corrections are cleared first so the new value REPLACES the old one (lists, countries, flags);
 * everything else only adds or overwrites. A message that states nothing returns the existing profile unchanged.
 */
export function applyExtraction(existing, extraction) {
    const base = { ...(existing || {}) };
    for (const field of extraction?.corrections || []) {
        if (field === "countries") for (const b of COUNTRY_BUCKETS) base[b] = [];
        else if (field === "docs_ready") base.docs_ready = {};
        else if (LIST_FIELDS.has(field)) base[field] = [];
        else base[field] = null;
    }
    return mergeProfile(base, extraction?.updates || {});
}