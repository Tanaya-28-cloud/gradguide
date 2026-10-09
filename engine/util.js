export const clamp = (x, a = 0, b = 100) => Math.min(b, Math.max(a, x));
export const r1 = (x) => Math.round(x * 10) / 10;
/** INR -> lakh, 2 decimals */
export const lakh = (inr) => (inr == null ? null : Math.round(inr / 1000) / 100);
export const fmtL = (inr) => (inr == null ? "unknown" : `₹${lakh(inr)}L`);
export function parseJson(s) { try { return JSON.parse(s); } catch { return s; } }
export const todayIso = () => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
export const daysBetween = (fromIso, toIso) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 86400000);
export const uniq = (a) => [...new Set(a)];
