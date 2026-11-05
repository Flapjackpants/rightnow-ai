import Papa from "papaparse";
import { LeadError } from "./service";

export type LeadField =
  | "email"
  | "firstName"
  | "lastName"
  | "companyName"
  | "jobTitle"
  | "website"
  | "phone"
  | "country"
  | "region";
export type Mapping = (LeadField | `custom:${string}` | null)[];

const ALIASES: Record<LeadField, string[]> = {
  email: ["email", "emailaddress"],
  firstName: ["firstname", "first"],
  lastName: ["lastname", "last", "surname"],
  companyName: ["company", "companyname"],
  jobTitle: ["title", "jobtitle", "position"],
  website: ["website", "url", "domain"],
  phone: ["phone", "phonenumber"],
  country: ["country"],
  region: ["region", "state", "province"],
};
export const LEAD_FIELDS = Object.keys(ALIASES) as LeadField[];

export function parseCsv(
  buf: Buffer,
  preview?: number,
): { headers: string[]; rows: string[][]; delimiter: string } {
  let text = buf.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const r = Papa.parse<string[]>(text, {
    delimitersToGuess: [",", ";", "\t", "|"],
    skipEmptyLines: true,
    ...(preview && { preview: preview + 1 }), // + the header row
  });
  // an unterminated quote swallows the rest of the file: refuse it rather than import a silent fragment
  const bad = r.errors.find((e) => e.type === "Quotes");
  if (bad) throw new LeadError(400, `csv_parse_error: ${bad.message} (row ${(bad.row ?? 0) + 1})`);
  const [headers = [], ...rows] = r.data;
  return { headers: headers.map((h) => h.trim()), rows, delimiter: r.meta.delimiter };
}

/** Case-insensitive, ignoring spaces, `_` and `-`. The first header per field wins; the rest are custom. */
export function autoMap(headers: string[]): Mapping {
  const used = new Set<LeadField>();
  return headers.map((h): Mapping[number] => {
    const k = h.toLowerCase().replace(/[\s_-]/g, "");
    const f = LEAD_FIELDS.find((f) => !used.has(f) && ALIASES[f].includes(k));
    if (!f) return `custom:${h}`;
    used.add(f);
    return f;
  });
}
