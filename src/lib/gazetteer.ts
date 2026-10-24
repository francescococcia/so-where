// Local London gazetteer: every station in Greater London (src/data/stations.json, from TfL), common
// neighbourhood names mapped to a representative station, and everyday aliases ("kings x", "tcr").
// Sloppy typed places are matched here before TfL search: normalise, then edit distance + trigram scoring,
// so "liverpolstreet" → Liverpool Street, "camdn" → Camden Town, "greenwich" → Greenwich.
import stationsDoc from "@/data/stations.json";
import type { LatLng } from "@/lib/plan-types";

export type Station = { name: string; id: string; lat: number; lng: number; modes: string[] };
export type GazEntry = { name: string; id: string | null; location: LatLng; modes: string[]; kind: "station" | "area" | "alias" };
export type GazMatch = { entry: GazEntry; score: number; key: string };
export type GazResult = { query: string; best: GazMatch | null; top: GazMatch[]; confidence: "high" | "medium" | "low" };

const doc = stationsDoc as { fetched_at: string; source: string; stations: Station[] };
// National Rail lists termini as "London Waterloo" etc.; fold those into the same-named tube station.
const RAW_NAMES = new Set(doc.stations.map((s) => s.name));
export const STATIONS: Station[] = doc.stations.filter((s) => !(/^London /.test(s.name) && RAW_NAMES.has(s.name.replace(/^London /, ""))));
export const GAZETTEER_AS_OF = doc.fetched_at;
export const GAZETTEER_SOURCE = "TfL station list";

/** Thresholds: ≥ HIGH (and clearly ahead of the next different place) is used silently; ≥ MEDIUM asks. */
export const HIGH = 0.82;
export const MEDIUM = 0.6;

/** lowercase, & → and, saint → st, street → st, drop "station"/"underground"/punctuation/spaces. */
export function normPlace(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\([^)]*\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/\b(?:underground|tube|rail|railway|dlr|overground|elizabeth line|ell|ll)\b/g, " ")
    .replace(/\bstation\b|stn\b/g, " ")
    .replace(/\bsaint\b/g, "st")
    .replace(/street|\bstr\b/g, "st")
    .replace(/[^a-z0-9]/g, "");
}

// Display name of the station each alias / neighbourhood should land on.
const ALIASES: Record<string, string> = {
  "kings x": "King's Cross St. Pancras", "kings +": "King's Cross St. Pancras", kx: "King's Cross St. Pancras", "kings cross": "King's Cross St. Pancras",
  "st pancras": "King's Cross St. Pancras", "kings cross st pancras": "King's Cross St. Pancras", ksx: "King's Cross St. Pancras",
  "liverpool st": "Liverpool Street", lst: "Liverpool Street", "liv st": "Liverpool Street", "liverpool": "Liverpool Street",
  tcr: "Tottenham Court Road", "tottenham ct rd": "Tottenham Court Road", "oxford st": "Oxford Circus", oxford: "Oxford Circus",
  "piccadilly": "Piccadilly Circus", picc: "Piccadilly Circus", "leicester sq": "Leicester Square", leicester: "Leicester Square",
  "elephant": "Elephant & Castle", "e and c": "Elephant & Castle", ec: "Elephant & Castle", "elephant and castle": "Elephant & Castle",
  lb: "London Bridge", "ldn bridge": "London Bridge", "charing x": "Charing Cross", "canary": "Canary Wharf", "the o2": "North Greenwich", o2: "North Greenwich",
  "shepherds bush": "Shepherd's Bush", "earls court": "Earl's Court", "st jamess park": "St. James's Park", "st johns wood": "St. John's Wood",
  "highbury": "Highbury & Islington", "highbury and islington": "Highbury & Islington", "camden": "Camden Town", "angel islington": "Angel",
  "heathrow": "Heathrow Terminals 2 & 3", "paddington station": "Paddington", "euston station": "Euston", "victoria station": "Victoria", "waterloo station": "Waterloo",
};
const AREAS: Record<string, string> = {
  shoreditch: "Shoreditch High Street", "brick lane": "Shoreditch High Street", hoxton: "Hoxton", greenwich: "Greenwich", "maritime greenwich": "Cutty Sark (for Maritime Greenwich)",
  soho: "Tottenham Court Road", "covent gdn": "Covent Garden", mayfair: "Green Park", fitzrovia: "Goodge Street", bloomsbury: "Russell Square", "the city": "Bank", city: "Bank",
  "south bank": "Waterloo", southbank: "Waterloo", islington: "Angel", "upper st": "Angel", clapham: "Clapham Common", "clapham junction": "Clapham Junction", hackney: "Hackney Central",
  dalston: "Dalston Junction", peckham: "Peckham Rye", "notting hill": "Notting Hill Gate", kensington: "South Kensington", "south ken": "South Kensington", chelsea: "Sloane Square",
  fulham: "Fulham Broadway", battersea: "Battersea Power Station", tooting: "Tooting Broadway", walthamstow: "Walthamstow Central", holloway: "Holloway Road",
  wembley: "Wembley Park", docklands: "Canary Wharf", spitalfields: "Liverpool Street", farringdon: "Farringdon", clerkenwell: "Farringdon", marylebone: "Baker Street",
  westminster: "Westminster", bermondsey: "Bermondsey", southwark: "Southwark", deptford: "Deptford Bridge", woolwich: "Woolwich", bow: "Bow Road", "mile end": "Mile End",
  "bethnal green": "Bethnal Green", whitechapel: "Whitechapel", stratford: "Stratford", brixton: "Brixton", hampstead: "Hampstead", "camden town": "Camden Town",
  "kentish town": "Kentish Town", "finsbury park": "Finsbury Park", lewisham: "Lewisham", wimbledon: "Wimbledon", balham: "Balham", vauxhall: "Vauxhall", "london fields": "London Fields",
  "canada water": "Canada Water", rotherhithe: "Rotherhithe", "elephant castle": "Elephant & Castle", "white city": "White City", "kings road": "Sloane Square",
};

function buildEntries(): { key: string; entry: GazEntry }[] {
  const byName = new Map(STATIONS.map((s) => [s.name, s]));
  const out: { key: string; entry: GazEntry }[] = [];
  const add = (key: string, entry: GazEntry) => {
    const k = normPlace(key);
    if (k.length >= 2 && !out.some((x) => x.key === k && x.entry.name === entry.name)) out.push({ key: k, entry });
  };
  for (const s of STATIONS) {
    const entry: GazEntry = { name: s.name, id: s.id, location: { lat: s.lat, lng: s.lng }, modes: s.modes, kind: "station" };
    add(s.name, entry);
    if (/^London /.test(s.name)) add(s.name.replace(/^London /, ""), entry);
  }
  for (const [map, kind] of [[ALIASES, "alias"], [AREAS, "area"]] as const) {
    for (const [alias, target] of Object.entries(map)) {
      const s = byName.get(target);
      if (s) add(alias, { name: s.name, id: s.id, location: { lat: s.lat, lng: s.lng }, modes: s.modes, kind });
    }
  }
  return out;
}
const ENTRIES = buildEntries();

function lev(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}
const grams = (s: string) => {
  const p = `  ${s} `;
  const g = new Set<string>();
  for (let i = 0; i < p.length - 2; i++) g.add(p.slice(i, i + 3));
  return g;
};
function dice(a: string, b: string) {
  const A = grams(a);
  const B = grams(b);
  let n = 0;
  for (const g of A) if (B.has(g)) n++;
  return (2 * n) / (A.size + B.size);
}

/** Similarity in [0, 1] between a normalised query and a normalised key. */
export function similarity(q: string, k: string): number {
  if (q === k) return 1;
  const edit = 1 - lev(q, k) / Math.max(q.length, k.length);
  const tri = dice(q, k);
  // A typed prefix of a longer name ("tottenham" → "tottenhamcourtroad") is a decent but not certain hit.
  const prefix = q.length >= 4 && k.startsWith(q) ? 0.7 + 0.25 * (q.length / k.length) : 0;
  return Math.max(edit, tri * 0.95, prefix);
}

/** Best local matches for a typed place. High confidence = use silently; medium = ask with `top`. */
export function matchPlace(text: string, limit = 3): GazResult {
  const q = normPlace(text);
  const empty: GazResult = { query: text, best: null, top: [], confidence: "low" };
  if (q.length < 2) return empty;
  const bestByName = new Map<string, GazMatch>();
  for (const { key, entry } of ENTRIES) {
    // Very short keys (kx, lb, tcr) only count as exact matches.
    const score = key.length <= 3 || q.length <= 3 ? (key === q ? 1 : 0) : similarity(q, key);
    const prev = bestByName.get(entry.name);
    if (score > 0 && (!prev || score > prev.score)) bestByName.set(entry.name, { entry, score, key });
  }
  const ranked = [...bestByName.values()].sort((a, b) => b.score - a.score || rankMode(a.entry) - rankMode(b.entry));
  const top = ranked.slice(0, limit);
  const best = top[0] ?? null;
  if (!best) return empty;
  const margin = best.score - (top[1]?.score ?? 0);
  const confidence = best.score === 1 || (best.score >= HIGH && margin >= 0.08) ? "high" : best.score >= MEDIUM ? "medium" : "low";
  return { query: text, best, top, confidence };
}
const MODE_RANK = ["tube", "elizabeth-line", "overground", "dlr", "national-rail", "tram"];
const rankMode = (e: GazEntry) => Math.min(...e.modes.map((m) => (MODE_RANK.includes(m) ? MODE_RANK.indexOf(m) : 9)), 9);
