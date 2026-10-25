// OpenStreetMap venues via ONE Overpass query (with a User-Agent), opening_hours parsed for the plan time.
// When live Overpass fails or times out (it is often overloaded), we use the bundled real OSM snapshot
// (src/data/osm-snapshot.json) and label it "OSM snapshot" with the date it was fetched.
import OpeningHours from "opening_hours";
import snapshot from "@/data/osm-snapshot.json";
import { metresBetween } from "@/lib/geo";
import { USER_AGENT } from "@/lib/http";
import { londonWallAsLocal } from "@/lib/london-time";
import type { LatLng, Verdict } from "@/lib/plan-types";

export type OsmKind = "pub" | "cafe" | "restaurant" | "free";
export type OsmPlace = { type: string; id: number; location: LatLng; tags: Record<string, string>; distanceM: number };
// source is "OSM live (Overpass)", "OSM snapshot" or the MongoDB Atlas label; via/stepSource are set when MongoDB
// served the query; `more` lists extra sources that topped up a thin result (snapshot, live Overpass).
export type OsmResult = { places: OsmPlace[]; source: string; asOf: string; live: boolean; ms: number; note?: string; via?: string; stepSource?: string; more?: { source: string; asOf: string }[] };

export const OVERPASS_LIVE = "OSM live (Overpass)";
/** Public Overpass mirrors, tried in order (each is often overloaded). OVERPASS_URL / OVERPASS_URLS override. */
export const OVERPASS_MIRRORS = (process.env.OVERPASS_URLS || process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter")
  .split(",").map((u) => u.trim()).filter(Boolean);

const FILTERS: Record<OsmKind, string[]> = {
  pub: ['["amenity"~"^(pub|bar|biergarten)$"]["name"]'],
  cafe: ['["amenity"="cafe"]["name"]'],
  restaurant: ['["amenity"="restaurant"]["name"]'],
  free: ['["tourism"~"^(museum|gallery)$"]["fee"="no"]', '["amenity"~"^(marketplace|arts_centre)$"]["fee"="no"]'],
};

// Things OSM sometimes tags tourism=museum / gallery that you can't actually visit (seen live: "Restored K6
// phone booth"): telephone boxes, kiosks, plaques, statues, benches, memorials, artworks, street furniture.
const OBJECT_TAGS: [string, RegExp][] = [
  ["historic", /^(memorial|monument|wayside_cross|wayside_shrine|milestone|boundary_stone|telephone_box|stone|plaque)$/],
  ["memorial", /./],
  ["tourism", /^artwork$/],
  ["artwork_type", /./],
  ["amenity", /^(telephone|bench|kiosk|post_box|clock|drinking_water|vending_machine)$/],
  ["disused:amenity", /^telephone$/],
  ["booth", /./],
  ["man_made", /^(street_cabinet|telephone_box)$/],
  ["shop", /^kiosk$/],
];
const OBJECT_NAME = /\b(phone ?box|phone ?booth|telephone|booth|kiosk|k6|plaque|statue|bench|post ?box)\b/i;
const WEAK_OBJECT_NAME = /\b(memorial|monument|box|cabinet|clock|obelisk)\b/i;

/**
 * False for objects rather than places you can walk into. Strong object words in the name drop it unless it
 * has opening hours; weak ones ("memorial", "box") only when it has neither hours nor a website and is a point.
 */
export function isVisitable(t: Record<string, string>, type = "node"): boolean {
  if (OBJECT_TAGS.some(([k, re]) => t[k] != null && re.test(t[k])) && !t.opening_hours) return false;
  const name = t.name ?? "";
  const hasHours = !!t.opening_hours;
  const hasWeb = !!(t.website ?? t["contact:website"] ?? t.url);
  if (OBJECT_NAME.test(name) && !hasHours) return false;
  if (WEAK_OBJECT_NAME.test(name) && !hasHours && !hasWeb && type === "node") return false;
  return true;
}

export function matches(kind: OsmKind, t: Record<string, string>, type?: string) {
  if (kind === "pub") return /^(pub|bar|biergarten)$/.test(t.amenity ?? "") && !!t.name;
  if (kind === "cafe") return t.amenity === "cafe" && !!t.name;
  if (kind === "restaurant") return t.amenity === "restaurant" && !!t.name;
  return t.fee === "no" && (/^(museum|gallery)$/.test(t.tourism ?? "") || /^(marketplace|arts_centre)$/.test(t.amenity ?? "")) && isVisitable(t, type);
}

type OverpassEl = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> };
type El = { type: string; id: number; lat: number; lng: number; tags: Record<string, string> };
type Snap = { fetched_at: string; elements: El[] };

export type OverpassDeps = { fetch?: typeof fetch; mirrors?: string[]; perMirrorMs?: number; budgetMs?: number };
export type OverpassLive = { ok: true; elements: El[]; mirror: string; fetchedAt: string; ms: number; cached: boolean } | { ok: false; error: string; ms: number };

// In-process only (never written anywhere): results for 10 min keyed by kind + a bbox snapped outward to a
// 0.005° grid (~500 m), so nearby asks share one query; after every mirror fails, skip live calls for 60 s.
const GRID = 0.005;
const LIVE_TTL_MS = 10 * 60_000;
const DOWN_MS = 60_000;
const liveCache = new Map<string, { at: number; r: Extract<OverpassLive, { ok: true }> }>();
let downUntil = 0;

/** Bbox (s, w, n, e) covering the circle, snapped outward to the grid. */
export function gridBbox(center: LatLng, radiusM: number): [number, number, number, number] {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const dn = (x: number) => +(Math.floor(x / GRID) * GRID).toFixed(3);
  const up = (x: number) => +(Math.ceil(x / GRID) * GRID).toFixed(3);
  return [dn(center.lat - dLat), dn(center.lng - dLng), up(center.lat + dLat), up(center.lng + dLng)];
}

export function resetOverpassForTests() {
  liveCache.clear();
  downUntil = 0;
}

/**
 * ONE live Overpass query (name, amenity / tourism, cuisine, opening_hours… all tags) for `kind` inside the
 * grid bbox around the circle. Mirrors in order, ~6 s each, 12 s total. Never throws.
 */
export async function overpassLive(kind: OsmKind, center: LatLng, radiusM: number, deps: OverpassDeps = {}): Promise<OverpassLive> {
  const t0 = Date.now();
  const bbox = gridBbox(center, radiusM);
  const key = `${kind}|${bbox.join(",")}`;
  const hit = liveCache.get(key);
  if (hit && Date.now() - hit.at < LIVE_TTL_MS) return { ...hit.r, cached: true, ms: 0 };
  if (!deps.fetch && Date.now() < downUntil) return { ok: false, error: "unreachable (all mirrors failed in the last minute)", ms: 0 };
  const f = deps.fetch ?? fetch;
  const mirrors = deps.mirrors ?? OVERPASS_MIRRORS;
  const per = deps.perMirrorMs ?? 6000;
  const budget = deps.budgetMs ?? 12_000;
  const body = `[out:json][timeout:6];(${FILTERS[kind].map((flt) => `nwr${flt}(${bbox.join(",")});`).join("")});out center tags 400;`;
  const errors: string[] = [];
  for (const url of mirrors) {
    const left = budget - (Date.now() - t0);
    if (left < 500) { errors.push("budget spent"); break; }
    const host = new URL(url).host;
    // A plain (ref'd) timer, not AbortSignal.timeout: the abort must fire even when nothing else is pending.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(Object.assign(new Error("timeout"), { name: "TimeoutError" })), Math.min(per, left));
    try {
      const res = await f(url, {
        method: "POST",
        body: `data=${encodeURIComponent(body)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: ac.signal,
        cache: "no-store",
      });
      if (!res.ok) { errors.push(`${host} HTTP ${res.status}`); continue; }
      const j = (await res.json()) as { elements?: OverpassEl[]; remark?: string };
      if (!Array.isArray(j.elements) || (!j.elements.length && j.remark && /timed out|runtime error/i.test(j.remark))) { errors.push(`${host} ${j.remark ? "query timed out" : "bad reply"}`); continue; }
      const elements = j.elements
        .map((e) => ({ type: e.type, id: e.id, lat: e.lat ?? e.center?.lat ?? NaN, lng: e.lon ?? e.center?.lon ?? NaN, tags: e.tags ?? {} }))
        .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));
      const r = { ok: true as const, elements, mirror: host, fetchedAt: new Date().toISOString(), ms: Date.now() - t0, cached: false };
      liveCache.set(key, { at: Date.now(), r });
      if (liveCache.size > 200) liveCache.delete(liveCache.keys().next().value as string);
      return r;
    } catch (e) {
      const n = (e as Error)?.name;
      errors.push(`${host} ${n === "TimeoutError" || n === "AbortError" || ac.signal.aborted ? "timeout" : "unreachable"}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (!deps.fetch) downUntil = Date.now() + DOWN_MS;
  return { ok: false, error: errors.join(", ") || "no mirrors", ms: Date.now() - t0 };
}

const shapeNear = (kind: OsmKind, center: LatLng, radiusM: number, els: El[]): OsmPlace[] =>
  els
    .map((e) => ({ type: e.type, id: e.id, location: { lat: e.lat, lng: e.lng }, tags: e.tags, distanceM: metresBetween(center, { lat: e.lat, lng: e.lng }) }))
    .filter((p) => p.distanceM <= radiusM && matches(kind, p.tags, p.type))
    .sort((a, b) => a.distanceM - b.distanceM);

/** The bundled OSM snapshot (central hubs + the outer-hub extract) near a point. */
export function snapshotPlaces(kind: OsmKind, center: LatLng, radiusM: number): { places: OsmPlace[]; asOf: string } {
  const snap = snapshot as unknown as Snap;
  return { places: shapeNear(kind, center, radiusM, snap.elements), asOf: snap.fetched_at };
}

/** Live Overpass places near a point (mirrors, cache), or the failure. */
export async function livePlaces(kind: OsmKind, center: LatLng, radiusM: number, deps?: OverpassDeps) {
  const r = await overpassLive(kind, center, radiusM, deps);
  return r.ok ? { ...r, places: shapeNear(kind, center, radiusM, r.elements) } : r;
}

/** No MongoDB: live Overpass (mirrors) first, topped up / replaced by the bundled snapshot. */
export async function findPlaces(kind: OsmKind, center: LatLng, radiusM: number, deps?: OverpassDeps): Promise<OsmResult> {
  const snap = snapshotPlaces(kind, center, radiusM);
  // server13 (speed): when the bundled snapshot already covers this spot well, live Overpass only gets a short budget
  // (it is often overloaded and its full 12 s budget was most of a cold plan); thin spots keep the full budget.
  const budgetMs = deps?.budgetMs ?? (snap.places.length >= SNAPSHOT_RICH ? SNAPSHOT_RICH_BUDGET_MS : undefined);
  const r = await livePlaces(kind, center, radiusM, { ...deps, budgetMs });
  if (r.ok) {
    const seen = new Set(r.places.map((p) => `${p.type}/${p.id}`));
    const extra = r.places.length < MIN_CANDIDATES ? snap.places.filter((p) => !seen.has(`${p.type}/${p.id}`)) : [];
    return {
      places: [...r.places, ...extra].sort((a, b) => a.distanceM - b.distanceM),
      source: OVERPASS_LIVE,
      asOf: r.fetchedAt,
      live: true,
      ms: r.ms,
      via: `${r.places.length} from ${OVERPASS_LIVE.replace(")", `, ${r.mirror}${r.cached ? ", cached" : ""})`)}${extra.length ? ` + ${extra.length} from the OSM snapshot` : ""}`,
      stepSource: OVERPASS_LIVE,
      ...(extra.length ? { more: [{ source: "OSM snapshot", asOf: snap.asOf }] } : {}),
    };
  }
  return {
    places: snap.places,
    source: "OSM snapshot",
    asOf: snap.asOf,
    live: false,
    ms: r.ms,
    stepSource: "OSM snapshot (live Overpass failed)",
    note: `Live Overpass failed (${r.error}); used the OSM snapshot from ${snap.asOf.slice(0, 10)}`,
  };
}

/** A snapshot with at least this many places near the spot is "rich": live Overpass then gets SNAPSHOT_RICH_BUDGET_MS. */
export const SNAPSHOT_RICH = 8;
export const SNAPSHOT_RICH_BUDGET_MS = 4_000;

/** Fewer than this many candidates for a category and the finder looks further (snapshot, then live Overpass). */
export const MIN_CANDIDATES = 3;

export type HoursCheck = {
  state: "open" | "closed" | "unknown";
  value: string;
  verdict: Verdict;
  checkDate?: string;
  /** London "HH:MM" the current opening ends (open only; absent when open round the clock). */
  closesAt?: string;
  /** Minutes from `at` to closing (open only; absent when open round the clock). */
  closesInMin?: number;
  /** London "HH:MM" of the next opening within 7 days (closed only). */
  opensAt?: string;
  /** Minutes from `at` to that opening (closed only). */
  opensInMin?: number;
};

const fmt = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** Is this OSM place open at `at`? Uses opening_hours.js, so ranges past midnight ("Fr-Sa 12:00-02:00"),
 *  public holidays ("PH off", England) and "off" rules are honoured. 'confirmed' only when a check_date
 *  within 12 months backs the hours. When open, the value leads with the stretch that contains `at`
 *  ("Open until 02:00 (17:00–02:00)") so a reader taking the first range gets the right one. */
export function hoursAt(tags: Record<string, string>, at: Date, location: LatLng): HoursCheck {
  const raw = tags.opening_hours;
  if (!raw) return { state: "unknown", value: "Hours not in OSM", verdict: "unknown" };
  const checkDate = tags["check_date:opening_hours"] ?? tags.check_date ?? tags["survey:date"];
  const fresh = !!checkDate && Date.now() - Date.parse(checkDate) < 365 * 86_400_000 && Date.parse(checkDate) <= Date.now();
  try {
    const oh = new OpeningHours(raw, { lat: location.lat, lon: location.lng, address: { country_code: "gb", state: "England" } } as never);
    const local = londonWallAsLocal(at);
    if (oh.getUnknown(local)) return { state: "unknown", value: `OSM hours: ${raw}`, verdict: "unknown", checkDate };
    const open = oh.getState(local);
    const checked = checkDate ? ` · checked ${checkDate}` : "";
    const verdict: Verdict = fresh ? "confirmed" : "likely";
    if (!open) {
      const dayStart = new Date(local.getFullYear(), local.getMonth(), local.getDate());
      const ranges = oh.getOpenIntervals(dayStart, new Date(dayStart.getTime() + 86_400_000)).map(([a, b]) => `${fmt(a)}–${fmt(b)}`);
      const next = oh.getNextChange(local, new Date(local.getTime() + 7 * 86_400_000));
      const opens = next && oh.getState(new Date(next.getTime() + 1000)) ? { opensAt: fmt(next), opensInMin: Math.round((next.getTime() - local.getTime()) / 60_000) } : {};
      return { state: "closed", value: `Closed at ${fmt(local)} (${ranges.length ? ranges.join(", ") : "closed that day"})${checked}`, verdict, checkDate, ...opens };
    }
    // The open stretch containing `at`, merged across midnight (getOpenIntervals splits nothing but
    // may return back-to-back intervals, e.g. "17:00-24:00" + "00:00-03:00").
    const iv = oh.getOpenIntervals(new Date(local.getTime() - 2 * 86_400_000), new Date(local.getTime() + 2 * 86_400_000));
    let a = local;
    let b = local;
    for (const [s0, e0] of iv) if (s0 <= local && e0 > local) [a, b] = [s0, e0];
    for (let moved = true; moved; ) {
      moved = false;
      for (const [s0, e0] of iv) {
        if (Math.abs(s0.getTime() - b.getTime()) < 60_000 && e0 > b) [b, moved] = [e0, true];
        if (Math.abs(e0.getTime() - a.getTime()) < 60_000 && s0 < a) [a, moved] = [s0, true];
      }
    }
    const roundClock = b.getTime() - a.getTime() >= 3 * 86_400_000 - 120_000; // open across the whole window
    if (roundClock) return { state: "open", value: `Open 24 hours${checked}`, verdict, checkDate };
    const closesInMin = Math.round((b.getTime() - local.getTime()) / 60_000);
    return { state: "open", value: `Open until ${fmt(b)} (${fmt(a)}–${fmt(b)})${checked}`, verdict, checkDate, closesAt: fmt(b), closesInMin };
  } catch {
    return { state: "unknown", value: `OSM hours not machine-readable: "${raw.slice(0, 40)}"`, verdict: "unknown", checkDate };
  }
}

export function osmUrl(p: Pick<OsmPlace, "type" | "id">) {
  return `https://www.openstreetmap.org/${p.type}/${p.id}`;
}

export function addressOf(t: Record<string, string>) {
  const line = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  const pc = t["addr:postcode"]?.split(" ")[0];
  return [line, pc].filter(Boolean).join(", ") || null;
}

export const KIND_LABEL: Record<string, string> = { pub: "Pub", bar: "Bar", biergarten: "Beer garden", cafe: "Café", restaurant: "Restaurant", museum: "Museum", gallery: "Gallery", marketplace: "Market", arts_centre: "Arts centre" };
export const kindLabel = (t: Record<string, string>) => KIND_LABEL[t.amenity ?? ""] ?? KIND_LABEL[t.tourism ?? ""] ?? "Place";
