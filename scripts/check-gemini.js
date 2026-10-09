// Diagnoses the Gemini setup: is the key set, which models can this key call, does the configured model work?
// Run with: npm run check:gemini
import { geminiConfig, generateJson, listModels } from "../engine/llm/gemini.js";

const config = geminiConfig();
console.log(`Configured model: ${config.model}  (set GEMINI_MODEL in .env to change it)`);
if (!config.apiKey) {
    console.log("GEMINI_API_KEY is not set, so the app would use the rule-based fallback. Add it to .env.");
    process.exit(1);
}

try {
    const names = await listModels({ config });
    const preferred = names.filter((n) => /flash|pro/i.test(n) && !/image|tts|live|audio|embed|transcribe/i.test(n));
    console.log(`\nModels this key can call with generateContent (${names.length} total). Text models:`);
    for (const n of preferred.slice(0, 40)) console.log(`  ${n}${n === config.model ? "   <- configured" : ""}`);
    console.log(names.includes(config.model) ? "\nOK: the configured model is available to this key." : `\nPROBLEM: "${config.model}" is not in this key's model list. Set GEMINI_MODEL to one of the models above.`);
} catch (e) {
    console.log(`\nCould not list models [${e.kind || "error"}]: ${e.message}`);
}

try {
    const { data } = await generateJson({ prompt: 'Reply with the JSON object {"ok": true}.', schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, config, retries: 1 });
    console.log(`\nTest call: OK ${JSON.stringify(data)}`);
} catch (e) {
    console.log(`\nTest call FAILED [${e.kind || "error"}]: ${e.message}`);
    process.exitCode = 1;
}