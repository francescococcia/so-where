// Builds src/data/hubs.json: ~12 central London hub stations, resolved live from the TfL StopPoint API.
// Run: node scripts/build_hubs.mjs   (no key needed; uses TFL_APP_KEY if set)
import { writeFileSync } from "node:fs";

const HUBS = [
  "Borough", "London Bridge", "Bank", "Liverpool Street", "Farringdon", "King's Cross St. Pancras",
  "Tottenham Court Road", "Oxford Circus", "Leicester Square", "Waterloo", "Victoria", "Elephant & Castle",
];
const key = process.env.TFL_APP_KEY ? `&app_key=${process.env.TFL_APP_KEY}` : "";
const out = [];
for (const name of HUBS) {
  const r = await fetch(`https://api.tfl.gov.uk/StopPoint/Search/${encodeURIComponent(name)}?modes=tube${key}`);
  const j = await r.json();
  const norm = (s) => s.toLowerCase().replace(/[^a-z]/g, "");
  const ms = j.matches ?? [];
  const m = ms.find((x) => norm(x.name).startsWith(norm(name).slice(0, 8))) ?? ms[0];
  if (!m) { console.error("no match", name); continue; }
  out.push({ name, id: m.id, tflName: m.name, lat: m.lat, lng: m.lon });
  await new Promise((res) => setTimeout(res, 300));
}
const doc = { source: "TfL StopPoint Search API", fetched_at: new Date().toISOString(), hubs: out };
writeFileSync(new URL("../src/data/hubs.json", import.meta.url), JSON.stringify(doc, null, 2) + "\n");
console.log(out.map((h) => `${h.name} → ${h.id} ${h.tflName}`).join("\n"));
