// GET /api/photo?name=&lat=&lng=[&osm=osm-way-123][&wikidata=Q..][&commons=File:..][&image=url]
// Finds a real, freely licensed photo of a place. Order:
//   1. OSM tags (passed in, or read from the OSM element / a name match nearby): image, wikimedia_commons, wikidata → P18
//   2. Wikimedia Commons geosearch (~80 m) where the file title starts with the place name
//   3. Wikidata item with the same name whose coordinates are within ~250 m → P18
// Never returns an unrelated nearby photo: no name match → { photo: null } and the UI shows a styled fallback.
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type Photo = { url: string; width: number; height: number; page: string; author?: string; license?: string; source: "Wikimedia Commons" };
type Out = { photo: Photo | null; via: string };

const UA = "SoWhere/0.1 (London meet-up planner; photo lookup)";
const TIMEOUT = 3500;
const cache = new Map<string, { at: number; out: Out }>();
const TTL_HIT = 7 * 864e5;
const TTL_MISS = 6 * 36e5;

async function getJSON<T>(url: string, init?: RequestInit): Promise<T | null> {
  try {
    const r = await fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const norm = (s: string) =>
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^file:/, "").replace(/&/g, " and ").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, " ").replace(/^the /, "").trim();
const IMG = /\.(jpe?g|png|webp)$/i;
const strip = (html?: string) => html?.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() || undefined;

/** Title starts with the place name ("The George Inn, London Bridge.jpg"), not just mentions it ("The Shard from the Bunch of Grapes"). */
function titleMatches(title: string, name: string) {
  const t = norm(title.replace(/\.[a-z]+$/i, ""));
  const n = norm(name);
  return n.length >= 3 && (t === n || t.startsWith(n + " "));
}

type InfoResp = { query?: { pages?: Record<string, { title: string; imageinfo?: { thumburl?: string; url: string; thumbwidth?: number; thumbheight?: number; width: number; height: number; descriptionurl: string; extmetadata?: Record<string, { value: string }> }[] }> } };

async function commonsInfo(titles: string[]): Promise<Photo | null> {
  const files = titles.filter((t) => IMG.test(t)).slice(0, 10);
  if (!files.length) return null;
  const u = new URL("https://commons.wikimedia.org/w/api.php");
  Object.entries({ action: "query", format: "json", prop: "imageinfo", iiprop: "url|size|extmetadata", iiurlwidth: "960", iiextmetadatafilter: "Artist|LicenseShortName", titles: files.join("|"), origin: "*" }).forEach(([k, v]) => u.searchParams.set(k, v));
  const d = await getJSON<InfoResp>(u.toString());
  const pages = Object.values(d?.query?.pages ?? {});
  // keep the caller's preference order
  for (const t of files) {
    const p = pages.find((x) => x.title.replace(/_/g, " ") === t.replace(/_/g, " "));
    const ii = p?.imageinfo?.[0];
    if (!ii || ii.width < 400) continue;
    const author = strip(ii.extmetadata?.Artist?.value);
    return { url: ii.thumburl ?? ii.url, width: ii.thumbwidth ?? ii.width, height: ii.thumbheight ?? ii.height, page: ii.descriptionurl, author: author && author.length <= 40 ? author : undefined, license: ii.extmetadata?.LicenseShortName?.value, source: "Wikimedia Commons" };
  }
  return null;
}

function commonsTitle(v?: string | null): string | null {
  if (!v) return null;
  const m = v.match(/(?:commons\.wikimedia\.org\/wiki\/|^)(File:[^?#]+)/i) ?? v.match(/upload\.wikimedia\.org\/.+\/([^/]+\.(?:jpe?g|png|webp))$/i);
  if (!m) return null;
  const t = decodeURIComponent(m[1]).replace(/_/g, " ");
  return t.startsWith("File:") ? t : `File:${t}`;
}

async function wikidataP18(q: string): Promise<string | null> {
  if (!/^Q\d+$/.test(q)) return null;
  const d = await getJSON<{ claims?: { P18?: { mainsnak?: { datavalue?: { value?: string } } }[] } }>(`https://www.wikidata.org/w/api.php?action=wbgetclaims&format=json&entity=${q}&property=P18&origin=*`);
  const f = d?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  return f ? `File:${f}` : null;
}

const metres = (a: number, b: number, c: number, d: number) => {
  const k = Math.PI / 180;
  const x = (d - b) * k * Math.cos(((a + c) / 2) * k);
  return Math.hypot(x, (c - a) * k) * 6371e3;
};

/** Wikidata item whose label is the place name and whose P625 sits within ~250 m → its P18 file. */
async function wikidataByName(name: string, lat: number, lng: number): Promise<string | null> {
  const s = await getJSON<{ search?: { id: string }[] }>(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&type=item&limit=7&search=${encodeURIComponent(name)}&origin=*`);
  const ids = (s?.search ?? []).map((x) => x.id).filter((id) => /^Q\d+$/.test(id));
  if (!ids.length) return null;
  type Ent = { labels?: { en?: { value: string } }; aliases?: { en?: { value: string }[] }; claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]> };
  const d = await getJSON<{ entities?: Record<string, Ent> }>(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels|aliases|claims&languages=en&ids=${ids.join("|")}&origin=*`);
  for (const id of ids) {
    const e = d?.entities?.[id];
    const labels = [e?.labels?.en?.value, ...(e?.aliases?.en ?? []).map((a) => a.value)].filter(Boolean) as string[];
    if (!labels.some((l) => norm(l) === norm(name))) continue;
    const c = e?.claims?.P625?.[0]?.mainsnak?.datavalue?.value as { latitude?: number; longitude?: number } | undefined;
    if (!c || typeof c.latitude !== "number" || typeof c.longitude !== "number" || metres(lat, lng, c.latitude, c.longitude) > 250) continue;
    const f = e?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (typeof f === "string") return `File:${f}`;
  }
  return null;
}

type Tags = Record<string, string>;
async function osmTags(osm: string | null, name: string, lat: number, lng: number): Promise<Tags | null> {
  const m = osm?.match(/(node|way|relation)[-/](\d+)/);
  if (m) {
    const d = await getJSON<{ elements?: { tags?: Tags }[] }>(`https://api.openstreetmap.org/api/0.6/${m[1]}/${m[2]}.json`);
    if (d?.elements?.[0]?.tags) return d.elements[0].tags;
  }
  const re = name.replace(/^the\s+/i, "").replace(/[.*+?^${}()|[\]\\"]/g, "\\$&");
  const q = `[out:json][timeout:4];nwr(around:70,${lat},${lng})["name"~"^(the )?${re}$",i];out tags 1;`;
  const d = await getJSON<{ elements?: { tags?: Tags }[] }>("https://overpass-api.de/api/interpreter", { method: "POST", body: new URLSearchParams({ data: q }), headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  return d?.elements?.[0]?.tags ?? null;
}

async function find(p: { name: string; lat: number; lng: number; osm: string | null; wikidata: string | null; commons: string | null; image: string | null }): Promise<Out> {
  let tags: Tags = {};
  if (!p.wikidata && !p.commons && !p.image) tags = (await osmTags(p.osm, p.name, p.lat, p.lng)) ?? {};
  const direct = [commonsTitle(p.image ?? tags.image), commonsTitle(p.commons ?? tags.wikimedia_commons)].filter(Boolean) as string[];
  if (direct.length) {
    const hit = await commonsInfo(direct);
    if (hit) return { photo: hit, via: "osm-tag" };
  }
  const qid = p.wikidata ?? tags.wikidata;
  if (qid) {
    const f = await wikidataP18(qid);
    const hit = f ? await commonsInfo([f]) : null;
    if (hit) return { photo: hit, via: "wikidata" };
  }
  const g = await getJSON<{ query?: { geosearch?: { title: string; dist: number }[] } }>(
    `https://commons.wikimedia.org/w/api.php?action=query&format=json&list=geosearch&gscoord=${p.lat}%7C${p.lng}&gsradius=80&gsnamespace=6&gslimit=200&origin=*`
  );
  const names = [p.name, tags.name, tags["alt_name"], tags["old_name"]].filter(Boolean) as string[];
  const matches = (g?.query?.geosearch ?? []).filter((x) => names.some((n) => titleMatches(x.title, n))).sort((a, b) => a.dist - b.dist).map((x) => x.title);
  const hit = await commonsInfo(matches);
  if (hit) return { photo: hit, via: "commons-geosearch" };
  const wf = await wikidataByName(p.name, p.lat, p.lng);
  const wh = wf ? await commonsInfo([wf]) : null;
  return wh ? { photo: wh, via: "wikidata-name" } : { photo: null, via: "none" };
}

export async function GET(req: NextRequest) {
  const s = req.nextUrl.searchParams;
  const name = (s.get("name") ?? "").slice(0, 120).trim();
  const lat = Number(s.get("lat"));
  const lng = Number(s.get("lng"));
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return NextResponse.json({ photo: null, via: "bad-request" }, { status: 400 });
  }
  const p = { name, lat, lng, osm: s.get("osm"), wikidata: s.get("wikidata"), commons: s.get("commons"), image: s.get("image") };
  const key = JSON.stringify({ ...p, lat: lat.toFixed(4), lng: lng.toFixed(4) });
  const c = cache.get(key);
  let out: Out;
  if (c && Date.now() - c.at < (c.out.photo ? TTL_HIT : TTL_MISS)) out = c.out;
  else {
    out = await find(p);
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), out });
  }
  return NextResponse.json(out, {
    headers: { "Cache-Control": out.photo ? "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400" : "public, max-age=3600, s-maxage=21600" },
  });
}
