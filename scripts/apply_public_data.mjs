#!/usr/bin/env node
// Load public venue facts and recurring sessions into Supabase.
//
//   node scripts/apply_public_data.mjs            apply
//   node scripts/apply_public_data.mjs --dry-run  show what would change
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env or the
// environment and never prints them. Safe to run again.
// 1. Deletes the fictional EXAMPLE venues (source = example). Their hosted
//    events go with them through on delete cascade. Then the EXAMPLE Community.
// 2. Upserts the extra public venues from src/data/venue-facts.json by seed_key.
// 3. Fills hours and capacity where a public source has them. Never clears a value.
// 4. If migrations/20261023_venue_types_sessions.sql has been pasted, also sets
//    venue_type, good_for, source_url and upserts src/data/recurring-sessions.json.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

function loadEnv() {
  const env = { ...process.env };
  const file = join(ROOT, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m || env[m[1]]) continue;
      env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

const env = loadEnv();
const BASE = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) {
  console.error("Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const facts = JSON.parse(readFileSync(join(ROOT, "src/data/venue-facts.json"), "utf8"));
const sessions = JSON.parse(readFileSync(join(ROOT, "src/data/recurring-sessions.json"), "utf8"));
const city = JSON.parse(readFileSync(join(ROOT, "config/city.json"), "utf8"));
const ROOT_ID = city.roots?.[0]?.id ?? null;

async function rest(method, path, body, prefer) {
  const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${BASE}/rest/v1/${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`${method} ${path.split("?")[0]} -> ${res.status} ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

async function hasColumn(table, column) {
  try {
    await rest("GET", `${table}?select=${column}&limit=1`);
    return true;
  } catch (e) {
    if (e.status === 400 || e.status === 404) return false;
    throw e;
  }
}

const toHours = (h) => (h ? Object.fromEntries(Object.entries(h).map(([d, [start, end]]) => [d, { start, end }])) : null);
const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();

async function main() {
  console.log(DRY ? "Dry run, nothing is written." : "Applying public data.");

  // 1. EXAMPLE rows.
  const exVenues = await rest("GET", "venues?source=eq.example&select=id,name");
  const exEvents = await rest("GET", "hosted_events?source=eq.example&select=id,event_name,venue_id");
  const exCommunity = await rest("GET", "communities?name=eq.EXAMPLE%20Community&select=id,name");
  for (const v of exVenues) console.log(`delete venue ${v.id} ${v.name}`);
  for (const e of exEvents) console.log(`delete hosted event ${e.id} ${e.event_name} (cascade)`);
  for (const c of exCommunity) console.log(`delete community ${c.id} ${c.name}`);
  if (!DRY) {
    if (exEvents.length) await rest("DELETE", "hosted_events?source=eq.example");
    if (exVenues.length) await rest("DELETE", "venues?source=eq.example");
    if (exCommunity.length) await rest("DELETE", "communities?name=eq.EXAMPLE%20Community");
  }

  const typed = await hasColumn("venues", "venue_type");
  const sessionsTable = await hasColumn("recurring_sessions", "id");
  console.log(`migration columns: ${typed ? "yes" : "not yet"}, recurring_sessions table: ${sessionsTable ? "yes" : "not yet"}`);

  // 2. New public venues.
  for (const v of facts.new_venues) {
    const row = { seed_key: v.seed_key, name: v.name, address: v.address, lat: v.lat, lng: v.lng, status: "verified", source: "public", created_by: ROOT_ID };
    console.log(`upsert venue ${v.name}`);
    if (!DRY) await rest("POST", "venues?on_conflict=seed_key", [row], "resolution=merge-duplicates,return=minimal");
  }

  // 3 and 4. Facts on every matching venue.
  const all = await rest("GET", "venues?select=id,name,hours,capacity,notes");
  const byName = new Map(all.map((v) => [norm(v.name), v]));
  const find = (f) => {
    for (const n of [f.match, f.also_match].filter(Boolean)) {
      const hit = byName.get(norm(n)) ?? all.find((v) => norm(v.name).startsWith(norm(n)));
      if (hit) return hit;
    }
    return null;
  };
  let filled = { type: 0, hours: 0, capacity: 0 };
  for (const f of facts.venues) {
    const v = find(f);
    if (!v) {
      console.log(`no venue for ${f.match} (skipped)`);
      continue;
    }
    const patch = {};
    if (f.also_match && v.name !== f.match) patch.name = f.match;
    const hours = toHours(f.hours);
    if (hours) patch.hours = hours;
    if (f.capacity != null) patch.capacity = f.capacity;
    const note = [f.capacity_note, f.hours_note].filter(Boolean).join(". ");
    if (note && !(v.notes || "").includes(note)) patch.notes = [v.notes, note].filter(Boolean).join("\n");
    if (typed) {
      patch.venue_type = f.venue_type;
      patch.good_for = f.good_for;
      if (f.sources?.[0]) patch.source_url = f.sources[0];
    }
    if (typed && f.venue_type) filled.type++;
    if (hours || (v.hours && Object.keys(v.hours).length)) filled.hours++;
    if (f.capacity != null || v.capacity != null) filled.capacity++;
    if (!Object.keys(patch).length) continue;
    console.log(`update ${v.name}: ${Object.keys(patch).join(", ")}`);
    if (!DRY) await rest("PATCH", `venues?id=eq.${v.id}`, patch, "return=minimal");
  }

  // Sessions.
  if (sessionsTable) {
    const fresh = await rest("GET", "venues?select=id,name");
    const rows = [];
    for (const s of sessions.sessions) {
      const v = fresh.find((x) => norm(x.name) === norm(s.venue_name)) ?? fresh.find((x) => norm(x.name).startsWith(norm(s.venue_name)));
      if (!v) {
        console.log(`no venue for session ${s.title} at ${s.venue_name} (skipped)`);
        continue;
      }
      rows.push({
        session_key: s.key, venue_id: v.id, title: s.title, organiser: s.organiser, use_case: s.use_case,
        day_of_week: s.day_of_week, start_time: s.start_time, end_time: s.end_time, cadence: s.cadence,
        price: s.price, rsvp: s.rsvp, url: s.url, source_url: s.source_urls[0], summary: s.summary,
        verified_at: sessions.checked_on,
      });
      console.log(`upsert session ${s.title} at ${v.name}`);
    }
    if (!DRY && rows.length) await rest("POST", "recurring_sessions?on_conflict=session_key", rows, "resolution=merge-duplicates,return=minimal");
  } else {
    console.log("Sessions skipped until the migration is pasted. The app falls back to src/data/recurring-sessions.json.");
  }

  console.log(`venues with type: ${filled.type}, hours: ${filled.hours}, capacity: ${filled.capacity} (from the facts file)`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
