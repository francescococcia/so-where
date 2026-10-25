// Landmarks (universities, museums, stations, churches, famous buildings) that aren't food/drink venues:
// name → a point in London. Wikidata (P625 coordinates) first, then OSM Nominatim (London viewbox, bounded,
// 1 request/second), then TfL StopPoint search for stations. Every hit must be inside the London bbox and
// name-match ≥ 0.8. Nothing here is stored, cached or logged: the name only lives for the request.
import { nameScore, type FoundPlace } from "@/lib/destination";
import { IN_LONDON } from "@/lib/geo";
import { searchPlace } from "@/lib/tfl";
import type { LatLng } from "@/lib/plan-types";

export type Landmark = FoundPlace & { landmark: true; source: "Wikidata" | "OSM Nominatim" | "TfL StopPoint" };
export type LandmarkDeps = { fetch?: typeof fetch; budgetMs?: number; /** Skip Nominatim (the caller already asked it). */ skipNominatim?: boolean; /** Skip TfL (tests). */ skipTfl?: boolean };

const UA = "SoWhere/0.1 (London meet-up planner; landmark lookup)";
const VIEWBOX = "-0.52,51.70,0.34,51.28";
let override: ((name: string) => Promise<Landmark | null>) | null = null;
/** Evals: answer resolveLandmark from a fixture instead of the network. */
export function setLandmarkResolverForTests(fn: typeof override) {
  override = fn;
}

// Nominatim's usage policy: ≤ 1 request per second, with a real User-Agent. Shared by every caller in this process.
let nextSlot = 0;
export async function nominatimSlot(): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + 1000;
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function getJson<T>(f: typeof fetch, url: string, ms: number): Promise<T | null> {
  if (ms < 250) return null;
  try {
    const r = await f(url, { headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "en-GB" }, signal: AbortSignal.timeout(ms) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

type WdSearch = { search?: { id: string; label?: string; match?: { text?: string }; description?: string }[] };
type WdEntity = { labels?: { en?: { value: string } }; descriptions?: { en?: { value: string } }; sitelinks?: { enwiki?: { title: string } }; claims?: { P625?: { mainsnak?: { datavalue?: { value?: { latitude: number; longitude: number } } } }[] } };

async function wikidata(f: typeof fetch, name: string, left: () => number): Promise<Landmark | null> {
  const s = await getJson<WdSearch>(f, `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&uselang=en&type=item&format=json&limit=5`, Math.min(2500, left()));
  const hits = (s?.search ?? []).filter((h) => /^Q\d+$/.test(h.id) && Math.max(nameScore(name, h.label ?? ""), nameScore(name, h.match?.text ?? "")) >= 0.8);
  if (!hits.length) return null;
  const e = await getJson<{ entities?: Record<string, WdEntity> }>(f, `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${hits.map((h) => h.id).join("|")}&props=claims|labels|descriptions|sitelinks&languages=en&sitefilter=enwiki&format=json`, Math.min(2500, left()));
  for (const h of hits) {
    const ent = e?.entities?.[h.id];
    const c = ent?.claims?.P625?.[0]?.mainsnak?.datavalue?.value;
    if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) continue;
    const location: LatLng = { lat: c.latitude, lng: c.longitude };
    if (!IN_LONDON(location)) continue;
    const label = ent?.labels?.en?.value ?? h.label ?? name;
    const tags: Record<string, string> = { name: label, wikidata: h.id };
    const wp = ent?.sitelinks?.enwiki?.title;
    if (wp) tags.wikipedia = `en:${wp}`;
    return { name: label, location, address: null, tags, id: `wd-${h.id}`, source: "Wikidata", asOf: new Date().toISOString(), how: "Wikidata coordinates", verdict: "confirmed", landmark: true };
  }
  return null;
}

type NomRow = { lat: string; lon: string; name?: string; osm_type?: string; osm_id?: number; category?: string; type?: string; extratags?: Record<string, string> | null; address?: Record<string, string> };
async function nominatim(f: typeof fetch, name: string, left: () => number): Promise<Landmark | null> {
  if (left() < 1500) return null;
  await nominatimSlot();
  const rows = await getJson<NomRow[]>(f, `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&countrycodes=gb&viewbox=${VIEWBOX}&bounded=1&extratags=1&addressdetails=1&q=${encodeURIComponent(name)}`, Math.min(3000, left()));
  const best = (rows ?? []).map((x) => ({ x, s: x.name ? nameScore(name, x.name) : 0 })).filter((r) => r.s >= 0.8 && IN_LONDON({ lat: +r.x.lat, lng: +r.x.lon })).sort((a, b) => b.s - a.s)[0];
  if (!best) return null;
  const x = best.x;
  const a = x.address ?? {};
  const address = [[a.house_number, a.road].filter(Boolean).join(" "), a.postcode].filter(Boolean).join(", ") || null;
  const tags: Record<string, string> = { name: x.name || name };
  for (const k of ["wikidata", "wikipedia", "website", "wheelchair"]) if (x.extratags?.[k]) tags[k] = x.extratags[k];
  const id = x.osm_type && x.osm_id ? `osm-${x.osm_type}-${x.osm_id}` : null;
  return { name: x.name || name, location: { lat: Number(x.lat), lng: Number(x.lon) }, address, tags, id, source: "OSM Nominatim", asOf: new Date().toISOString(), how: "Nominatim landmark match", verdict: "confirmed", landmark: true };
}

async function tflStation(name: string): Promise<Landmark | null> {
  const r = await searchPlace(name).catch(() => null);
  const p = r?.place;
  if (!p || p.source !== "TfL StopPoint" || !IN_LONDON(p.location) || nameScore(name.replace(/\s+(?:underground|tube|rail(?:way)?|dlr|overground)?\s*station$/i, ""), p.name) < 0.8) return null;
  return { name: p.name, location: p.location, address: null, tags: { name: p.name }, id: p.id ? `tfl-${p.id}` : null, source: "TfL StopPoint", asOf: p.asOf, how: "TfL station", verdict: "confirmed", landmark: true };
}

/** A recognised landmark's name → coordinates in London, or null. */
export async function resolveLandmark(nameIn: string, deps: LandmarkDeps = {}): Promise<Landmark | null> {
  const name = nameIn.replace(/\s+/g, " ").trim().slice(0, 120);
  if (name.length < 3) return null;
  if (override) return override(name);
  const f = deps.fetch ?? fetch;
  const end = Date.now() + (deps.budgetMs ?? 6000);
  const left = () => end - Date.now();
  return (await wikidata(f, name, left)) ?? (deps.skipNominatim ? null : await nominatim(f, name, left)) ?? (deps.skipTfl || left() < 500 ? null : await tflStation(name));
}
