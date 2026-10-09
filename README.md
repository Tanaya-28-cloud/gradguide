# GradGuide Copilot — Course Recommendation Assistant

A counsellor-facing assistant that sits beside Google Meet (as a floating Picture-in-Picture panel) and turns a student's profile into **consistent, explainable** course recommendations, plus scholarship matching, a realistic total-cost estimate, and an application-priority plan.

> Video walkthrough: https://drive.google.com/drive/folders/1x3kAtn21CRUOsp0B0X4SOg3WQDjd4dbh?usp=sharing

## Run it

Requires **Node 22.12+** (uses the built-in `node:sqlite`, so there is nothing native to install).

```bash
npm install
# put gradguide.db (the SQLite file built from the dataset) in this folder
copy .env.example .env      # (macOS/Linux: cp) optional: add GEMINI_API_KEY for LLM extraction
npm start                   # http://localhost:3000
npm test                    # 8 demo students on a built-in mock DB
npm run test:real           # same checks on ./gradguide.db
```
Without a Gemini key the app falls back to a rule-based extractor, so it always works offline.

**Use it with Meet:** open the app, click **Pop out ⧉** (Chrome/Edge 116+). The panel floats over the Meet window using the Document Picture-in-Picture API and stays on top while the counsellor talks.

## How a recommendation is made

```
counsellor notes ──► extractor (Gemini or rules) ──► structured profile ──► counsellor confirms/edits
                                                                                   │
        hard constraints (exclude) ──► six weighted 0-100 scores ──► rank ──► explanation + 3 features
```

**The LLM never ranks.** It only extracts; a counsellor confirms the profile; ranking is a pure function of (profile, database). The same profile always gives the same result, and two phrasings of the same student (demo students 01 and 08) give an identical ranking — checked by `npm test`.

### Hard constraints (a course is excluded, with the reason shown under "Why were N courses left out?")
- Mandatory country not matched
- Grade below the course minimum (CGPA × 9.5 unless a percentage is given)
- Background not in the course's accepted list
- English score below the minimum (TOEFL/PTE are compared directly; if the course lists only IELTS, an approximate concordance is used and flagged)
- Work-experience minimum not met (only if the student's experience is known)
- Requested intake year unavailable, or **every** deadline for it has passed
- Cost more than 50% over budget → moved to **stretch options** (shown only when fewer than 3 courses fit)

Missing student data never excludes a course: a missing GRE is "unknown", not "failed".

### Soft scoring (weights are visible on every card)
| Factor | Weight | 0-100 definition |
|---|---|---|
| Career alignment | 25 | Goal → course tags/field. Direct tag match = 100, adjacent tag ≈ 50, field-only ≈ 60; 70% best goal + 30% average over goals |
| Academic & English margin | 20 | 70% grade margin over the minimum (60 + 2.5 pts per % above, cap 100) + 30% English margin |
| Budget fit | 20 | ≤80% of budget = 100, falling to 85 at 100%, 0 at 150%. Unknown tuition is capped at 35 |
| Course fit | 15 | Background match (50%), GRE/GMAT policy compatibility (35%), degree level (15%) |
| Country preference | 10 | Mandatory 100; preferred 100; acceptable 75; other 40 (a **soft** penalty); no preference = neutral 70 |
| Intake | 10 | Open intake = 75 (100 if it matches the requested month) |

**Preferred country is a ranking factor, not a filter.** When a non-preferred country wins, the top card says why, e.g. _"Ireland wasn't a preferred destination, but this scores 26 points above the best Canada option … mainly on career alignment and budget fit."_ A country is a hard filter only when the counsellor marks it **mandatory** (tap the country chip twice).

### Incomplete information
- Extraction lists what it could not find; the form lets the counsellor fill or skip it.
- Missing values get **neutral** scores (never zero, never a free pass) and a visible warning on each card.
- Blank housing or living cost is **imputed** from the same country (else the dataset median) and labelled _imputed_ — otherwise courses with undisclosed costs would look artificially cheap.
- Tuition is never imputed. A course with unknown tuition ranks after verified-cost courses.

## Data
SQLite (`gradguide.db`), 14 tables: `countries, fx_rates, cities, universities, courses, course_tags, intakes, course_requirements, course_documents, accommodation_options, scholarships, scholarship_rules, verification_log, demo_students`. SQL was chosen over NoSQL because the data is strongly relational (course → university → city → country, scholarships → rules) and the dataset is small.

- Every fee, deadline and score requirement has a row in `verification_log` (source URL, short evidence snippet, notes for any conversion).
- `data_quality` is `verified` (stated on an official page) or `estimated` (calculated; formula in the log). Blank means unknown, never 0.
- **To update:** edit the per-country CSVs, re-run `import_data.py`, restart the server. The app reads the DB once at start-up.
- Scholarship eligibility is data-driven: `scholarship_rules` rows (`attribute`, `operator`, JSON `value`) are evaluated generically, so adding a scholarship needs no code change.

## The three features

**1. Scholarship matching with reasons.** _Problem:_ counsellors check scholarship pages by hand and miss options. _How:_ each rule is evaluated as pass / fail / unknown against the student's nationality, category, gender, state, income, grade and the course's country, university, level and field. Result: **eligible**, **possible (needs: income, category…)**, or hidden if a rule fails, with the official condition text. Sensitive fields (category, gender, income) are optional, collapsed, and used only here. If the counsellor says the student values scholarships, budget fit uses the cost after the best eligible award (labelled "not guaranteed").

**2. Total-cost estimate.** _Problem:_ tuition alone makes courses look affordable that aren't. _How:_ tuition + cheapest housing option × duration + living cost × duration, converted to INR at the stored FX rate, shown per year and in total, with every estimated/imputed number flagged and all housing types listed.

**3. Application readiness & priority.** _Problem:_ counsellors don't know which application to start first. _How:_ documents each course asks for (with effort-days) are checked against what's ready; **readiness % = share of preparation effort already done**. Priority:
- `HIGH` — deadline ≤ 60 days, or the remaining work will not fit before it (slack < 14 days)
- `MEDIUM` — deadline ≤ 120 days, slack < 45 days, or rolling admissions
- `LOW` — otherwise; unpublished deadlines are lowest urgency (not treated as rolling)
- `CLOSED` — every deadline for that intake has passed

Effort-days are working days, converted to calendar days with ×1.5. Courses whose page lists no documents use a clearly labelled default checklist.

## Honest limitations
- CGPA→percentage uses ×9.5; universities differ. Counsellors can type the actual percentage.
- English-score conversion between IELTS/TOEFL/PTE is approximate and flagged when used.
- Some costs are estimates (see `data_quality`); 2026 fees stand in where 2027 fees are unpublished.
- Extraction by an LLM can misread notes — hence the mandatory confirm step.
- Scholarship amounts and deadlines change; each scholarship links to its source page.

## Layout
```
server.js        Express API (/api/extract, /api/recommend, /api/search, /api/meta)
db.js            SQLite loader (node:sqlite), cost fallbacks
engine/          profile · extract · constraints · scoring · cost · scholarships · readiness · index
public/          floating-panel UI (no build step)
test/            demo-student behaviour checks (+ mock DB for running without the real data)
```
