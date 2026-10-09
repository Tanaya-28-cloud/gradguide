// Thin Gemini client. One job: send a prompt, get parsed JSON back, and fail with an error that says WHY.
// It knows nothing about students or profiles (that lives in engine/understand.js).

// gemini-2.5-* models are restricted to keys that already used them, which shows up as HTTP 404 for new keys.
// Override with GEMINI_MODEL; `npm run check:gemini` lists the models your key can actually use.
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** kind: no_key | bad_model (404) | auth (401/403) | bad_request (400) | rate_limit (429) | unavailable (5xx / network / timeout) | malformed (unusable response) */
export class GeminiError extends Error {
    constructor(kind, message, { status = null, retryable = false, retryAfterMs = null } = {}) {
        super(message);
        this.name = "GeminiError";
        this.kind = kind;
        this.status = status;
        this.retryable = retryable;
        this.retryAfterMs = retryAfterMs;
    }
}

/** Read at call time so a changed .env / environment is picked up without code changes. */
export function geminiConfig(env = process.env) {
    return {
        apiKey: (env.GEMINI_API_KEY || "").trim(),
        model: (env.GEMINI_MODEL || "").trim() || DEFAULT_MODEL,
        baseUrl: ((env.GEMINI_BASE_URL || "").trim() || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    };
}

function httpError(status, payload, model, retryAfterHeader) {
    const detail = payload?.error?.message ? ` (${String(payload.error.message).replace(/\s+/g, " ").slice(0, 200)})` : "";
    const seconds = Number(retryAfterHeader);
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
    if (status === 404) return new GeminiError("bad_model", `Gemini model "${model}" was not found, or this API key has no access to it (HTTP 404)${detail}. Set GEMINI_MODEL in .env to a model your key can use; run "npm run check:gemini" to list them.`, { status });
    if (status === 401 || status === 403 || (status === 400 && /api key/i.test(detail))) return new GeminiError("auth", `Gemini rejected the API key or its permissions (HTTP ${status})${detail}. Check GEMINI_API_KEY in .env.`, { status });
    if (status === 429) return new GeminiError("rate_limit", `Gemini rate limit or quota reached (HTTP 429)${detail}.`, { status, retryable: true, retryAfterMs });
    if (status >= 500) return new GeminiError("unavailable", `Gemini is temporarily unavailable (HTTP ${status})${detail}.`, { status, retryable: true, retryAfterMs });
    return new GeminiError("bad_request", `Gemini rejected the request (HTTP ${status})${detail}.`, { status });
}

async function send(url, init, { fetchImpl, timeoutMs, model }) {
    let res;
    try {
        res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        const why = e?.name === "TimeoutError" || e?.name === "AbortError" ? `timed out after ${Math.round(timeoutMs / 1000)}s` : e?.message || "network error";
        throw new GeminiError("unavailable", `Could not reach Gemini (${why}).`, { retryable: true });
    }
    const payload = await res.json().catch(() => null);
    if (!res.ok) throw httpError(res.status, payload, model, res.headers?.get?.("retry-after"));
    return payload;
}

const stripFence = (t) => t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

async function callOnce({ system, prompt, schema, config, fetchImpl, timeoutMs }) {
    const body = {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (schema) body.generationConfig.responseJsonSchema = schema;

    const payload = await send(
        `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`,
        { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": config.apiKey }, body: JSON.stringify(body) },
        { fetchImpl, timeoutMs, model: config.model },
    );

    if (payload?.promptFeedback?.blockReason) throw new GeminiError("malformed", `Gemini blocked the request (${payload.promptFeedback.blockReason}).`);
    const text = (payload?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || "").join("").trim();
    if (!text) throw new GeminiError("malformed", "Gemini returned an empty response.", { retryable: true });
    try {
        return { data: JSON.parse(stripFence(text)), model: config.model };
    } catch {
        throw new GeminiError("malformed", "Gemini returned text that is not valid JSON.", { retryable: true });
    }
}

/**
 * Calls generateContent and returns { data, model } with `data` parsed from the JSON reply.
 * - Transient failures (429, 5xx, network, timeout) are retried with backoff; permanent ones (404, 401/403, other 4xx) are thrown at once.
 * - If the API rejects the response schema itself (HTTP 400), it retries once without the schema; the caller still validates the result.
 * - A malformed reply is retried once.
 */
export async function generateJson({
    system, prompt, schema, config = geminiConfig(), fetchImpl = globalThis.fetch, timeoutMs = 20000, retries = 2,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
    if (!config.apiKey) throw new GeminiError("no_key", "GEMINI_API_KEY is not set.");
    let useSchema = Boolean(schema);
    for (let attempt = 0; ; attempt++) {
        try {
            return await callOnce({ system, prompt, schema: useSchema ? schema : null, config, fetchImpl, timeoutMs });
        } catch (e) {
            if (!(e instanceof GeminiError)) throw e;
            if (e.kind === "bad_request" && useSchema && /schema|json|mime/i.test(e.message) && attempt < retries) { useSchema = false; continue; }
            if (!e.retryable || attempt >= retries || (e.kind === "malformed" && attempt >= 1)) throw e;
            await sleep(Math.min(e.retryAfterMs ?? 500 * 2 ** attempt, 4000));
        }
    }
}

/** Model IDs this key can call with generateContent (used by `npm run check:gemini`). */
export async function listModels({ config = geminiConfig(), fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    if (!config.apiKey) throw new GeminiError("no_key", "GEMINI_API_KEY is not set.");
    const names = [];
    let pageToken = "";
    for (let page = 0; page < 5; page++) {
        const url = `${config.baseUrl}/models?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
        const payload = await send(url, { headers: { "x-goog-api-key": config.apiKey } }, { fetchImpl, timeoutMs, model: config.model });
        for (const m of payload?.models || []) if ((m.supportedGenerationMethods || []).includes("generateContent")) names.push(String(m.name).replace(/^models\//, ""));
        pageToken = payload?.nextPageToken || "";
        if (!pageToken) break;
    }
    return names;
}