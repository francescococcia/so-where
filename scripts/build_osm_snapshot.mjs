// Builds src/data/osm-snapshot.json: a REAL OpenStreetMap snapshot (Overpass API) of pubs, bars, cafés and
// restaurants within 500 m of each hub station, plus free-entry places (fee=no museums, galleries,
// marketplaces, arts centres) within 2.5 km of the Encode Hub and 1 km of each hub.
// /api/plan uses it ONLY when the live Overpass call fails or times out, and labels it "OSM snapshot" with its date.
// Run: node scripts/build_osm_snapshot.mjs   (slow: public Overpass is often busy; retries with backoff)
import { readFileSync, writeFileSync } from "node:fs";

const UA = "SoWhere/0.1 (Encode London 2026 hackathon app)";
const hubs = JSON.parse(readFileSync(new URL("../src/data/hubs.json", import.meta.url), "utf8")).hubs;
const ENCODE_HUB = { lat: 51.529, lng: -0.083 };
const around = (r, p) => `(around:${r},${p.lat},${p.lng})`;
const food = hubs.map((h) => `nwr["amenity"~"^(pub|bar|cafe|restaurant)$"]["name"]${around(500, h)};`).join("\n");
const free = [ENCODE_HUB, ...hubs]
  .map((p, i) => {
    const r = i === 0 ? 2500 : 1000;
    return `nwr["tourism"~"^(museum|gallery)$"]["fee"="no"]${around(r, p)};nwr["amenity"~"^(marketplace|arts_centre)$"]["fee"="no"]${around(r, p)};`;
  })
  .join("\n");
const query = `[out:json][timeout:120];(\n${food}\n${free}\n);out center tags;`;
const KEEP = /^(name|amenity|tourism|shop|opening_hours|check_date.*|survey:date|addr:.*|fee|website|contact:website|wheelchair|cuisine|description)$/;

const endpoints = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
let json = null;
for (let attempt = 0; attempt < 6 && !json; attempt++) {
  const url = endpoints[attempt % endpoints.length];
  try {
    const r = await fetch(url, { method: "POST", headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(query), signal: AbortSignal.timeout(150_000) });
    if (r.ok) json = await r.json();
    else console.error(url, r.status);
  } catch (e) {
    console.error(url, String(e));
  }
  if (!json) await new Promise((res) => setTimeout(res, 5000 * 2 ** attempt));
}
if (!json) { console.error("Overpass unavailable; snapshot not written"); process.exit(1); }
const elements = json.elements
  .map((e) => ({
    type: e.type, id: e.id,
    lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon,
    tags: Object.fromEntries(Object.entries(e.tags ?? {}).filter(([k]) => KEEP.test(k))),
  }))
  .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng));
const doc = {
  source: "OpenStreetMap via Overpass API (© OpenStreetMap contributors, ODbL)",
  fetched_at: new Date().toISOString(),
  osm_base: json.osm3s?.timestamp_osm_base ?? null,
  note: "Fallback only. Real OSM data captured at fetched_at; shown as 'OSM snapshot' with that date.",
  elements,
};
writeFileSync(new URL("../src/data/osm-snapshot.json", import.meta.url), JSON.stringify(doc) + "\n");
console.log(`wrote ${elements.length} elements, osm_base ${doc.osm_base}`);
