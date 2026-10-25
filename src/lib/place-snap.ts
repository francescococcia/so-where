// "Snap a place": Gemini reads a shop front / pub sign into {name, kind, signText, cuisine, confidence}, then the
// venue is matched in MongoDB Atlas (OSM snapshot): with your location, $geoNear ≤ 300 m + fuzzy name; without it,
// Atlas Search by name across London (several same-name places → candidates and "which area?").
// The result is one card shaped like a plan card (hours evaluated for now, blurb via blurb.ts).
// Privacy: the image, its text, your location and any typed area are never stored or logged.
import type { Db } from "mongodb";
import snapshot from "@/data/osm-snapshot.json";
import { buildBlurb, type Blurb, type BlurbDeps } from "@/lib/blurb";
import { nameScore } from "@/lib/destination";
import { matchPlace } from "@/lib/gazetteer";
import { IN_LONDON, metresBetween } from "@/lib/geo";
import { londonDayShort } from "@/lib/london-time";
import { visionGenerate } from "@/lib/vision";
import { getDb, withTimeout } from "@/lib/mongo";
import { VENUES_SEARCH_INDEX, type VenueDoc } from "@/lib/mongo-seed";
import { findVenues } from "@/lib/mongo-venues";
import { resolveLandmark, type Landmark } from "@/lib/landmark";
import { addressOf, hoursAt, kindLabel, type OsmKind } from "@/lib/osm";
import type { PlanCardWithHours } from "@/lib/plan";
import type { Fact, LatLng } from "@/lib/plan-types";
import { PosterError } from "@/lib/poster";
import { venueArea } from "@/lib/venue-area";

export type SnapKind = "pub" | "cafe" | "restaurant" | "bar" | "shop" | "other";
/** What the photo itself shows about the place: tags only for things visible (cosy, busy, terrace, outdoor seating, dog-friendly …),
 *  line ≤90 chars. Never ratings or claims the photo can't show. null when nothing is visible beyond the sign. */
export type SnapVibe = { tags: string[]; line: string };
/** A recognisable building / landmark (university, museum, station, church, famous building), from its architecture
 *  as well as any text. null when it's not one (or the model can't tell). */
export type SnapLandmark = { name: string; confidence: number };
export type SnapExtract = { name: string | null; kind: SnapKind; signText: string | null; cuisine: string | null; confidence: number; vibe: SnapVibe | null; landmark: SnapLandmark | null };
/** A plan-style card for the snapped place, plus flat lat/lng/address and the /api/photo lookup for it. */
/** opensAt: London "HH:MM" of the next opening when closed now (null when open/unknown/no opening in 7 days);
 *  opensDay: short day ("Mon") when that opening is not today, else null. */
export type SnapCard = Omit<PlanCardWithHours, "kind"> & { /** "landmark": a recognised building, not a venue: hoursKnown false, no Open fact. */ kind: PlanCardWithHours["kind"] | "landmark"; lat: number; lng: number; address: string | null; opensAt: string | null; opensDay: string | null; photoQuery: string };
export type SnapCandidate = { id: string; name: string; lat: number; lng: number; address: string | null; area: string | null; suggestedQuery: string };
export type PlaceSnapResponse = {
  extracted: SnapExtract;
  place?: SnapCard;
  candidates?: SnapCandidate[];
  message?: string;
  suggestedQuery: string | null;
  /** Landmark snaps: "Coffee near <name>" (find somewhere nearby instead of meeting at the landmark itself). */
  nearbyQuery?: string;
  /** Vision model that read the photo ("test-fixture" under the eval hook). */
  model: string;
};

const KINDS: SnapKind[] = ["pub", "cafe", "restaurant", "bar", "shop", "other"];
const S = { type: "STRING", nullable: true };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    name: S,
    kind: { type: "STRING", enum: KINDS },
    signText: S,
    cuisine: S,
    confidence: { type: "NUMBER" },
    vibe: { type: "OBJECT", nullable: true, properties: { tags: { type: "ARRAY", items: { type: "STRING" } }, line: { type: "STRING" } }, required: ["tags", "line"] },
    landmark: { type: "OBJECT", nullable: true, properties: { name: { type: "STRING" }, confidence: { type: "NUMBER" } }, required: ["name", "confidence"] },
  },
  required: ["kind", "confidence"],
  propertyOrdering: ["name", "kind", "signText", "cuisine", "confidence", "vibe", "landmark"],
};
const PROMPT = [
  "This photo shows a place in London: a shop front, pub sign, café or restaurant front, its sign, or the inside of one. Fill the JSON fields.",
  `name: the place's name as on the sign, in normal capitalisation ("THE KINGS ARMS" → "The Kings Arms"); not a brand on an awning ad, not a street name. null if no name is readable.`,
  `kind: pub | cafe | restaurant | bar | shop | other (other = not a venue). If the photo is taken inside a place, kind is what the room looks like (coffee counter → cafe, beer taps → pub). signText: only text actually on a sign (or, indoors, a brand on a banner, menu board or cups), exactly as printed, one line; not dates, times, captions, on-screen or overlay text unless clearly part of the sign. cuisine: e.g. "thai", "italian", "coffee" if the sign shows it, else null.`,
  "confidence 0–1 for how sure you are of the name. Never invent a name.",
  `landmark: if the photo shows a recognisable building or landmark in London (a university, museum, gallery, station, church or cathedral, palace, bridge, famous building), recognised from its architecture as well as any text: {name: its usual full name ("Old Royal Naval College", "University of Greenwich", "St Paul's Cathedral"), confidence 0–1}. Also when the photo is of a screen or a print showing it. null for ordinary shops, pubs, cafés and restaurants, or if you can't tell.`,
  `vibe: only what is VISIBLE in this photo. tags: up to 5 short lowercase tags such as "cosy", "busy", "quiet", "terrace", "outdoor seating", "dog-friendly" (only if a dog/bowl/sign is visible), "flower baskets", "candlelit", "big windows". line: one plain sentence ≤90 characters describing what the photo shows ("Corner pub with hanging baskets and a few tables outside"). No ratings, stars, prices, opinions of quality, or anything you can't see: don't infer tags from words on a sign (a "beer garden" sign isn't visible outdoor seating). null if nothing beyond the sign is visible.`,
].join("\n");

const str = (v: unknown, max = 120) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
export function cleanSnap(raw: unknown): SnapExtract {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const conf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0;
  return { name: str(o.name, 80), kind: KINDS.find((k) => k === o.kind) ?? "other", signText: str(o.signText, 160), cuisine: str(o.cuisine, 30)?.toLowerCase() ?? null, confidence: Math.round(conf * 100) / 100, vibe: cleanVibe(o.vibe), landmark: cleanLandmark(o.landmark) };
}
export function cleanLandmark(v: unknown): SnapLandmark | null {
  const o = v && typeof v === "object" ? (v as { name?: unknown; confidence?: unknown }) : null;
  const name = str(o?.name, 80);
  if (!o || !name || name.length < 3) return null;
  const c = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0;
  return { name, confidence: Math.round(c * 100) / 100 };
}

// Ratings / quality claims a photo can't support.
const RATING = /\b(?:rated|ratings?|reviews?|stars?|michelin|award|best|top[- ]rated|must[- ]visit|famous|popular|\d(?:\.\d)?\s*\/\s*(?:5|10))\b|★|⭐/i;
export function cleanVibe(v: unknown): SnapVibe | null {
  const o = v && typeof v === "object" ? (v as { tags?: unknown; line?: unknown }) : null;
  if (!o) return null;
  const tags = (Array.isArray(o.tags) ? o.tags : [])
    .map((t) => str(t, 24)?.toLowerCase().replace(/[^a-z\s'-]/g, "").trim() ?? "")
    .filter((t, i, a) => t.length >= 3 && !RATING.test(t) && a.indexOf(t) === i)
    .slice(0, 5);
  let line = str(o.line, 140) ?? "";
  if (RATING.test(line) || /\d/.test(line)) line = "";
  if (line.length > 90) line = line.slice(0, 90).replace(/\s+\S*$/, "");
  line = line.replace(/[.!\s]+$/, "");
  return tags.length || line ? { tags, line } : null;
}

export type SnapExtractor = (img: { mime: string; base64: string }, timeoutMs: number) => Promise<Partial<SnapExtract> & Pick<SnapExtract, "kind" | "confidence">>;
let OVERRIDE: SnapExtractor | null = null;
/** Test hook (evals): replace the Gemini reader with a fixture. null restores it. */
export function setSnapExtractorForTests(fn: SnapExtractor | null) {
  OVERRIDE = fn;
}
export const snapReaderReady = () => !!OVERRIDE || !!process.env.GEMINI_API_KEY;

/** Gemini vision → SnapExtract. Throws PosterError with a user-facing message (never the image or its text). */
export async function extractSnap(img: { mime: string; base64: string }, timeoutMs = 11_000, onModel?: (model: string) => void): Promise<SnapExtract> {
  if (OVERRIDE) {
    onModel?.("test-fixture");
    return cleanSnap(await OVERRIDE(img, timeoutMs));
  }
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new PosterError(503, "Photo reading isn't switched on here yet. Type the place name instead.");
  let res: Response;
  let model: string;
  try {
    ({ res, model } = await visionGenerate({
      contents: [{ role: "user", parts: [{ inline_data: { mime_type: img.mime, data: img.base64 } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: "low" } },
    }, key, timeoutMs));
    onModel?.(model);
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new PosterError(timeout ? 504 : 502, timeout ? "Reading the sign took too long. Try again, or a closer photo." : "Couldn't reach the photo reader. Try again in a moment.");
  }
  if (!res.ok) throw new PosterError(res.status === 400 ? 422 : 502, res.status === 400 ? "That image couldn't be read. Try a JPEG or PNG photo." : `The photo reader is unavailable right now (${res.status}). Try again shortly.`);
  const j = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  try {
    return cleanSnap(JSON.parse(text));
  } catch {
    throw new PosterError(502, "Couldn't make sense of that photo. Try again with the sign filling the frame.");
  }
}

/** ~100 m: 3 decimals (≈110 m north–south, ≈70 m east–west in London). Only valid points in London. */
export function roundYou(p: unknown): LatLng | null {
  const o = p && typeof p === "object" ? (p as { lat?: unknown; lng?: unknown }) : null;
  const lat = Number(o?.lat);
  const lng = Number(o?.lng);
  if (!o || !Number.isFinite(lat) || !Number.isFinite(lng) || !IN_LONDON({ lat, lng })) return null;
  return { lat: Math.round(lat * 1000) / 1000, lng: Math.round(lng * 1000) / 1000 };
}

/** "The King's Arms" ≈ "Kings Arms" ≈ "THE KINGS ARMS"; "Fish & Chips" ≈ "Fish and Chips". */
export const snapNameScore = (a: string, b: string) => nameScore(a, b);

type Venue = { id: string; name: string; location: LatLng; tags: Record<string, string>; category: string };
const NEAR_M = 300;
const SLACK_M = 80; // the ~100 m rounding of your location
const MATCH = 0.8;
const KIND_CATS: Record<SnapKind, string[]> = { pub: ["pub", "bar", "biergarten"], bar: ["bar", "pub", "biergarten"], cafe: ["cafe"], restaurant: ["restaurant", "fast_food", "cafe"], shop: [], other: [] };

const fromDoc = (d: VenueDoc): Venue => ({ id: `osm-${d.osmType}-${d.osmId}`, name: d.name ?? "", location: { lat: d.location.coordinates[1], lng: d.location.coordinates[0] }, tags: d.osm_tags ?? { name: d.name ?? "" }, category: d.category });
type SnapEl = { type: string; id: number; lat: number; lng: number; tags: Record<string, string> };
const snapVenues = (): Venue[] =>
  (snapshot as unknown as { elements: SnapEl[] }).elements.filter((e) => e.tags?.name).map((e) => ({ id: `osm-${e.type}-${e.id}`, name: e.tags.name, location: { lat: e.lat, lng: e.lng }, tags: e.tags, category: e.tags.amenity ?? e.tags.tourism ?? "place" }));

export type SnapDeps = { db?: Db | null; blurb?: BlurbDeps; now?: Date };

/** Venues within `radiusM` of `at` (Atlas $geoNear; the bundled snapshot when Mongo is unavailable). */
async function venuesNear(at: LatLng, radiusM: number, db: Db | null): Promise<{ rows: Venue[]; via: string }> {
  if (db) {
    try {
      const docs = await withTimeout(
        db.collection<VenueDoc>("venues").aggregate<VenueDoc>([
          { $geoNear: { near: { type: "Point", coordinates: [at.lng, at.lat] }, distanceField: "distanceM", maxDistance: radiusM, spherical: true, query: { name: { $ne: null } } } },
          { $limit: 150 },
        ], { maxTimeMS: 2000 }).toArray(),
        2500,
        "place-snap geoNear",
      );
      if (docs.length) return { rows: docs.map(fromDoc), via: "MongoDB Atlas $geoNear" };
    } catch {
      /* fall through */
    }
  }
  return { rows: snapVenues().filter((v) => metresBetween(v.location, at) <= radiusM), via: "OSM snapshot" };
}

/** Same-name venues across London (Atlas Search, fuzzy; the bundled snapshot when Mongo is unavailable). */
async function venuesNamed(name: string, db: Db | null): Promise<{ rows: Venue[]; via: string }> {
  if (db) {
    try {
      const docs = await withTimeout(
        db.collection<VenueDoc>("venues").aggregate<VenueDoc>([
          { $search: { index: VENUES_SEARCH_INDEX, compound: { must: [{ text: { query: name, path: "name", fuzzy: { maxEdits: 1, prefixLength: 2 } } }], filter: [{ geoWithin: { circle: { center: { type: "Point", coordinates: [-0.1276, 51.5072] }, radius: 30000 }, path: "location" } }] } } },
          { $limit: 25 },
        ], { maxTimeMS: 2000 }).toArray(),
        2500,
        "place-snap name search",
      );
      const rows = docs.map(fromDoc).filter((v) => snapNameScore(name, v.name) >= MATCH);
      if (rows.length) return { rows, via: "MongoDB Atlas Search" };
    } catch {
      /* fall through */
    }
  }
  return { rows: snapVenues().filter((v) => snapNameScore(name, v.name) >= MATCH), via: "OSM snapshot" };
}

const fact = (label: string, value: string, verdict: Fact["verdict"], source: string, asOf?: string): Fact => ({ label, value, verdict, source, ...(asOf ? { asOf } : {}) });
const fullAddress = (t: Record<string, string>) => [[t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), t["addr:postcode"]].filter(Boolean).join(", ") || null;
/** "Meet at <name>" (plus street + postcode when London has several of that name, so destination.ts pins the right one). */
const meetQuery = (v: Venue, ambiguous: boolean) => {
  const a = ambiguous ? fullAddress(v.tags) : null;
  return `Meet at ${v.name}${a ? `, ${a}` : ""}`;
};
const candidateOf = (v: Venue, ambiguous: boolean): SnapCandidate => ({ id: v.id, name: v.name, lat: v.location.lat, lng: v.location.lng, address: addressOf(v.tags), area: venueArea(v.tags, v.location), suggestedQuery: meetQuery(v, ambiguous) });

/** The plan-style card, with opening hours evaluated for now and a blurb (blurb.ts rules: no address restating). */
export async function snapCard(v: Venue, now: Date, blurbDeps: BlurbDeps = {}, why = "The place in your photo.", matched?: Fact, vibe?: SnapVibe | null): Promise<SnapCard> {
  const h = hoursAt(v.tags, now, v.location);
  const soon = h.state === "open" && h.closesInMin != null && h.closesInMin < 60;
  const addr = addressOf(v.tags);
  const area = venueArea(v.tags, v.location);
  const facts: Fact[] = [fact(`Open ${londonDayShort(now)}`, soon ? `${h.value} · closes within the hour` : h.value, h.verdict, "OSM")];
  if (matched) facts.push(matched);
  if (v.tags.cuisine) facts.push(fact("Cuisine", v.tags.cuisine.replace(/[_;]/g, (c) => (c === ";" ? ", " : " ")), "likely", "OSM"));
  if (v.tags.wheelchair) facts.push(fact("Step-free", v.tags.wheelchair === "yes" ? "Yes (OSM)" : v.tags.wheelchair === "no" ? "No (OSM)" : "Partly (OSM)", "likely", "OSM"));
  const [, type, id] = v.id.split("-");
  const url = v.tags.website ?? v.tags["contact:website"] ?? `https://www.openstreetmap.org/${type}/${id}`;
  const blurb: Blurb | null = await buildBlurb({ id: v.id, name: v.name, kind: kindLabel(v.tags), tags: v.tags, location: v.location, area, closesAt: h.closesAt ?? null, url, ...(vibe ? { photo: vibe } : {}) }, "friends", blurbDeps).catch(() => null);
  const pq = new URLSearchParams({ name: v.name, lat: String(v.location.lat), lng: String(v.location.lng), osm: v.id });
  if (v.tags.wikidata) pq.set("wikidata", v.tags.wikidata);
  if (v.tags.wikimedia_commons) pq.set("commons", v.tags.wikimedia_commons);
  if (v.tags.image) pq.set("image", v.tags.image);
  return {
    id: v.id,
    kind: "venue",
    name: v.name,
    subtitle: [kindLabel(v.tags), addr].filter(Boolean).join(" · "),
    ...(area ? { area } : {}),
    location: v.location,
    lat: v.location.lat,
    lng: v.location.lng,
    address: addr,
    legs: [],
    facts,
    why,
    url,
    openAtPlan: h.state === "unknown" ? null : h.state === "open",
    closesAt: h.closesAt ?? null,
    closingSoon: soon,
    opensAt: h.state === "closed" ? h.opensAt ?? null : null,
    opensDay: h.state === "closed" && h.opensInMin != null && londonDayShort(new Date(now.getTime() + h.opensInMin * 60_000)) !== londonDayShort(now) ? londonDayShort(new Date(now.getTime() + h.opensInMin * 60_000)) : null,
    hoursKnown: h.state !== "unknown",
    ...(blurb ? { blurb } : {}),
    photoQuery: `/api/photo?${pq.toString()}`,
  };
}

/** A recognised landmark as a card: no hours (hoursKnown false, no Open fact), area + address, strict Wikipedia blurb. */
export async function landmarkCard(l: Landmark, blurbDeps: BlurbDeps = {}): Promise<SnapCard> {
  const area = venueArea({ name: l.name }, l.location);
  const url = l.tags.wikipedia ? `https://en.wikipedia.org/wiki/${encodeURIComponent(l.tags.wikipedia.slice(3).replace(/ /g, "_"))}` : l.tags.wikidata ? `https://www.wikidata.org/wiki/${l.tags.wikidata}` : l.id?.startsWith("osm-") ? `https://www.openstreetmap.org/${l.id.split("-")[1]}/${l.id.split("-")[2]}` : undefined;
  const id = l.id ?? `landmark-${l.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}`;
  // Landmark kind → blurb.ts' strict match: the Wikipedia article must be this name and within 300 m.
  const blurb: Blurb | null = await buildBlurb({ id, name: l.name, kind: "Landmark", tags: l.tags, location: l.location, area, closesAt: null, ...(url ? { url } : {}) }, "friends", blurbDeps).catch(() => null);
  const pq = new URLSearchParams({ name: l.name, lat: String(l.location.lat), lng: String(l.location.lng) });
  if (l.id?.startsWith("osm-")) pq.set("osm", l.id);
  if (l.tags.wikidata) pq.set("wikidata", l.tags.wikidata);
  return {
    id,
    kind: "landmark",
    name: l.name,
    subtitle: ["Landmark", l.address].filter(Boolean).join(" · "),
    ...(area ? { area } : {}),
    location: l.location,
    lat: l.location.lat,
    lng: l.location.lng,
    address: l.address,
    legs: [],
    facts: [fact("Located", `${l.how} (recognised from the photo)`, "likely", l.source, l.asOf)],
    why: "The landmark in your photo.",
    ...(url ? { url } : {}),
    openAtPlan: null,
    closesAt: null,
    closingSoon: false,
    opensAt: null,
    opensDay: null,
    hoursKnown: false,
    ...(blurb ? { blurb } : {}),
    photoQuery: `/api/photo?${pq.toString()}`,
  };
}
export const LANDMARK_MIN = 0.6;
/** "That's the University of Greenwich. Meet here, or find somewhere nearby?" */
export const landmarkMessage = (name: string) => `That's ${/^the\s/i.test(name) ? "" : "the "}${name}. Meet here, or find somewhere nearby?`;
// The model read a landmark-like name ("UNIVERSITY OF GREENWICH") but left `landmark` null: when no venue
// matches, try that name as a landmark too (the resolver still needs a ≥0.8 name match inside London).
const LANDMARK_WORDS = /\b(university|college|museum|gallery|cathedral|church|abbey|chapel|station|palace|tower|bridge|castle|observatory|library|theatre|hall|eye|market|monument|stadium|arena)\b/i;
export function nameAsLandmark(x: SnapExtract): SnapLandmark | null {
  const n = (x.name ?? x.signText ?? "").replace(/\s+/g, " ").trim();
  if (n.length < 3 || n.length > 80 || !LANDMARK_WORDS.test(n) || x.kind === "pub" || x.kind === "cafe" || x.kind === "restaurant" || x.kind === "bar") return null;
  const name = n === n.toUpperCase() ? n.toLowerCase().replace(/\b(\w)(\w*)/g, (_, a: string, b: string) => (/^(of|the|and|in|at)$/.test(a + b) ? a + b : a.toUpperCase() + b)).replace(/^./, (c) => c.toUpperCase()) : n;
  return { name, confidence: 0.7 };
}

async function landmarkSnap(extracted: SnapExtract, base: { extracted: SnapExtract; suggestedQuery: null }, blurbDeps: BlurbDeps, budgetMs: number): Promise<Omit<PlaceSnapResponse, "model"> | null> {
  const lm = extracted.landmark ?? nameAsLandmark(extracted);
  if (!lm || lm.confidence < LANDMARK_MIN || budgetMs < 1500) return null;
  const l = await resolveLandmark(lm.name, { budgetMs: Math.min(6000, budgetMs - 1000) }).catch(() => null);
  if (!l) return null;
  const place = await landmarkCard(l, { ...blurbDeps, budgetMs: Math.max(800, Math.min(blurbDeps.budgetMs ?? 3200, budgetMs - 500)) });
  return { ...base, place, message: landmarkMessage(l.name), suggestedQuery: `Meet at ${l.name}`, nearbyQuery: `Coffee near ${l.name}` };
}

const NO_MATCH = "Couldn't spot that one — where are you?";
export const NO_NAME_NEARBY = "Can't see a name. Is it one of these nearby?";
export const NO_NAME_WHERE = "Can't see a name. Where are you?";
const NO_NAME_M = 250;
/** Photo vibe tag → OSM tags that back it up (only tags OSM actually has). */
const VIBE_TAGS: [RegExp, (t: Record<string, string>) => boolean][] = [
  [/outdoor|terrace|tables outside|pavement/, (t) => t.outdoor_seating === "yes"],
  [/garden/, (t) => t.beer_garden === "yes" || t.garden === "yes" || t.outdoor_seating === "yes"],
  [/coffee|espresso|barista|latte/, (t) => t.amenity === "cafe" || /coffee/.test(t.cuisine ?? "")],
  [/taps?|real ale|beer|pints?|bar stools?/, (t) => t.amenity === "pub" || t.amenity === "bar" || t.real_ale === "yes"],
  [/dog/, (t) => t.dog === "yes"],
  [/laptops?|wi-?fi|cowork|desks?/, (t) => !!t.internet_access && t.internet_access !== "no"],
];
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !STOP.has(w));
const STOP = new Set(["coffee", "open", "welcome", "london", "the", "and", "with", "from", "this", "that", "your", "free", "wifi", "menu", "today"]);
/** Nothing in Atlas / the snapshot that close: the plan's venue finder (live Overpass → snapshot), by kind. */
async function liveNear(at: LatLng, kind: SnapKind, budgetMs: number): Promise<Venue[]> {
  const kinds: OsmKind[] = kind === "cafe" ? ["cafe"] : kind === "pub" || kind === "bar" ? ["pub"] : kind === "restaurant" ? ["restaurant"] : ["cafe", "pub", "restaurant"];
  try {
    const res = await withTimeout(Promise.all(kinds.map((k) => findVenues(k, at, NO_NAME_M))), budgetMs, "place-snap nearby");
    return res.flatMap((r) => r.places).filter((p) => p.tags.name).map((p) => ({ id: `osm-${p.type}-${p.id}`, name: p.tags.name, location: p.location, tags: p.tags, category: p.tags.amenity ?? "place" }));
  } catch {
    return [];
  }
}
/** Unnamed photo: venues near `at` ranked by visible text on brand/name/operator, kind, vibe ↔ OSM tags, then distance. */
export function rankUnnamed(rows: Venue[], x: SnapExtract, at: LatLng): Venue[] {
  const sign = new Set(words(x.signText ?? ""));
  const vibe = (x.vibe?.tags ?? []).concat(x.vibe?.line ? [x.vibe.line.toLowerCase()] : []).concat(x.cuisine ? [x.cuisine] : []);
  const score = (v: Venue) => {
    const own = new Set(words([v.name, v.tags.brand, v.tags.operator, v.tags["name:en"], v.tags.alt_name].filter(Boolean).join(" ")));
    const text = [...sign].filter((w) => own.has(w)).length * 5;
    const kind = KIND_CATS[x.kind].includes(v.category) ? 3 : 0;
    const fit = VIBE_TAGS.filter(([re, has]) => vibe.some((t) => re.test(t)) && has(v.tags)).length;
    const cu = x.cuisine && (v.tags.cuisine ?? "").toLowerCase().includes(x.cuisine) ? 2 : 0;
    return text + kind + fit + cu;
  };
  const seen = new Set<string>();
  return rows
    .filter((v) => v.name && metresBetween(v.location, at) <= NO_NAME_M)
    .map((v) => ({ v, s: score(v), d: metresBetween(v.location, at) }))
    .sort((a, b) => b.s - a.s || a.d - b.d)
    .map((r) => r.v)
    .filter((v) => !seen.has(v.id) && !!seen.add(v.id));
}
const distinct = (rows: Venue[]) => rows.filter((v, i) => !rows.slice(0, i).some((w) => metresBetween(w.location, v.location) < 150));
const kindFirst = (kind: SnapKind) => (v: Venue) => (KIND_CATS[kind].includes(v.category) ? 0 : 1);

/** Extract → match → card. `you` is already rounded; `area` is a typed neighbourhood (follow-up to "which area?"). */
export async function snapPlace(extracted: SnapExtract, opts: { you?: LatLng | null; area?: string | null; budgetMs?: number }, deps: SnapDeps = {}): Promise<Omit<PlaceSnapResponse, "model">> {
  const t0 = Date.now();
  const now = deps.now ?? new Date();
  const base = { extracted, suggestedQuery: null };
  const areaAt = opts.area ? matchPlace(opts.area) : null;
  const near = opts.you ?? (areaAt && areaAt.confidence !== "low" && areaAt.best ? areaAt.best.entry.location : null);
  const left = () => (opts.budgetMs ?? 14_000) - (Date.now() - t0);
  if (!extracted.name || extracted.confidence < 0.3) {
    // No venue name, but a recognised building (university, museum, station…): place it and offer "meet here / nearby".
    const lm = await landmarkSnap(extracted, base, deps.blurb ?? {}, left());
    if (lm) return lm;
    // Indoors / no readable name: rank what's right around you (or the area you gave) by the kind of place,
    // the photo's vibe and any visible text (brands on banners, cups), and ask which one it is.
    if (!near) return { ...base, message: NO_NAME_WHERE };
    const db0 = deps.db !== undefined ? deps.db : await getDb(1500);
    let { rows } = await venuesNear(near, NO_NAME_M, db0);
    if (!rows.length) rows = await liveNear(near, extracted.kind, Math.max(1500, (opts.budgetMs ?? 14_000) - (Date.now() - t0) - 4000));
    const ranked = rankUnnamed(rows, extracted, near);
    if (!ranked.length) return { ...base, message: "Can't see a name, and I don't know any places right there. Try a photo of the sign outside, or type the name." };
    const top = ranked.slice(0, 3);
    return { ...base, candidates: top.map((v) => candidateOf(v, ranked.filter((w) => w.name === v.name).length > 1 || snapVenues().filter((w) => w.name === v.name).length > 1)), message: NO_NAME_NEARBY };
  }
  const name = extracted.name;
  const db = deps.db !== undefined ? deps.db : await getDb(1500);
  const blurbDeps: BlurbDeps = { ...deps.blurb, budgetMs: Math.max(800, Math.min(deps.blurb?.budgetMs ?? 3200, (opts.budgetMs ?? 14_000) - (Date.now() - t0) - 500)) };
  const score = (v: Venue) => snapNameScore(name, v.name);

  if (near) {
    const radius = opts.you ? NEAR_M + SLACK_M : 1500;
    const { rows, via } = await venuesNear(near, radius, db);
    const hits = rows
      .map((v) => ({ v, s: score(v), d: metresBetween(v.location, near) }))
      .filter((x) => x.s >= MATCH)
      .sort((a, b) => b.s - a.s || kindFirst(extracted.kind)(a.v) - kindFirst(extracted.kind)(b.v) || a.d - b.d);
    if (hits.length) {
      const v = hits[0].v;
      const place = await snapCard(v, now, blurbDeps, `The place in your photo: the name on the sign, ${opts.you ? "right by you" : "in the area you gave"}.`, fact("Matched", `Name on the sign, ${opts.you ? "within ~300 m of you" : "in the area you gave"}`, hits[0].s >= 0.95 ? "confirmed" : "likely", via), extracted.vibe);
      const others = distinct(hits.slice(1).map((h) => h.v)).filter((w) => metresBetween(w.location, v.location) >= 150);
      return { ...base, place, ...(others.length ? { candidates: others.slice(0, 3).map((w) => candidateOf(w, true)) } : {}), suggestedQuery: meetQuery(v, others.length > 0), ...(extracted.confidence < 0.5 ? { message: `Not fully sure I read the sign right: is it ${v.name}?` } : {}) };
    }
  }
  // No location (or nothing that name close by): search London by name.
  const { rows, via: byName } = await venuesNamed(name, db);
  const all = distinct(rows.sort((a, b) => score(b) - score(a) || kindFirst(extracted.kind)(a) - kindFirst(extracted.kind)(b)));
  if (!all.length) {
    const lm = await landmarkSnap(extracted, base, blurbDeps, left());
    if (lm) return lm;
  }
  if (!all.length) return { ...base, message: near ? "Couldn't spot that one around there. Try a closer photo of the sign, or type the name." : NO_MATCH };
  const ranked = near ? [...all].sort((a, b) => metresBetween(a.location, near) - metresBetween(b.location, near)) : all;
  if (ranked.length === 1) {
    // A single candidate is a match (the UI treats it as one), so return it as the place.
    const v = ranked[0];
    const where = venueArea(v.tags, v.location);
    return {
      ...base,
      place: await snapCard(v, now, blurbDeps, "The place in your photo: the only one of that name in London.", fact("Matched", "Name on the sign, the only one in London", "likely", byName), extracted.vibe),
      suggestedQuery: meetQuery(v, false),
      ...(near ? { message: `Couldn't spot ${name} right there; the only one I know is${where ? ` in ${where}` : " further away"}.` } : {}),
    };
  }
  const n = ranked.length;
  return {
    ...base,
    candidates: ranked.slice(0, 3).map((v) => candidateOf(v, n > 1)),
    message: near
      ? `Couldn't spot ${name} right there: is it one of these?`
      : `There are ${n} places called ${name} in London: which area are you in?`,
  };
}
