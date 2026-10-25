// "Get me to <event> at <venue>, <address> on Sat 31 Oct at 19:00": a fixed destination, no hub search.
// Parsing is rules-only; the place is resolved from MongoDB Atlas (OSM venue snapshot, name search), then
// OSM Nominatim, checked against a UK postcode in the address when there is one (postcodes.io).
// Nothing here is stored or logged: the typed venue/address only lives for the request.
import { matchPlace, normPlace, similarity, GAZETTEER_AS_OF, GAZETTEER_SOURCE } from "@/lib/gazetteer";
import { IN_LONDON, lookupPostcode, metresBetween } from "@/lib/geo";
import { getDb, withTimeout } from "@/lib/mongo";
import { VENUES_SEARCH_INDEX, type VenueDoc } from "@/lib/mongo-seed";
import snapshot from "@/data/osm-snapshot.json";
import type { LatLng } from "@/lib/plan-types";

export type Destination = {
  title: string | null; // event name, when the ask names one ("Jazz Night at The Vortex")
  venue: string;
  address: string | null;
  endTime: string | null; // "19:00–23:00" → "23:00"
  withThem: boolean; // "Meet halfway for …" / "get us to …"
  /** The ask minus the destination clause (day, time, where you / they are), for the normal parser. */
  rest: string;
  free: boolean;
  signUp: boolean | null; // "sign-up needed" → true, "no sign-up" → false
  priceText: string | null;
  /** Set by the planner (eventDates): the event's day(s) and whether it's still to come, on now, or over. */
  dates?: EventDates;
};

export type EventDates = { start: string; end: string | null; status: "upcoming" | "ongoing" | "past"; /** The event's own start clock from the ask (planner sets it). */ startTime?: string | null };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_MONTH_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:\s+(20\d{2}))?\b/gi;
const MONTH_DAY_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?![\d:.])(?:,?\s+(20\d{2}))?\b/gi;
const DAY_RANGE_RE = /\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:[–—-]|to|until|till)\s*(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/gi;
const iso = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const dayBefore = (a: string, days: number) => new Date(Date.parse(`${a}T12:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/** "on Fri 23 Oct until Sun 25 Oct at 12:00–16:30" → {start, end, status} against today (London).
 *  A day+month without a year is this year unless that's over two months ago (then next year), so a
 *  poster for something that just happened reads as past, not as next year. Weekday words are ignored. */
export function eventDates(text: string, today: string, nowClock?: string, endTime?: string | null): EventDates | null {
  const ty = Number(today.slice(0, 4));
  const found: string[] = [];
  // Day-first ("23 Oct"), month-first as on Luma ("Friday, October 23, 12:00 PM – Oct 25, 4:30 PM") and day ranges ("23–25 Oct").
  const hits: { at: number; d: number; mon: string; y?: string }[] = [];
  for (const m of text.matchAll(DAY_MONTH_RE)) hits.push({ at: m.index ?? 0, d: Number(m[1]), mon: m[2], y: m[3] });
  for (const m of text.matchAll(MONTH_DAY_RE)) hits.push({ at: m.index ?? 0, d: Number(m[2]), mon: m[1], y: m[3] });
  for (const m of text.matchAll(DAY_RANGE_RE)) hits.push({ at: m.index ?? 0, d: Number(m[1]), mon: m[3] }, { at: (m.index ?? 0) + 1, d: Number(m[2]), mon: m[3] });
  hits.sort((a, b) => a.at - b.at);
  for (const m of hits) {
    const d = m.d;
    const mo = MONTHS.indexOf(m.mon.slice(0, 3).toLowerCase());
    if (d < 1 || d > 31 || mo < 0) continue;
    let y = m.y ? Number(m.y) : ty;
    if (!m.y && iso(y, mo, d) < dayBefore(today, 60)) y += 1;
    let v = iso(y, mo, d);
    if (found[0] && v < found[0] && !m.y) v = iso(y + 1, mo, d); // 30 Dec – 2 Jan
    if (found[0] === v) continue; // "23 Oct" said twice
    found.push(v);
    if (found.length === 2) break;
  }
  if (!found.length) return null;
  const start = found[0];
  const end = found[1] && found[1] > start ? found[1] : null;
  const last = end ?? start;
  const over = last < today || (last === today && !!endTime && !!nowClock && nowClock >= endTime);
  // Multi-day and already started → on now (plan for today); single-day today → still to come.
  return { start, end, status: over ? "past" : end && start <= today ? "ongoing" : "upcoming" };
}

/** "2026-10-23" → "Fri 23 Oct". */
export function shortDay(isoDay: string): string {
  const d = new Date(`${isoDay}T12:00:00Z`);
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]}`;
}

const GO_TO_RE = /^\s*(?:please\s+|can you\s+|could you\s+)*(?:(?:get|take|bring|route|send|direct)\s+(me|us|me and \w+|\w+ and me)\s+to|how (?:do|can|would) (i|we) get to|directions to|meet halfway for|meet (?:up )?halfway (?:at|for)|both get to|(?:let'?s\s+)?meet (?:up )?at)\s+/i;
// The destination clause ends at the day / time / origin / sentence end.
const DEST_END_RE = /\s+(?:on\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*\b|on\s+\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3}|(?:at|from|by|for)\s+\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b|from\s+(?=[A-Z])|today\b|tonight\b|tomorrow\b|this\s+(?:mon|tue|wed|thu|fri|sat|sun|week|evening|afternoon|morning)\w*|next\s+\w+day\b|\(|[;.!?](?:\s|$))|[;!?]\s*$|\.$/i;
// Not a named place: a category / search ("a pub near Angel", "coffee", "the nearest bar") stays with the normal planner.
const GENERIC_RE = /^(?:a|an|some|any|somewhere|anywhere|anything|something|middle|halfway|nearest|closest|the (?:nearest|closest|best|middle|halfway))\b|\b(?:near|nearby|around|close to|in the area)\b/i;
const ACTIVITY_RE = /^(?:coffees?|drinks?|dinner|lunch|brunch|breakfast|food|pubs?|bars?|caf[eé]s?|restaurants?|cocktails?|beers?|pints?|tea|a bite|meeting|catch(?:ing)? up)$/i;
// "…, i'm at Bank and she's in Camden" after the comma is where people are, not the address.
const PEOPLE_RE = /\b(?:i'?m|i am|she'?s|he'?s|they'?re|we'?re|you'?re|my|me|lives?|coming from|starting)\b/i;
const POSTCODE_RE = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;

/** Rules-only: is this a "get me to <named place>" ask? */
export function parseDestination(raw: string): Destination | null {
  const q = raw.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  const m = GO_TO_RE.exec(q);
  if (!m) return null;
  const after = q.slice(m[0].length);
  const end = DEST_END_RE.exec(after);
  const clause = (end ? after.slice(0, end.index) : after).trim().replace(/[,\s]+$/, "");
  if (clause.length < 3 || clause.length > 160) return null;
  const firstComma = clause.indexOf(",");
  const head = firstComma >= 0 ? clause.slice(0, firstComma) : clause;
  const tailText = firstComma >= 0 ? clause.slice(firstComma + 1).trim() : "";
  const peopleTail = !!tailText && PEOPLE_RE.test(tailText);
  const address = tailText && !peopleTail ? tailText : null;
  const at = head.toLowerCase().lastIndexOf(" at ");
  const titleRaw = at > 0 ? head.slice(0, at).trim() : null;
  const title = titleRaw && !ACTIVITY_RE.test(titleRaw.replace(/^(?:a|an|some)\s+/i, "")) ? titleRaw : null;
  const venue = (at > 0 ? head.slice(at + 4) : head).trim().replace(/^the\s+(?=the\s)/i, "");
  if (venue.length < 2 || /^\d/.test(venue) || /^(me|home|work|here|there|you|mine|yours|my place|your place|the station)$/i.test(venue) || GENERIC_RE.test(venue) || ACTIVITY_RE.test(venue)) return null;
  const rest = `${q.slice(0, m.index)} ${peopleTail ? `${tailText}. ` : ""}${end ? after.slice(end.index) : ""}`.replace(/^\s*[.;,]\s*/, "").trim();
  // "12:00-16:30", or Luma's "12:00 PM – Oct 25, 4:30 PM" (end on a later day, 12-hour).
  const lumaT = /\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\s*[–—-]\s*(?:[a-z]{3,9}\.?\s+\d{1,2},?\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/i.exec(after);
  const endT = /\b\d{1,2}[:.]\d{2}\s*(?:–|-|to|until|till)\s*(\d{1,2})[:.](\d{2})\b/i.exec(after) ?? (lumaT ? (Object.assign([lumaT[0], String((Number(lumaT[1]) % 12) + (/pm/i.test(lumaT[3]) ? 12 : 0)), lumaT[2] ?? "00"], { index: lumaT.index }) as unknown as RegExpExecArray) : null);
  const who = (m[1] ?? m[2] ?? "").toLowerCase();
  const price = /£\s?\d+(?:\.\d{2})?(?:\s*[-–]\s*£?\s?\d+(?:\.\d{2})?)?/.exec(after);
  return {
    title: title && title.length >= 2 ? title : null,
    venue,
    address,
    endTime: endT ? `${endT[1].padStart(2, "0")}:${endT[2]}` : null,
    withThem: /halfway|both/i.test(m[0]) || who === "us" || who.includes(" and ") || (/meet/i.test(m[0]) && /\b(?:she|he|they)(?:'s| is| are|'re)\b/i.test(rest)),
    rest,
    free: /\bfree\b/i.test(after),
    signUp: /\bno (?:sign-?up|registration|rsvp|tickets? needed)\b/i.test(after) ? false : /\b(?:sign-?up|registration|rsvp|tickets?)\b(?:[^.;)]*\b(?:needed|required|essential))?/i.test(after) ? true : null,
    priceText: price ? price[0].replace(/\s+/g, "") : null,
  };
}

export type FoundPlace = { name: string; location: LatLng; address: string | null; tags: Record<string, string>; id: string | null; source: string; asOf: string; how: string; verdict: "confirmed" | "likely"; /** false: the venue itself wasn't found, only its street / area. */ pinned?: boolean };

const UA = "SoWhere/0.1 (London meet-up planner; place lookup)";
export const nameScore = (a: string, b: string) => {
  const n = (t: string) => t.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
  const x = n(a);
  const y = n(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  // Whole-word containment ("George Inn" in "The George Inn, Borough"), not "tas" inside "Blorptastic".
  const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
  if (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `)) return ratio >= 0.5 ? 0.8 + 0.15 * ratio : 0.6;
  return similarity(normPlace(x), normPlace(y));
};

async function atlasByName(name: string, near: LatLng | null): Promise<FoundPlace | null> {
  try {
    const db = await getDb(1500);
    if (!db) return null;
    const center = near ?? { lat: 51.5072, lng: -0.1276 };
    const rows = await withTimeout(
      db.collection<VenueDoc>("venues").aggregate<VenueDoc & { score: number }>([
        { $search: { index: VENUES_SEARCH_INDEX, compound: { must: [{ text: { query: name, path: "name", fuzzy: { maxEdits: 1, prefixLength: 2 } } }], filter: [{ geoWithin: { circle: { center: { type: "Point", coordinates: [center.lng, center.lat] }, radius: near ? 2000 : 30000 }, path: "location" } }] } } },
        { $limit: 8 },
        { $addFields: { score: { $meta: "searchScore" } } },
      ], { maxTimeMS: 2000 }).toArray(),
      2500,
      "venue name search",
    );
    const best = rows.map((d) => ({ d, s: nameScore(name, d.name ?? "") })).filter((x) => x.s >= 0.8).sort((a, b) => b.s - a.s || b.d.score - a.d.score)[0];
    if (!best) return null;
    const d = best.d;
    const [lng, lat] = d.location.coordinates;
    const tags: Record<string, string> = { name: d.name ?? name };
    for (const k of ["amenity", "tourism", "opening_hours", "check_date", "fee", "wheelchair", "website"] as const) if (d[k]) tags[k] = String(d[k]);
    return { name: d.name ?? name, location: { lat, lng }, address: d.address, tags, id: `osm-${d.osmType}-${d.osmId}`, source: "MongoDB Atlas (OSM snapshot)", asOf: new Date().toISOString(), how: "Atlas Search name match", verdict: "confirmed" };
  } catch {
    return null;
  }
}

/** Same OSM venues as Atlas, from the bundled snapshot (when Mongo isn't reachable). */
function snapshotByName(name: string, near: LatLng): FoundPlace | null {
  const snap = snapshot as { fetched_at: string; elements: { type: string; id: number; lat: number; lng: number; tags: Record<string, string> }[] };
  const best = snap.elements
    .filter((e) => e.tags.name)
    .map((e) => ({ e, s: nameScore(name, e.tags.name) }))
    .filter((x) => x.s >= 0.8)
    .sort((a, b) => b.s - a.s || metresBetween(a.e, near) - metresBetween(b.e, near))[0];
  if (!best) return null;
  const e = best.e;
  const addr = [[e.tags["addr:housenumber"], e.tags["addr:street"]].filter(Boolean).join(" "), e.tags["addr:postcode"]].filter(Boolean).join(", ") || null;
  return { name: e.tags.name, location: { lat: e.lat, lng: e.lng }, address: addr, tags: e.tags, id: `osm-${e.type}-${e.id}`, source: "OSM snapshot", asOf: snap.fetched_at, how: "OSM snapshot name match", verdict: "confirmed" };
}

type NomRow = { lat: string; lon: string; name?: string; display_name?: string; osm_type?: string; osm_id?: number; category?: string; type?: string; extratags?: Record<string, string> | null; address?: Record<string, string> };
async function nominatim(name: string, address: string | null, near: LatLng): Promise<FoundPlace | null> {
  const q = [name, address ?? "London"].join(", ");
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=gb&viewbox=-0.52,51.70,0.34,51.28&bounded=1&extratags=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "en-GB" }, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const rows = (await r.json()) as NomRow[];
    const best = rows.map((x) => ({ x, s: x.name ? nameScore(name, x.name) : 0 })).sort((a, b) => (Math.abs(b.s - a.s) > 0.05 ? b.s - a.s : 0) || metresBetween({ lat: +a.x.lat, lng: +a.x.lon }, near) - metresBetween({ lat: +b.x.lat, lng: +b.x.lon }, near))[0];
    if (!best || (best.s < 0.6 && !address)) return null;
    const x = best.x;
    const a = x.address ?? {};
    const addr = [[a.house_number, a.road].filter(Boolean).join(" "), a.postcode].filter(Boolean).join(", ") || null;
    const tags: Record<string, string> = { name: x.name || name, ...(x.extratags ?? {}) };
    if (x.category && x.type) tags[x.category] = x.type;
    const id = x.osm_type && x.osm_id ? `osm-${x.osm_type}-${x.osm_id}` : null;
    return { name: x.name || name, location: { lat: Number(x.lat), lng: Number(x.lon) }, address: addr, tags, id, source: "OSM Nominatim", asOf: new Date().toISOString(), how: best.s >= 0.8 ? "Nominatim name match" : "Nominatim address match", verdict: best.s >= 0.8 ? "confirmed" : "likely" };
  } catch {
    return null;
  }
}

const CENTRE: LatLng = { lat: 51.5074, lng: -0.1278 };
/** Venue (+ address) → a point in London. Postcode in the address, when present, must agree (≤ 1.5 km).
 *  Same-name places (several "George Inn"s) go to the one nearest `near` (the user), else central London. */
export async function resolveDestination(d: Pick<Destination, "venue" | "address">, nearIn?: LatLng | null): Promise<FoundPlace | null> {
  const pcm = d.address ? POSTCODE_RE.exec(d.address) : null;
  const pc = pcm ? await lookupPostcode(`${pcm[1]}${pcm[2]}`) : null;
  const pcPoint = pc && !("error" in pc) ? { lat: pc.lat, lng: pc.lng } : null;
  const agrees = (p: FoundPlace | null) => !!p && IN_LONDON(p.location) && (!pcPoint || metresBetween(p.location, pcPoint) <= 1500);
  const near = pcPoint ?? nearIn ?? CENTRE;
  const [atlasR, nom] = await Promise.all([atlasByName(d.venue, pcPoint), nominatim(d.venue, d.address, near)]);
  const atlas = atlasR ?? snapshotByName(d.venue, near);
  if (agrees(atlas)) return { ...atlas!, address: atlas!.address ?? d.address };
  if (agrees(nom)) return { ...nom!, address: nom!.address ?? d.address };
  if (pcPoint && pc && !("error" in pc) && IN_LONDON(pcPoint))
    return { name: d.venue, location: pcPoint, address: d.address, tags: { name: d.venue }, id: null, source: "postcodes.io", asOf: new Date().toISOString(), how: `postcode ${pc.label} centre`, verdict: "likely" };
  const g = matchPlace(d.venue);
  if (g.confidence === "high" && g.best) {
    const e = g.best.entry;
    return { name: e.name, location: e.location, address: d.address, tags: { name: e.name }, id: e.id ? `tfl-${e.id}` : null, source: GAZETTEER_SOURCE, asOf: GAZETTEER_AS_OF, how: "station / area name", verdict: "likely" };
  }
  // The venue itself isn't on the map: fall back to its street or area ("Encode Hub, Shoreditch"), flagged unpinned.
  const parts = (d.address ?? "").split(",").map((x) => x.trim()).filter((x) => x && !POSTCODE_RE.test(x) && !/^(?:greater\s+)?london$|^(?:uk|united kingdom|england|gb)$/i.test(x));
  for (const part of parts) {
    const gm = matchPlace(part);
    if (gm.confidence === "high" && gm.best && IN_LONDON(gm.best.entry.location)) {
      const e = gm.best.entry;
      return { name: d.venue, location: e.location, address: d.address, tags: { name: d.venue }, id: null, source: GAZETTEER_SOURCE, asOf: GAZETTEER_AS_OF, how: `the ${e.name} area`, verdict: "likely", pinned: false };
    }
  }
  if (parts.length) {
    const st = await nominatim(parts[0], parts.slice(1).join(", ") || "London", near);
    if (st && IN_LONDON(st.location)) return { ...st, name: d.venue, tags: { name: d.venue }, id: null, address: st.address ?? d.address, how: `the street address (${parts[0]})`, verdict: "likely", pinned: false };
  }
  return null;
}
