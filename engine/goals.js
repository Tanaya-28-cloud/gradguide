// Career goals -> course tags/fields. "primary" tags are direct matches, "secondary" are adjacent.
export const GOALS = {
  "ai-ml": {
    label: "AI / Machine Learning",
    primary: ["artificial-intelligence", "machine-learning"],
    secondary: ["data-science", "robotics"],
    fields: ["artificial-intelligence"],
    detect: /artificial intelligence|\bAI\b|machine[- ]learning|\bML\b|deep learning|\bNLP\b/i,
  },
  "data-science": {
    label: "Data Science / Analytics",
    primary: ["data-science", "data-analytics"],
    secondary: ["machine-learning", "business-analytics"],
    fields: ["data-science"],
    detect: /data science|data analy|analytics|data engineer|\bBI\b/i,
  },
  cybersecurity: {
    label: "Cybersecurity",
    primary: ["cybersecurity"],
    secondary: [],
    fields: ["cybersecurity"],
    detect: /cyber|infosec|information security|cloud security|\bsecurity\b/i,
  },
  "cloud-devops": {
    label: "Cloud / DevOps",
    primary: ["cloud-computing"],
    secondary: ["software-engineering"],
    fields: [],
    detect: /\bcloud\b|devops|\bSRE\b|infrastructure/i,
  },
  "software-engineering": {
    label: "Software Engineering",
    primary: ["software-engineering"],
    secondary: ["cloud-computing"],
    fields: ["software-engineering", "computer-science"],
    detect: /software (?:engineer|develop)|\bSWE\b|backend|full[- ]stack/i,
  },
};

/** Score (0-1) of how well a course matches one goal, with the evidence used. */
export function goalMatch(goalId, course) {
  const g = GOALS[goalId];
  if (!g) return { match: 0, evidence: [] };
  const prim = g.primary.filter((t) => course.tags.includes(t));
  const sec = g.secondary.filter((t) => course.tags.includes(t));
  const fieldHit = g.fields.includes(course.field);
  let match = 0;
  const evidence = [];
  if (prim.length) {
    match = g.primary.length === 1 || prim.length >= 2 ? 1 : 0.8;
    evidence.push(...prim);
  }
  if (sec.length && match < 0.5) { match = 0.5; evidence.push(...sec); }
  if (fieldHit && match < 0.6) { match = 0.6; evidence.push(`field:${course.field}`); }
  return { match, evidence };
}
