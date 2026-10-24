// Builds src/data/stations.json: every tube / DLR / Overground / Elizabeth line / tram / National Rail station
// inside Greater London, from the TfL Line StopPoints API. Used by the local gazetteer (src/lib/gazetteer.ts)
// to read sloppy typed places ("liverpolstreet", "kings x") before calling TfL search.
// Run: node scripts/build_stations.mjs   (no key needed; uses TFL_APP_KEY if set)
import { writeFileSync } from "node:fs";

const key = process.env.TFL_APP_KEY ? `?app_key=${process.env.TFL_APP_KEY}` : "";
const get = async (path) => {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`https://api.tfl.gov.uk${path}${key}`);
    if (r.ok) return r.json();
    await new Promise((res) => setTimeout(res, 1000 * (i + 1)));
  }
  throw new Error(`TfL ${path} failed`);
};
// Greater London bounding box (generous); National Rail lines run far beyond it.
const inLondon = (s) => s.lat > 51.28 && s.lat < 51.7 && s.lon > -0.52 && s.lon < 0.34;
const SKIP = new Set(["island-line", "merseyrail", "northern-rail", "scotrail", "transport-for-wales", "transpennine-express", "hull-trains", "lumo", "grand-central", "crosscountry", "west-midlands-trains", "east-midlands-railway", "avanti-west-coast"]);
const MODE_RANK = ["tube", "elizabeth-line", "overground", "dlr", "national-rail", "tram"];
const clean = (n) =>
  n.replace(/\s+\((?:London|Berks|Surrey|Kent|Middx)\)/i, "")
    .replace(/\s+(?:Underground|Rail|DLR|Tram|Elizabeth line|ELL|Overground)?\s*(?:Station|Stop)$/i, "")
    .replace(/\s+(?:Underground|Rail|DLR|Tram|Elizabeth line)$/i, "")
    .trim();

const lines = (await get("/Line/Mode/tube,dlr,overground,elizabeth-line,tram,national-rail")).filter((l) => !SKIP.has(l.id));
const byName = new Map();
for (const line of lines) {
  const stops = await get(`/Line/${line.id}/StopPoints`);
  for (const s of stops) {
    if (!inLondon(s)) continue;
    const name = clean(s.commonName);
    const modes = (s.modes ?? []).filter((m) => MODE_RANK.includes(m));
    const prev = byName.get(name);
    const rank = Math.min(...modes.map((m) => MODE_RANK.indexOf(m)), 9);
    if (!prev) byName.set(name, { name, id: s.naptanId, lat: +s.lat.toFixed(6), lng: +s.lon.toFixed(6), modes, rank });
    else {
      prev.modes = [...new Set([...prev.modes, ...modes])];
      if (rank < prev.rank) Object.assign(prev, { id: s.naptanId, lat: +s.lat.toFixed(6), lng: +s.lon.toFixed(6), rank });
    }
  }
  process.stdout.write(`${line.id}:${stops.length} `);
  await new Promise((res) => setTimeout(res, 150));
}
const stations = [...byName.values()].map(({ rank, ...s }) => ({ ...s, modes: s.modes.sort((a, b) => MODE_RANK.indexOf(a) - MODE_RANK.indexOf(b)) })).sort((a, b) => a.name.localeCompare(b.name));
const doc = { source: "TfL Line StopPoints API", fetched_at: new Date().toISOString(), note: "Stations inside Greater London (bbox 51.28–51.70N, 0.52W–0.34E); id is the station NaPTAN of the highest-ranked mode.", stations };
writeFileSync(new URL("../src/data/stations.json", import.meta.url), JSON.stringify(doc).replace(/\{"name"/g, '\n{"name"') + "\n");
console.log(`\n${stations.length} stations`);
