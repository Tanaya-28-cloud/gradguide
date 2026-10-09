import { nextQuestion } from "./followup.js";

const app = document.getElementById("app");
const $ = (sel) => app.querySelector(sel);
const $$ = (sel) => [...app.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const L = (v) => (v == null ? "—" : `₹${v}L`);
const api = async (url, body) => {
  const res = await fetch(url, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || res.statusText);
  return json;
};

const state = { meta: null, profile: null, turns: [], asked: {}, unavailable: {}, flexible: {}, stated: {}, countryState: {}, rec: null };
const DOCS = ["SOP", "LOR", "RESUME", "TRANSCRIPT", "DEGREE_CERTIFICATE", "PASSPORT"];
let defaultPlaceholder = "";
let activeSession = null;
const savedSessionKey = "gradguide.activeSessionId";

async function init() {
  bindSessionFlow();
  state.meta = await api("/api/meta");
  defaultPlaceholder = $("#notes").placeholder;

  const notes = $("#notes");
  const notesCount = $("#notes-count");

  function updateNotesCount() {
    notesCount.textContent = `${notes.value.length} / 4000`;
  }

  notes.addEventListener("input", updateNotesCount);
  updateNotesCount();

  $("#llm-badge").textContent = state.meta.llm ? `Gemini extraction on (${state.meta.llm_model})` : "Rule-based fallback (add GEMINI_API_KEY for LLM)";
  // const sel = $("#demo-select");
  // for (const s of state.meta.demo_students) sel.insertAdjacentHTML("beforeend", `<option value="${esc(s.student_slug)}">${esc(s.student_slug)}</option>`);
  // sel.addEventListener("change", () => {
  //   const s = state.meta.demo_students.find((d) => d.student_slug === sel.value);
  //   if (s) $("#notes").value = s.raw_input;
  // });
  $("#btn-extract").addEventListener("click", extract);
  $("#btn-recommend").addEventListener("click", recommend);
  $("#profile-form").addEventListener("submit", (e) => { e.preventDefault(); recommend(); });
  $("#btn-pip").addEventListener("click", popOut);
  $("#btn-search").addEventListener("click", search);
  $("#q").addEventListener("keydown", (e) => e.key === "Enter" && search());
  $$(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  app.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip[data-country]");
    if (chip) cycleCountry(chip);
    const more = e.target.closest("[data-more]");
    if (more) { $(`#${more.dataset.more}`).classList.toggle("hidden"); }
  });
  showDashboard();
  await restoreSavedSession();
}

function bindSessionFlow() {
  $("#btn-start-session").addEventListener("click", showStudentForm);
  $("#btn-cancel-form").addEventListener("click", (e) => { e.preventDefault(); showDashboard(); });
  $("#btn-cancel-form-bottom").addEventListener("click", showDashboard);
  $("#student-form").addEventListener("submit", createStudentSession);
  $("#btn-reset").addEventListener("click", endCurrentSession);
}

function showDashboard() {
  $("#dashboard").classList.remove("hidden");
  $("#student-form-panel").classList.add("hidden");
  $("#chatbot-shell").classList.add("hidden");
  $("#btn-reset").classList.add("hidden");
  $("#btn-pip").classList.add("hidden");
  $("#student-form-message").textContent = "";
}

function showStudentForm() {
  $("#dashboard").classList.add("hidden");
  $("#chatbot-shell").classList.add("hidden");
  $("#student-form-panel").classList.remove("hidden");
  $("#btn-reset").classList.add("hidden");
  $("#btn-pip").classList.add("hidden");
  $("#student-form-message").textContent = "";
  $("#student-form").reset();
  $("#firstName").focus();
}

async function createStudentSession(e) {
  e.preventDefault();
  const form = $("#student-form");
  const button = $("#btn-create-student");
  const message = $("#student-form-message");
  if (!form.reportValidity()) return;
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const key of Object.keys(payload)) payload[key] = String(payload[key] || "").trim();
  button.disabled = true;
  button.textContent = "Creating profile…";
  message.textContent = "";
  try {
    const result = await api("/api/sessions", payload);
    activeSession = result;
    sessionStorage.setItem(savedSessionKey, result.session.id);
    resetChatbotState();
    showChatbot(result);
  } catch (error) {
    message.textContent = error.message || "Could not create the student profile.";
  } finally {
    button.disabled = false;
    button.textContent = "Create Profile & Continue →";
  }
}

async function restoreSavedSession() {
  const id = sessionStorage.getItem(savedSessionKey);
  if (!id) return false;
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(id)}`);
    activeSession = result;
    showChatbot(result);
    return true;
  } catch {
    sessionStorage.removeItem(savedSessionKey);
    return false;
  }
}

function showChatbot(result) {
  $("#dashboard").classList.add("hidden");
  $("#student-form-panel").classList.add("hidden");
  $("#chatbot-shell").classList.remove("hidden");
  $("#btn-reset").classList.remove("hidden");
  $("#btn-pip").classList.remove("hidden");
  const student = result.student;
  $("#active-student").innerHTML = `<div><span class="eyebrow">ACTIVE COUNSELLING SESSION</span><b>${esc(student.firstName)} ${esc(student.lastName)}</b><span class="muted small">${esc(student.college)} · ${esc(student.email)} · ${esc(student.phone)}</span></div><span class="session-badge">Session active</span>`;
}

function resetChatbotState() {
  state.profile = null; state.turns = []; state.asked = {}; state.unavailable = {}; state.flexible = {}; state.stated = {}; state.rec = null; state.countryState = {};
  renderTurns();
  $("#notes").value = "";
  $("#notes").placeholder = defaultPlaceholder;
  $("#extract-msg").textContent = "";
  $("#profile-form").innerHTML = "";
  $("#tab-recs").innerHTML = "";
  $("#tab-plan").innerHTML = "";
  $("#search-out").innerHTML = "";
  $("#q").value = "";
  ["#step-confirm", "#results"].forEach((s) => $(s).classList.add("hidden"));
  $("#step-input").classList.remove("hidden");
}

function endCurrentSession() {
  sessionStorage.removeItem(savedSessionKey);
  activeSession = null;
  resetChatbotState();
  showDashboard();
}

function reset() {
  state.profile = null; state.turns = []; state.asked = {}; state.unavailable = {}; state.flexible = {}; state.stated = {}; state.rec = null; state.countryState = {};
  renderTurns();
  $("#notes").value = ""; $("#notes").placeholder = defaultPlaceholder; $("#extract-msg").textContent = "";
  ["#step-confirm", "#results"].forEach((s) => $(s).classList.add("hidden"));
}

// Conversation history: counsellor messages and the assistant's follow-up questions stay visible.

function renderTurns() {
  let n = 0;

  $("#turns").innerHTML = state.turns.map((t) =>
    t.role === "assistant"
      ? `<div class="followup-question">
           <b>GradGuide · Follow-up question</b><br>
           ${esc(t.text)}
         </div>`
      : `<div class="counsellor-note">
           <b>Counsellor · Turn ${++n}</b><br>
           ${esc(t.text)}
         </div>`
  ).join("");

  const panel = $("#followup-panel");
  panel.classList.toggle("hidden", state.turns.length === 0);
}


async function extract() {
  const text = $("#notes").value.trim();
  if (!text) return;
  const btn = $("#btn-extract");
  btn.disabled = true; $("#extract-msg").textContent = "Reading notes…";
  try {
    // The server reads the new message in context: the profile so far plus the recent turns (the last one is usually our question).
    const out = await api("/api/extract", { text, profile: state.profile, history: state.turns.slice(-12) });
    $("#extract-msg").textContent = out.extractor === "gemini" ? "Understood with Gemini." : `⚠ Rule-based fallback is active. ${out.note || ""}`.trim();
    state.profile = out.profile;
    // Items the counsellor said do not exist yet / are not known are closed: they are flagged in the profile but never asked about again.
    for (const label of out.unavailable || []) state.unavailable[label] = true;
    // Preferences the counsellor explicitly left open (any country / flexible intake), and which fields they have actually stated.
    for (const label of out.flexible || []) state.flexible[label] = true;
    for (const field of out.stated || []) state.stated[field] = true;
    state.turns.push({ role: "counsellor", text });
    $("#notes").value = "";

    // An ambiguous statement was NOT applied to the profile, so clear it up first; otherwise ask for the most important missing item.
    const clarify = (out.ambiguities || [])[0];
    const q = clarify && (state.asked.clarify || 0) < 3 ? { key: "clarify", text: clarify.question } : nextQuestion(state.profile, state);
    if (q) {
      state.asked[q.key] = (state.asked[q.key] || 0) + 1;
      state.turns.push({ role: "assistant", text: q.text });
      $("#notes").placeholder = "Answer here…";
      ["#step-confirm", "#results"].forEach((s) => $(s).classList.add("hidden"));
      renderTurns();
    } else {
      state.turns.push({ role: "assistant", text: "Great, I have enough information. Please confirm the profile." });
      $("#notes").placeholder = defaultPlaceholder;
      renderTurns();
      renderForm();
      $("#step-confirm").classList.remove("hidden");
      $("#step-confirm").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (e) { $("#extract-msg").textContent = `Error: ${e.message}`; }
  btn.disabled = false;
}

// ---------- confirm form ----------
function renderForm() {
  const p = state.profile;
  state.countryState = {};
  for (const c of p.preferred_countries) state.countryState[c] = "preferred";
  for (const c of p.mandatory_countries) state.countryState[c] = "mandatory";
  const v = (x) => (x == null ? "" : esc(x));
  const opt = (val, cur, label = val) => `<option value="${esc(val)}" ${val === cur ? "selected" : ""}>${esc(label)}</option>`;
  $("#missing").classList.toggle("hidden", !p.missing.length);
  $("#missing").textContent = p.missing.length ? `Not found in the notes: ${p.missing.join(", ")}. You can fill these in, or continue — missing items get neutral scores and are flagged.` : "";
  $("#profile-form").innerHTML = `
    <div class="grid2"><div><label>Degree</label><input name="degree" value="${v(p.degree)}"></div><div><label>Field / background</label><input name="field_of_study" value="${v(p.field_of_study)}"></div></div>
    <div class="grid3">
      <div><label>CGPA (/10)</label><input name="cgpa" type="number" step="0.01" value="${v(p.cgpa)}"></div>
      <div><label>% (blank = CGPA×9.5)</label><input name="percentage" type="number" step="0.1" value="${p.percentage_source === "stated" ? v(p.percentage) : ""}"></div>
      <div><label>Work exp (months)</label><input name="work_exp_months" type="number" value="${v(p.work_exp_months)}"></div>
    </div>
    <div class="grid3">
      <div><label>English test</label><select name="eng_test">${["", "IELTS", "TOEFL", "PTE"].map((t) => opt(t, p.english?.test || "", t || "—")).join("")}</select></div>
      <div><label>Score</label><input name="eng_score" type="number" step="0.5" value="${v(p.english?.score)}"></div>
      <div><label>GRE (blank = none)</label><input name="gre" type="number" value="${v(p.gre)}"></div>
    </div>
    <label>Career goals</label>
    <div>${state.meta.goals.map((g) => `<label class="goal"><input type="checkbox" name="goal" value="${g.id}" ${p.goals.includes(g.id) ? "checked" : ""}>${esc(g.label)}</label>`).join("")}</div>
    <label class="goal"><input type="checkbox" name="research" ${p.research ? "checked" : ""}>Wants research-heavy programme</label>
    <div class="grid3">
      <div><label>Budget (₹ lakh)</label><input name="budget" type="number" step="0.5" value="${p.budget_inr ? p.budget_inr / 1e5 : ""}"></div>
      <div><label>Budget covers</label><select name="budget_scope">${opt("total", p.budget_scope, "Tuition + living")}${opt("tuition_only", p.budget_scope, "Tuition only")}</select></div>
      <div><label>Intake year</label><input name="intake_year" type="number" placeholder="any" value="${v(p.intake_year)}"></div>
    </div>
    <label>Countries — tap to cycle: open → preferred → mandatory</label>
    <div class="chips" id="country-chips">${state.meta.countries.map((c) => chipHtml(c.slug, c.name)).join("")}</div>
    <p class="muted small">Preferred = ranking boost only. Mandatory = excludes every other country.</p>
    <details><summary>Documents already ready</summary><div style="margin-top:6px">${DOCS.map((d) => `<label class="goal"><input type="checkbox" name="doc" value="${d}" ${p.docs_ready[d] ? "checked" : ""}>${d.replace("_", " ")}</label>`).join("")}</div></details>
    <details><summary>Scholarship details (optional)</summary>
      <p class="muted small">Used only to check scholarship eligibility. Leave blank if the student prefers not to share.</p>
      <label class="goal"><input type="checkbox" name="wants_scholarships" ${p.wants_scholarships ? "checked" : ""}>Student wants scholarships factored into budget fit</label>
      <div class="grid2"><div><label>Category</label><select name="category">${["", "General", "OBC", "SC", "ST", "EWS"].map((c) => opt(c, p.category || "", c || "Prefer not to say")).join("")}</select></div>
      <div><label>Gender</label><select name="gender">${["", "female", "male"].map((c) => opt(c, p.gender || "", c || "Prefer not to say")).join("")}</select></div></div>
      <div class="grid2"><div><label>State</label><input name="state" value="${v(p.state)}"></div><div><label>Family income (₹ lakh / yr)</label><input name="income" type="number" step="0.5" value="${p.family_income_inr ? p.family_income_inr / 1e5 : ""}"></div></div>
    </details>`;
}

const chipHtml = (slug, name) => { const s = state.countryState[slug] || "open"; return `<button type="button" class="chip" data-country="${slug}" data-state="${s}" aria-label="${esc(name)}: ${s}">${esc(name)}${s === "preferred" ? " ★" : s === "mandatory" ? " 🔒" : ""}</button>`; };
function cycleCountry(chip) {
  const slug = chip.dataset.country, cur = state.countryState[slug] || "open";
  const next = cur === "open" ? "preferred" : cur === "preferred" ? "mandatory" : "open";
  if (next === "open") delete state.countryState[slug]; else state.countryState[slug] = next;
  chip.outerHTML = chipHtml(slug, state.meta.countries.find((c) => c.slug === slug).name);
}

function readForm() {
  const f = $("#profile-form");
  const n = (name) => { const x = f.elements[name]?.value; return x === "" || x == null ? null : Number(x); };
  const s = (name) => f.elements[name]?.value?.trim() || null;
  const docs = {}; $$('input[name="doc"]:checked').forEach((d) => (docs[d.value] = true));
  const cs = state.countryState;
  const bud = n("budget"), inc = n("income");
  return {
    degree: s("degree"), field_of_study: s("field_of_study"), cgpa: n("cgpa"), percentage: n("percentage"),
    work_exp_months: n("work_exp_months"), english: s("eng_test") && n("eng_score") != null ? { test: s("eng_test"), score: n("eng_score") } : null,
    gre: n("gre"), goals: $$('input[name="goal"]:checked').map((g) => g.value), research: f.elements.research.checked,
    budget_inr: bud ? bud * 1e5 : null, budget_scope: s("budget_scope"), intake_year: n("intake_year"),
    preferred_countries: Object.keys(cs).filter((k) => cs[k] === "preferred"), mandatory_countries: Object.keys(cs).filter((k) => cs[k] === "mandatory"),
    acceptable_countries: state.profile.acceptable_countries, wants_scholarships: f.elements.wants_scholarships.checked,
    category: s("category"), gender: s("gender"), state: s("state"), family_income_inr: inc ? inc * 1e5 : null, docs_ready: docs,
  };
}

async function recommend() {
  const btn = $("#btn-recommend");
  btn.disabled = true; btn.textContent = "Ranking…";
  try {
    state.rec = await api("/api/recommend", { profile: readForm(), limit: 5 });
    state.profile = state.rec.profile;
    renderResults();
    $("#results").classList.remove("hidden");
    showTab("recs");
    $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { alert(e.message); }
  btn.disabled = false; btn.textContent = "Confirm & recommend";
}

// ---------- results ----------
function showTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  ["recs", "plan", "search"].forEach((t) => $(`#tab-${t}`).classList.toggle("hidden", t !== name));
}

function renderResults() {
  const r = state.rec;
  const notes = r.notes.map((n) => `<div class="notice">${esc(n)}</div>`).join("");
  const main = r.results.map(courseCard).join("");
  const alts = r.alternatives.length ? `<button class="wide" data-more="alts">Show ${r.alternatives.length} more alternatives</button><div id="alts" class="hidden">${r.alternatives.map(courseCard).join("")}</div>` : "";
  const stretch = r.stretch.length ? `<h3>Stretch options (over budget)</h3>${r.stretch.map(courseCard).join("")}` : "";
  const excl = r.excluded.length ? `<button class="wide" data-more="excl">Why were ${r.excluded.length} courses left out?</button><div id="excl" class="hidden card"><ul class="excl">${r.excluded.map((e) => `<li><b>${esc(e.name)}</b> — ${esc(e.university)} (${esc(e.country)})<br><span class="muted">${esc(e.reasons.join("; "))}</span></li>`).join("")}</ul></div>` : "";
  $("#tab-recs").innerHTML = `${notes}<p class="muted small">${r.counts.eligible} of ${r.counts.evaluated} courses fit the budget and passed the eligibility checks.${r.stretch.length ? ` ${r.stretch.length} more over-budget option(s) are shown as stretch.` : ""}</p>${main}${alts}${stretch}${excl}`;
  renderPlan();
}

function courseCard(c) {
  const k = c.cost, lk = k.lakh;
  const dq = c.data_quality === "verified" ? `<span class="pill ok">fees verified</span>` : `<span class="pill warn">fees estimated</span>`;
  const im = (key) => (k.imputed.includes(key) ? " <span class='pill warn'>imputed</span>" : "");
  const intake = c.intake.chosen ? `${c.intake.chosen.start_year}-${String(c.intake.chosen.start_month).padStart(2, "0")}` : "—";
  const elig = c.scholarships.eligible, poss = c.scholarships.possible;
  const sch = (s, possible) => `<div class="sch"><b>${esc(s.name)}</b> <span class="pill ${possible ? "warn" : "ok"}">${possible ? "needs " + esc(s.needs.join(", ")) : "eligible"}</span><br><span class="muted">${esc(s.provider || "")}${s.amount_local != null ? ` · ${esc(s.currency)} ${Number(s.amount_local).toLocaleString("en-IN")}/yr` : " · amount varies"}${s.deadline ? ` · deadline ${esc(s.deadline)}` : ""}</span>${s.source_url ? ` <a class="link" target="_blank" rel="noopener" href="${esc(s.source_url)}">source</a>` : ""}</div>`;
  const rd = c.readiness;
  const docChip = (d) => `<span class="pill ${d.status === "ready" ? "ok" : d.status === "partial" ? "warn" : "bad"}">${esc(d.doc_type.replace("_", " "))}${d.quantity > 1 ? " ×" + d.quantity : ""} · ${d.status}</span>`;
  const chk = (x) => `<span class="pill ${x.status === "pass" ? "ok" : x.status === "unknown" ? "warn" : "bad"}" title="${esc(x.detail)}">${esc(x.item)}: ${x.status}</span>`;
  const id = `d-${c.course_slug}`;
  return `<article class="card course">
    <div class="course-head"><div class="rank">${c.rank}</div><div class="t"><b>${esc(c.name)}</b><span>${esc(c.university)} · ${esc(c.city)}, ${esc(c.country)}</span></div><div class="score">${c.score}<small>/ 100</small></div></div>
    <div class="pills">${c.country_match ? `<span class="pill ${c.country_match === "preferred" ? "ok" : "warn"}">${c.country_match === "preferred" ? "preferred country" : "alternative country"}</span>` : ""}<span class="pill">${esc(c.degree_level)}</span><span class="pill">${c.duration_months} months</span><span class="pill">intake ${intake}</span>${dq}${c.tags.slice(0, 3).map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</div>
    ${c.cross_border_note ? `<div class="cross">${esc(c.cross_border_note)}</div>` : ""}
    <h3>Why this course</h3><ul class="why">${c.why.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>
    <details><summary>Score breakdown</summary>${c.breakdown.map((b) => `<div class="bd"><span>${esc(b.label)} <span class="muted">(${b.weight}%)</span></span><b>${b.score}</b><div class="bar" style="grid-column:1/-1"><i style="width:${b.score}%"></i></div><span class="n">${esc(b.note)}</span></div>`).join("")}</details>
    <details open><summary>Cost estimate — ${L(lk.total)} total · ${L(lk.per_year)} / year${c.cost.tuition_known ? "" : " (tuition unknown)"}</summary>
      <table><tr><td>Tuition</td><td>${k.tuition_known ? L(lk.tuition) : "unknown"}</td></tr>
      <tr><td>Housing (${esc((k.housing_type || "typical").replaceAll("_", " "))})${im("housing")}</td><td>${L(lk.housing)}</td></tr>
      <tr><td>Living, excl. rent${im("living")}</td><td>${L(lk.living)}</td></tr>
      <tr class="total"><td>${k.tuition_known ? "Total" : "Total excl. tuition"}</td><td>${L(lk.total)}</td></tr></table>
      ${k.housing_options.length ? `<p class="muted small">Housing options: ${k.housing_options.map((h) => `${esc(h.type.replaceAll("_", " "))} ₹${Math.round(h.monthly_inr).toLocaleString("en-IN")}/mo`).join(" · ")}</p>` : ""}
    </details>
    <details><summary>Scholarships (${elig.length} eligible${poss.length ? `, ${poss.length} need info` : ""})</summary>${elig.map((s) => sch(s, false)).join("")}${poss.map((s) => sch(s, true)).join("") || ""}${!elig.length && !poss.length ? `<p class="muted small">No matching scholarship on file for this course.</p>` : ""}</details>
    <details><summary>Application readiness — ${rd.percent}% · <span class="prio ${rd.priority}" style="padding:1px 6px">${rd.priority}</span></summary>
      <p class="small">${esc(rd.reason)}. <b>${esc(rd.next_action)}.</b></p>
      <div class="docs">${rd.docs.map(docChip).join("")}</div>${rd.default_checklist ? `<p class="muted small">The university page lists no document types; this is a standard checklist.</p>` : ""}
      <div class="docs">${rd.checks.map(chk).join("")}</div>
    </details>
    ${c.warnings.length ? `<ul class="warns">${c.warnings.map((w) => `<li>${esc(w)}</li>`).join("")}</ul>` : ""}
    <p style="margin:8px 0 0">${c.course_url ? `<a class="link" target="_blank" rel="noopener" href="${esc(c.course_url)}">Course page ↗</a>` : ""} <span class="muted small">· checked ${esc(c.last_verified || "—")}</span></p>
  </article>`;
}

function renderPlan() {
  const plan = state.rec.plan;
  $("#tab-plan").innerHTML = `<div class="card"><h2>Which application first?</h2><p class="muted small">Priority combines days to deadline with the document work still left (rules in README). Unpublished deadlines count as lowest urgency.</p>${plan.map((p) => `<div class="plan-item"><div class="prio ${p.priority}">${p.priority}</div><div><b>${esc(p.name)}</b><br><span class="muted small">${esc(p.university)} · ${esc(p.country)} · ${p.readiness}% ready</span><br><span class="small">${esc(p.next_action)} — ${esc(p.reason)}</span></div></div>`).join("") || "<p>No open applications.</p>"}</div>`;
}

// ---------- search ----------
async function search() {
  const q = $("#q").value.trim();
  if (!q) return;
  const rows = await api(`/api/search?q=${encodeURIComponent(q)}`);
  $("#search-out").innerHTML = rows.length ? rows.map((c) => `<article class="card course"><b>${esc(c.name)}</b><br><span class="muted">${esc(c.university)} · ${esc(c.city)}, ${esc(c.country)} · ${c.duration_months} months</span>
    <div class="pills">${c.tags.map((t) => `<span class="pill">${esc(t)}</span>`).join("")}</div>
    <p class="small">${esc(c.description || "")}</p>
    <table><tr><td>Tuition</td><td>${c.tuition_inr_lakh != null ? `${esc(c.currency)} ${Number(c.tuition_total_local).toLocaleString("en-IN")} (${L(c.tuition_inr_lakh)})` : "unknown"}</td></tr>
    <tr><td>Min grade / IELTS / GRE</td><td>${c.min_percentage_equiv ?? "—"}% / ${c.ielts_min ?? "—"} / ${esc(c.gre_policy ?? "—")}</td></tr>
    <tr><td>Intakes</td><td>${c.intakes.map((i) => `${i.start}${i.rolling ? " (rolling)" : i.deadline ? ` → ${i.deadline}` : " (deadline n/p)"}`).join("<br>") || "—"}</td></tr></table>
    ${c.course_url ? `<a class="link" target="_blank" rel="noopener" href="${esc(c.course_url)}">Course page ↗</a>` : ""}</article>`).join("") : `<p class="muted">No courses matched.</p>`;
}

// ---------- Picture-in-Picture next to Google Meet ----------
async function popOut() {
  if (!("documentPictureInPicture" in window)) { alert("Pop-out needs Chrome or Edge 116+. You can also snap this window beside Google Meet."); return; }
  const pip = await documentPictureInPicture.requestWindow({ width: 440, height: 720 });
  for (const ss of document.styleSheets) {
    try { const st = document.createElement("style"); st.textContent = [...ss.cssRules].map((r) => r.cssText).join("\n"); pip.document.head.appendChild(st); }
    catch { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = ss.href; pip.document.head.appendChild(l); }
  }
  pip.document.body.className = "pip";
  pip.document.body.style.margin = "0";
  pip.document.body.append(app);
  pip.addEventListener("pagehide", () => document.body.append(app));
}

init().catch((e) => { document.body.insertAdjacentHTML("afterbegin", `<p style="padding:12px;color:#a3202f">Could not load: ${esc(e.message)}</p>`); });