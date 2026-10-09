// Maps free-text country mentions to the slugs actually present in the `countries` table.
const GROUPS = [
  { id: "usa", names: ["usa", "us", "united states", "united states of america"], res: [/\bUSA\b/i, /\bU\.S\.A?\b/, /\bUnited States\b/i, /\bAmerica\b/i, /\bUS\b/] },
  { id: "uk", names: ["uk", "united kingdom", "great britain"], res: [/\bUK\b/i, /\bU\.K\.?/, /\bUnited Kingdom\b/i, /\bBritain\b/i, /\bEngland\b/i, /\bScotland\b/i] },
  { id: "australia", names: ["australia"], res: [/\bAustralia\b/i] },
  { id: "canada", names: ["canada"], res: [/\bCanada\b/i] },
  { id: "ireland", names: ["ireland"], res: [/\bIreland\b/i] },
  { id: "new-zealand", names: ["new zealand", "nz"], res: [/\bNew Zealand\b/i, /\bNZ\b/] },
  { id: "uae", names: ["uae", "united arab emirates"], res: [/\bUAE\b/i, /\bUnited Arab Emirates\b/i, /\bEmirates\b/i, /\bDubai\b/i, /\bAbu Dhabi\b/i] },
];

export function buildCountryMatchers(countryRows) {
  return GROUPS.map((g) => {
    const row = countryRows.find((c) => {
      const slug = c.country_slug.toLowerCase().replace(/-/g, " ");
      return g.names.includes(slug) || g.names.includes(c.name.toLowerCase());
    });
    return row ? { slug: row.country_slug, name: row.name, res: g.res } : null;
  }).filter(Boolean);
}

export const mentionsCountry = (matcher, text) => matcher.res.some((re) => re.test(text));
