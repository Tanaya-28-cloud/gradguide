// MOCK data with the real schema shape — for engine testing only. NOT the real dataset.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const file = path.join(import.meta.dirname, "test.db");
fs.rmSync(file, { force: true });
const db = new DatabaseSync(file);
db.exec(fs.readFileSync(path.join(import.meta.dirname, "schema.sql"), "utf8"));
const ins = (t, rows) => { for (const r of rows) { const k = Object.keys(r); db.prepare(`INSERT INTO ${t} (${k}) VALUES (${k.map(() => "?")})`).run(...Object.values(r)); } };

ins("countries", [["usa","United States","USD"],["uk","United Kingdom","GBP"],["australia","Australia","AUD"],["canada","Canada","CAD"],["ireland","Ireland","EUR"],["new-zealand","New Zealand","NZD"],["uae","United Arab Emirates","AED"],["india","India","INR"]].map(([a,b,c]) => ({ country_slug: a, name: b, currency: c })));
ins("fx_rates", [["USD",88],["GBP",115],["AUD",58],["CAD",63],["EUR",101],["NZD",52],["AED",24],["INR",1]].map(([a,b]) => ({ currency: a, inr_per_unit: b, as_of: "2026-10-01" })));
const city = (s, c, n, live, q = "estimated") => ({ city_slug: s, country_slug: c, name: n, monthly_living_cost_local: live, cost_source_url: "x", data_quality: q, last_verified: "2026-10-01" });
ins("cities", [city("toronto","canada","Toronto",1500), city("halifax","canada","Halifax",null,null), city("sydney","australia","Sydney",2400), city("dublin","ireland","Dublin",1100), city("limerick","ireland","Limerick",null,null), city("glasgow","uk","Glasgow",900), city("auckland","new-zealand","Auckland",1800), city("dubai","uae","Dubai",null,null), city("tempe","usa","Tempe",1200)]);
ins("universities", [["u-toronto","University of Toronto","toronto"],["dal","Dalhousie University","halifax"],["unsw","UNSW Sydney","sydney"],["ucd","University College Dublin","dublin"],["ul","University of Limerick","limerick"],["glasgow","University of Glasgow","glasgow"],["auckland","University of Auckland","auckland"],["hwu","Heriot-Watt Dubai","dubai"],["asu","Arizona State University","tempe"]].map(([a,b,c]) => ({ uni_slug: a, name: b, city_slug: c, website_url: "x" })));
// [slug, uni, name, level, field, months, tuition_total, tags, minPct, bgs, ielts, gre, intakes[[m,y,deadline,rolling]]]
const C = [
 ["tor-mscac-ai","u-toronto","MSc Applied Computing (AI)","master","artificial-intelligence",20,60000,["artificial-intelligence","machine-learning","data-science"],70,"Computer Science;Information Technology;Computer Engineering;Engineering",7,"not_required",[[9,2027,"2027-01-15",0]]],
 ["dal-mcs-cloud","dal","Master of Computer Science (Cloud)","master","computer-science",16,45000,["cloud-computing","software-engineering","cybersecurity"],65,"Computer Science;Information Technology;Engineering",6.5,"not_required",[[9,2027,"2027-03-01",0]]],
 ["unsw-mai","unsw","Master of Artificial Intelligence","master","artificial-intelligence",24,116000,["artificial-intelligence","machine-learning","data-science"],65,"Computer Science;Information Technology;Computer Engineering;Engineering",6.5,"not_required",[[2,2027,"2026-11-30",0],[7,2027,"2027-05-31",0]]],
 ["unsw-mit","unsw","Master of Information Technology","master","software-engineering",24,116000,["software-engineering","cloud-computing","data-analytics"],65,"Computer Science;Information Technology;Computer Engineering;Engineering",6.5,"not_required",[[2,2027,"2026-09-30",0]]],
 ["ucd-msc-cs","ucd","MSc Computer Science (Data Analytics)","master","data-science",12,29000,["data-science","data-analytics","machine-learning"],60,"Computer Science;Information Technology;Engineering",6.5,"not_required",[[9,2027,null,0]]],
 ["ul-msc-aiml","ul","MSc Artificial Intelligence & Machine Learning","master","artificial-intelligence",12,22000,["artificial-intelligence","machine-learning","data-science"],60,"Computer Science;Information Technology;Computer Engineering;Engineering",6.5,"not_required",[[9,2027,null,0]]],
 ["ul-msc-se","ul","MSc Software Engineering","master","software-engineering",12,22000,["software-engineering","cloud-computing"],60,"Computer Science;Information Technology;Engineering",6.5,"not_required",[[9,2027,null,1]]],
 ["gla-msc-cyber","glasgow","MSc Cyber Security","master","cybersecurity",12,26500,["cybersecurity","cloud-computing"],60,"Computer Science;Information Technology;Electronics;Engineering",6.5,"not_required",[[9,2027,"2027-07-31",0]]],
 ["auck-mds","auckland","Master of Data Science","master","data-science",18,null,["data-science","data-analytics","machine-learning","artificial-intelligence"],65,"Computer Science;Mathematics;Engineering",6.5,"unknown",[[2,2027,"2026-12-01",0]]],
 ["hwu-msc-ai","hwu","MSc Artificial Intelligence","master","artificial-intelligence",12,95000,["artificial-intelligence","robotics"],60,"Computer Science;Engineering",6.5,"not_required",[[9,2027,"2027-06-30",0]]],
 ["asu-ms-cs","asu","MS Computer Science","master","computer-science",24,64000,["software-engineering","cloud-computing","artificial-intelligence"],70,"Computer Science;Computer Engineering",7,"required",[[8,2027,"2027-03-01",0]]],
];
ins("courses", C.map(([s,u,n,l,f,m,t]) => ({ course_slug: s, uni_slug: u, name: n, degree_level: l, field: f, duration_months: m, tuition_total_local: t, description: `${n}.`, course_url: "x", data_quality: "estimated", last_verified: "2026-10-01" })));
ins("course_tags", C.flatMap(([s,,,,,,,tags]) => tags.map((t) => ({ course_slug: s, tag: t }))));
ins("course_requirements", C.map(([s,,,,,,,,min,bg,ie,gre]) => ({ course_slug: s, min_percentage_equiv: min, requirement_raw_text: "mock", accepted_backgrounds: bg, ielts_min: ie, toefl_min: 90, pte_min: 64, gre_policy: gre, gmat_policy: "not_required" })));
ins("intakes", C.flatMap(([s,,,,,,,,,,,,ints]) => ints.map(([m,y,d,r]) => ({ course_slug: s, start_month: m, start_year: y, application_deadline: d, is_rolling: r }))));
const D = (s, rows) => rows.map(([t,q,e]) => ({ course_slug: s, doc_type: t, quantity: q, effort_days: e }));
ins("course_documents", [...D("tor-mscac-ai",[["SOP",1,5],["LOR",3,6],["RESUME",1,2],["TRANSCRIPT",1,5],["ENGLISH_TEST",1,0]]), ...D("unsw-mai",[["SOP",1,5],["RESUME",1,2],["TRANSCRIPT",1,5],["PASSPORT",1,2]]), ...D("ul-msc-aiml",[["SOP",1,5],["LOR",2,4],["TRANSCRIPT",1,5]]), ...D("asu-ms-cs",[["GRE",1,30],["SOP",1,5],["LOR",3,6]])]);
const A = (u, t, c) => ({ uni_slug: u, type: t, monthly_cost_local: c, distance_km: null, source_url: "x", data_quality: "estimated", last_verified: "2026-10-01" });
ins("accommodation_options", [A("u-toronto","university_residence",1400), A("u-toronto","shared",1000), A("unsw","private_student_housing",1800), A("ucd","university_residence",950), A("glasgow","shared",650), A("auckland","university_residence",1500), A("asu","shared",800), A("dal","shared",null)]);
ins("scholarships", [
 { scholarship_slug: "unsw-intl-merit", name: "UNSW International Merit", provider: "UNSW", provider_type: "university", country_slug: "australia", uni_slug: "unsw", amount_local: 10000, covers: "tuition", deadline: null },
 { scholarship_slug: "goi-ies", name: "Government of Ireland Scholarship", provider: "HEA", provider_type: "destination_govt", country_slug: "ireland", uni_slug: null, amount_local: 10000, covers: "stipend", deadline: null },
 { scholarship_slug: "natl-overseas-sc", name: "National Overseas Scholarship (SC)", provider: "Govt of India", provider_type: "home_govt", country_slug: "india", uni_slug: null, amount_local: null, covers: "tuition+living", deadline: null },
].map((s) => ({ ...s, source_url: "x", data_quality: "verified", last_verified: "2026-10-01" })));
ins("scholarship_rules", [
 ["unsw-intl-merit","nationality","in",'["India"]',"International student"], ["unsw-intl-merit","min_percentage","gte","75","75% or above"],
 ["goi-ies","nationality","in",'["India"]',"Non-EU"], ["goi-ies","degree_level","eq",'"master"',"Master's study"], ["goi-ies","destination_country","eq",'"ireland"',"Study in Ireland"],
 ["natl-overseas-sc","category","in",'["SC","ST"]',"SC/ST candidates"], ["natl-overseas-sc","family_income_max_inr","lte","800000","Family income up to ₹8L"],
].map(([a,b,c,d,e]) => ({ scholarship_slug: a, attribute: b, operator: c, value: d, description: e })));
const demo = fs.readFileSync(path.join(import.meta.dirname, "demo_students.json"), "utf8");
ins("demo_students", JSON.parse(demo));
console.log("mock db written:", file);
