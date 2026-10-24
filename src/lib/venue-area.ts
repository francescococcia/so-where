// A venue's own place in London ("South Bank · near Waterloo"), from its OSM address tags and the nearest
// station in the bundled TfL station list. Never built from what anyone typed about where they are.
import { STATIONS } from "@/lib/gazetteer";
import { metresBetween } from "@/lib/geo";
import type { LatLng } from "@/lib/plan-types";

const RAIL = new Set(["tube", "elizabeth-line", "overground", "dlr", "national-rail"]);
const key = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\(approx\.?\)/g, "").replace(/&/g, " and ").replace(/['’`.~]/g, "").replace(/\b(underground|overground|rail|dlr|station|london)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/** Does `text` mention `area` (their typed area, e.g. "~Waterloo", "Camden (approx.)") as a whole word? */
export function mentionsArea(text: string | null | undefined, area: string | null | undefined): boolean {
  const a = area ? key(area) : "";
  if (!text || a.length < 3) return false;
  return ` ${key(text)} `.includes(` ${a} `);
}

/** Do two place names overlap ("Waterloo" ~ "Waterloo East", "Elephant & Castle" ~ "Elephant and Castle")? */
export function sameArea(x: string, y: string): boolean {
  const a = key(x);
  const b = key(y);
  if (!a || !b) return false;
  return a === b || ` ${a} `.includes(` ${b} `) || ` ${b} `.includes(` ${a} `);
}

/** Nearest rail / tube station to a point (within `maxM`), skipping names that overlap any of `avoid`. */
export function nearestStation(p: LatLng, avoid: (string | null | undefined)[] = [], maxM = 1200): { name: string; metres: number } | null {
  let best: { name: string; metres: number } | null = null;
  for (const s of STATIONS) {
    if (!s.modes.some((m) => RAIL.has(m))) continue;
    const d = metresBetween(p, s);
    if (d > maxM || (best && d >= best.metres)) continue;
    if (avoid.some((a) => a && sameArea(s.name, a))) continue;
    best = { name: s.name, metres: Math.round(d) };
  }
  return best;
}

/** "South Bank · near Waterloo" / "near Borough" / null: the venue's neighbourhood (OSM addr tags) + its station. */
export function venueArea(tags: Record<string, string>, p: LatLng, avoid: (string | null | undefined)[] = []): string | null {
  const hood = tags["addr:neighbourhood"] || tags["addr:quarter"] || tags["addr:suburb"] || tags["is_in:suburb"] || null;
  const st = nearestStation(p, avoid);
  const hoodOk = hood && !avoid.some((a) => a && sameArea(hood, a)) ? hood : null;
  const parts = [hoodOk, st && !(hoodOk && sameArea(hoodOk, st.name)) ? `near ${st.name.replace(/^London (?=\S+ \S)/, "")}` : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : hoodOk;
}

/** Remove a typed area from user-visible text without leaving a placeholder: "(near X station)" clauses go,
 *  "near X" becomes "nearby", any other mention becomes "the area". */
export function scrubArea(text: string, area: string | null | undefined): string {
  if (!text || !mentionsArea(text, area)) return text;
  const name = area!.replace(/\(approx\.?\)/i, "").replace(/^[~\s]+|\s+$/g, "");
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s*&\s*|\s+and\s+/gi, "\\s*(?:&|and)\\s*").replace(/\s+/g, "\\s+");
  return text
    .replace(new RegExp(`\\s*\\((?:near\\s+)?~?${esc}(?:\\s+station)?\\)`, "gi"), "")
    .replace(new RegExp(`\\bnear\\s+~?${esc}(?:\\s+station)?`, "gi"), "nearby")
    .replace(new RegExp(`~?\\b${esc}\\b`, "gi"), "the area")
    .replace(/\s+/g, " ")
    .trim();
}

/** Every string value in a JSON-ish object (for the no-placeholder check). */
export function allStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) allStrings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) allStrings(x, out);
  return out;
}
