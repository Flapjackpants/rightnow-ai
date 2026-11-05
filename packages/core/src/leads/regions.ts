/**
 * Location exclusions (Stage 3): country and region spellings are matched only after normalization, so a lead's
 * "Germany", " germany " or "DE" all hit the same rule and an unknown or empty location never does.
 */

const REGION = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/** Common spellings Intl does not know (English names and ISO codes are added from the table below). */
const ALIASES: Record<string, string> = {
  usa: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  "united states of america": "US",
  america: "US",
  uk: "GB",
  "u.k.": "GB",
  "great britain": "GB",
  "united kingdom": "GB",
  england: "GB",
  scotland: "GB",
  wales: "GB",
};

/** Lower-cased spelling → code, built once. */
const SPELLINGS = new Map<string, string>();
for (let a = 65; a <= 90; a++)
  for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    const name = REGION.of(code);
    if (!name) continue; // not an assigned code
    SPELLINGS.set(name.trim().toLowerCase(), code);
    SPELLINGS.set(code.toLowerCase(), code);
  }
for (const [alias, code] of Object.entries(ALIASES)) SPELLINGS.set(alias, code);

const BY_CODE = new Map<string, string[]>();
for (const [spelling, code] of SPELLINGS) {
  const list = BY_CODE.get(code) ?? [];
  list.push(spelling);
  BY_CODE.set(code, list);
}

/** ISO alpha-2 for a code, English name or alias, any case; null when unknown or empty. */
export function normalizeCountry(raw: string | null | undefined): string | null {
  const v = raw?.trim().toLowerCase();
  return (v && SPELLINGS.get(v)) || null;
}

/** Lower-cased, trimmed; null when empty. */
export function normalizeRegion(raw: string | null | undefined): string | null {
  return raw?.trim().toLowerCase() || null;
}

/** Every lower-cased spelling `normalizeCountry` maps to this code. Used for the set-based SQL match. */
export function countrySpellings(code: string): string[] {
  return BY_CODE.get(code.trim().toUpperCase()) ?? [];
}

export type RegionRules = { excludedCountries: string[]; excludedRegions: string[] };

/** True when the lead's country or region is excluded; an unknown or empty location is never excluded. */
export function regionExcluded(
  l: { country: string | null; region: string | null },
  r: RegionRules,
): boolean {
  const country = normalizeCountry(l.country);
  if (country && r.excludedCountries.includes(country)) return true;
  const region = normalizeRegion(l.region);
  return !!region && r.excludedRegions.includes(region);
}
