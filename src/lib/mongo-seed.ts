// Builds the `venues` and `events` documents (GeoJSON Points, normalised fields) from the bundled OSM
// snapshot and the Luma/Meetup seed files, creates the 2dsphere + Atlas Search indexes, and upserts by id.
// Used by scripts/seed_mongo.mjs (npm run seed:mongo) and by the mongodb-memory-server tests.
import type { AnyBulkWriteOperation, Db } from "mongodb";
import snapshot from "@/data/osm-snapshot.json";
import { seedEvents, type SeedEvent } from "@/lib/events";
import { addressOf, isVisitable } from "@/lib/osm";
import { seatingOf } from "@/lib/venue-weather";

type SnapEl = { type: string; id: number; lat: number; lng: number; tags: Record<string, string> };
type Point = { type: "Point"; coordinates: [number, number] };

export type VenueDoc = {
  _id: string; // "node/26699558"
  osmType: string;
  osmId: number;
  name: string | null;
  category: string; // amenity or tourism value: pub, bar, cafe, restaurant, museum, gallery, ...
  amenity: string | null;
  tourism: string | null;
  address: string | null;
  opening_hours: string | null;
  check_date: string | null;
  fee: string | null;
  wheelchair: string | null;
  website: string | null;
  phone: string | null;
  tags: string[]; // searchable keywords: category, cuisine, "free", "wheelchair", "outdoor", "indoor", ...
  // Weather-relevant OSM seating tags, normalised: true / false when tagged, null when OSM doesn't say.
  outdoor_seating: boolean | null;
  indoor_seating: boolean | null;
  covered: boolean | null;
  beer_garden: boolean | null; // beer_garden=yes, garden:type=beer_garden, or amenity=biergarten
  visitable: boolean; // false for objects mis-tagged as places (phone boxes, plaques, statues…): osm.ts isVisitable
  osm_tags: Record<string, string>; // raw OSM tags, so the planner can reuse its OSM hours/verdict logic
  location: Point;
  source: string;
  asOf: Date;
};

export type EventDoc = {
  _id: string;
  title: string;
  name: string;
  url: string | null;
  start: Date;
  end: Date; // listed end, or start + 3 h when the listing has none (same rule as seedEventsOn)
  endListed: boolean;
  place: string | null;
  organiser: string | null;
  walkIn: SeedEvent["walkIn"];
  tags: string[];
  location: Point;
  source: string;
  asOf: Date;
};

const point = (lat: number, lng: number): Point => ({ type: "Point", coordinates: [lng, lat] });

export function venueDocs(): VenueDoc[] {
  const snap = snapshot as unknown as { fetched_at: string; elements: SnapEl[] };
  const asOf = new Date(snap.fetched_at);
  const out: VenueDoc[] = [];
  for (const e of snap.elements) {
    if (!Number.isFinite(e.lat) || !Number.isFinite(e.lng)) continue;
    const t = e.tags ?? {};
    const category = t.amenity ?? t.tourism ?? "place";
    const kw = new Set<string>([category]);
    if (t.amenity && t.tourism) kw.add(t.tourism);
    for (const c of (t.cuisine ?? "").split(/[;,]/)) if (c.trim()) kw.add(c.trim().toLowerCase());
    if (category === "cafe") kw.add("coffee");
    if (category === "pub" || category === "bar" || category === "biergarten") kw.add("drinks");
    if (t.fee === "no") kw.add("free");
    if (t.wheelchair === "yes") kw.add("wheelchair");
    const seat = seatingOf(t);
    if (seat.outdoor_seating) kw.add("outdoor");
    if (seat.beer_garden) kw.add("beer_garden");
    if (seat.indoor_seating) kw.add("indoor");
    if (seat.covered) kw.add("covered");
    const visitable = isVisitable(t, e.type);
    if (!visitable) kw.add("unvisitable");
    out.push({
      _id: `${e.type}/${e.id}`,
      osmType: e.type,
      osmId: e.id,
      name: t.name ?? null,
      category,
      amenity: t.amenity ?? null,
      tourism: t.tourism ?? null,
      address: addressOf(t),
      opening_hours: t.opening_hours ?? null,
      check_date: t["check_date:opening_hours"] ?? t.check_date ?? t["survey:date"] ?? null,
      fee: t.fee ?? null,
      wheelchair: t.wheelchair ?? null,
      website: t.website ?? t["contact:website"] ?? null,
      phone: t.phone ?? t["contact:phone"] ?? null,
      tags: [...kw],
      ...seat,
      visitable,
      osm_tags: t,
      location: point(e.lat, e.lng),
      source: "OSM snapshot",
      asOf,
    });
  }
  return out;
}

export function eventDocs(events: SeedEvent[] = seedEvents()): EventDoc[] {
  return events.map((e) => {
    const start = new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(start.getTime() + 3 * 3600_000);
    const kw = new Set<string>(["event", e.source.replace(/ seed$/i, "").toLowerCase()]);
    if (!e.walkIn.rsvpRequired) kw.add("walk-in");
    if (/hack/i.test(e.title)) kw.add("hackathon");
    return {
      _id: e.id,
      title: e.title,
      name: e.title,
      url: e.url ?? null,
      start,
      end,
      endListed: !!e.end,
      place: e.place ?? null,
      organiser: e.organiser ?? null,
      walkIn: e.walkIn,
      tags: [...kw],
      location: point(e.lat, e.lng),
      source: e.source,
      asOf: new Date(e.asOf),
    };
  });
}

// Atlas Search index definitions (static mappings: only these fields are indexed).
export const VENUES_SEARCH_INDEX = "venues_search";
export const EVENTS_SEARCH_INDEX = "events_search";
export const VENUES_SEARCH_DEFINITION = {
  mappings: {
    dynamic: false,
    fields: {
      name: [{ type: "string" }, { type: "autocomplete", tokenization: "edgeGram", minGrams: 2, maxGrams: 15, foldDiacritics: true }],
      category: { type: "string" },
      tags: { type: "string" },
      address: { type: "string" },
      embed_text: { type: "string", analyzer: "lucene.english" }, // server16: text side of the vibe hybrid search
      location: { type: "geo" },
    },
  },
};
export const EVENTS_SEARCH_DEFINITION = {
  mappings: {
    dynamic: false,
    fields: {
      name: [{ type: "string" }, { type: "autocomplete", tokenization: "edgeGram", minGrams: 2, maxGrams: 15, foldDiacritics: true }],
      tags: { type: "string" },
      organiser: { type: "string" },
      location: { type: "geo" },
      start: { type: "date" },
      end: { type: "date" },
    },
  },
};

type Log = (msg: string) => void;

/** Create (or update) an Atlas Search index; on non-Atlas servers this is unsupported, so log and move on. */
async function ensureSearchIndex(db: Db, coll: string, name: string, definition: object, log: Log): Promise<string> {
  const c = db.collection(coll);
  try {
    const existing = await c.listSearchIndexes(name).toArray();
    if (existing.length) {
      await c.updateSearchIndex(name, definition);
      log(`  ${coll}: Atlas Search index "${name}" exists, definition updated (status ${String((existing[0] as { status?: string }).status ?? "?")})`);
      return "updated";
    }
    await c.createSearchIndex({ name, definition });
    log(`  ${coll}: Atlas Search index "${name}" created (builds in the background, ~1 min)`);
    return "created";
  } catch (err) {
    log(`  ${coll}: Atlas Search index "${name}" not created: ${(err as Error).message.split("\n")[0]} (fine on non-Atlas servers; $geoNear fallback is used)`);
    return "unsupported";
  }
}

async function upsertAll<T extends { _id: string }>(db: Db, coll: string, docs: T[]) {
  const ops: AnyBulkWriteOperation<T>[] = docs.map((d) => {
    const { _id, ...rest } = d;
    // $set, not replace: a re-seed keeps fields other scripts add (seed:vectors' embed_text / embedding).
    return { updateOne: { filter: { _id } as never, update: { $set: rest } as never, upsert: true } };
  });
  let upserted = 0;
  let modified = 0;
  for (let i = 0; i < ops.length; i += 1000) {
    const r = await db.collection<T>(coll).bulkWrite(ops.slice(i, i + 1000), { ordered: false });
    upserted += r.upsertedCount;
    modified += r.modifiedCount;
  }
  return { upserted, modified };
}

export async function seedAll(db: Db, log: Log = console.log) {
  const venues = venueDocs();
  const events = eventDocs();
  const v = await upsertAll(db, "venues", venues);
  log(`venues: ${venues.length} docs (${v.upserted} new, ${v.modified} refreshed in place)`);
  const e = await upsertAll(db, "events", events);
  log(`events: ${events.length} docs (${e.upserted} new, ${e.modified} refreshed in place)`);

  await db.collection("venues").createIndexes([
    { key: { location: "2dsphere" }, name: "location_2dsphere" },
    { key: { category: 1 }, name: "category_1" },
  ]);
  await db.collection("events").createIndexes([
    { key: { location: "2dsphere" }, name: "location_2dsphere" },
    { key: { start: 1, end: 1 }, name: "start_1_end_1" },
  ]);
  await db.collection("plan_runs").createIndexes([
    { key: { createdAt: -1 }, name: "createdAt_-1" },
    { key: { hub: 1 }, name: "hub_1" },
  ]);
  log("indexes: venues.location 2dsphere, venues.category, events.location 2dsphere, events.start+end, plan_runs.createdAt, plan_runs.hub");

  const vs = await ensureSearchIndex(db, "venues", VENUES_SEARCH_INDEX, VENUES_SEARCH_DEFINITION, log);
  const es = await ensureSearchIndex(db, "events", EVENTS_SEARCH_INDEX, EVENTS_SEARCH_DEFINITION, log);

  const counts = {
    venues: await db.collection("venues").countDocuments(),
    events: await db.collection("events").countDocuments(),
    plan_runs: await db.collection("plan_runs").countDocuments(),
  };
  log(`counts: venues=${counts.venues} events=${counts.events} plan_runs=${counts.plan_runs}`);
  return { counts, searchIndexes: { venues: vs, events: es } };
}
