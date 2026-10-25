// Venue and event lookups from MongoDB Atlas for the plan pipeline.
// Order: Atlas Search ($search compound: geoWithin circle + fuzzy text) → 2dsphere $geoNear → null.
// A null return means "Mongo unavailable": callers fall back to the bundled snapshot / Overpass path.
import type { Db, Document } from "mongodb";
import type { SeedEvent } from "@/lib/events";
import { metresBetween } from "@/lib/geo";
import { MIN_CANDIDATES, OVERPASS_LIVE, findPlaces, livePlaces, matches, snapshotPlaces, type OverpassDeps, type OsmKind, type OsmPlace, type OsmResult } from "@/lib/osm";
import type { LatLng } from "@/lib/plan-types";
import { getDb, withTimeout } from "@/lib/mongo";
import { EVENTS_SEARCH_INDEX, VENUES_SEARCH_INDEX, type EventDoc, type VenueDoc } from "@/lib/mongo-seed";

const QUERY_BUDGET_MS = 2500;
const LIMIT = 300;

/** Text terms per venue kind, matched (fuzzy) against `category` and `tags` in Atlas Search. */
export const KIND_TERMS: Record<OsmKind, string[]> = {
  pub: ["pub", "bar", "biergarten"],
  cafe: ["cafe", "coffee"],
  restaurant: ["restaurant"],
  free: ["museum", "gallery", "arts_centre", "marketplace", "free"],
};

/** Equivalent plain-MongoDB filter for the $geoNear fallback (same rules as osm.ts `matches`). */
export const KIND_FILTER: Record<OsmKind, Document> = {
  pub: { category: { $in: ["pub", "bar", "biergarten"] }, name: { $ne: null } },
  cafe: { category: "cafe", name: { $ne: null } },
  restaurant: { category: "restaurant", name: { $ne: null } },
  free: { fee: "no", visitable: { $ne: false }, $or: [{ tourism: { $in: ["museum", "gallery"] } }, { amenity: { $in: ["marketplace", "arts_centre"] } }] },
};

const geoPoint = (p: LatLng) => ({ type: "Point" as const, coordinates: [p.lng, p.lat] as [number, number] });
const dayLabel = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
const fmtN = (n: number) => n.toLocaleString("en-GB");
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 120);

export const mongoVenueLabel = (asOf: Date) => `MongoDB Atlas (OSM snapshot ${dayLabel(asOf)})`;
export const mongoEventLabel = (asOf: Date) => `MongoDB Atlas (Luma seed ${dayLabel(asOf)})`;

const totals = new Map<string, { n: number; at: number }>();
async function total(db: Db, coll: string) {
  const hit = totals.get(coll);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.n;
  const n = await db.collection(coll).estimatedDocumentCount();
  totals.set(coll, { n, at: Date.now() });
  return n;
}

export function venueSearchPipeline(kind: OsmKind, center: LatLng, radiusM: number): Document[] {
  return [
    {
      $search: {
        index: VENUES_SEARCH_INDEX,
        compound: {
          filter: [{ geoWithin: { circle: { center: geoPoint(center), radius: radiusM }, path: "location" } }],
          must: [{ text: { query: KIND_TERMS[kind], path: ["category", "tags"], fuzzy: { maxEdits: 1, prefixLength: 2 } } }],
          mustNot: [{ text: { query: "unvisitable", path: "tags" } }], // phone boxes, plaques… (seed tag)
        },
      },
    },
    { $limit: LIMIT },
    { $project: { osmType: 1, osmId: 1, osm_tags: 1, location: 1, asOf: 1, score: { $meta: "searchScore" } } },
  ];
}

export function venueGeoNearPipeline(kind: OsmKind, center: LatLng, radiusM: number): Document[] {
  return [
    { $geoNear: { near: geoPoint(center), distanceField: "distanceM", maxDistance: radiusM, spherical: true, query: KIND_FILTER[kind] } },
    { $limit: LIMIT },
    { $project: { osmType: 1, osmId: 1, osm_tags: 1, location: 1, asOf: 1, distanceM: 1 } },
  ];
}

type VenueRow = Pick<VenueDoc, "_id" | "osmType" | "osmId" | "osm_tags" | "location" | "asOf">;

/** Venues of `kind` within `radiusM` of `center` from MongoDB, shaped like an OSM result; null if Mongo is unavailable. */
export async function mongoVenuesNear(kind: OsmKind, center: LatLng, radiusM: number, dbIn?: Db | null): Promise<OsmResult | null> {
  const t0 = Date.now();
  try {
    const db = dbIn === undefined ? await getDb() : dbIn;
    if (!db) return null;
    return await withTimeout(
      (async (): Promise<OsmResult | null> => {
        const n = await total(db, "venues");
        if (!n) return null; // not seeded
        const coll = db.collection<VenueDoc>("venues");
        let rows: VenueRow[] = [];
        let method = "Atlas Search, geo + text";
        let stepSource = "MongoDB Atlas Search";
        try {
          rows = await coll.aggregate<VenueRow>(venueSearchPipeline(kind, center, radiusM), { maxTimeMS: 2000 }).toArray();
          if (!rows.length) throw new Error("no Atlas Search hits");
        } catch (e) {
          rows = await coll.aggregate<VenueRow>(venueGeoNearPipeline(kind, center, radiusM), { maxTimeMS: 2000 }).toArray();
          method = `2dsphere $geoNear; Atlas Search ${/no Atlas Search hits/.test(errText(e)) ? "returned nothing" : "unavailable"}`;
          stepSource = "MongoDB Atlas $geoNear";
        }
        const places: OsmPlace[] = rows
          .map((r) => {
            const location = { lat: r.location.coordinates[1], lng: r.location.coordinates[0] };
            return { type: r.osmType, id: r.osmId, location, tags: r.osm_tags ?? {}, distanceM: metresBetween(center, location) };
          })
          .filter((p) => p.distanceM <= radiusM && matches(kind, p.tags, p.type))
          .sort((a, b) => a.distanceM - b.distanceM);
        const asOf = rows.reduce<Date | null>((m, r) => (r.asOf && (!m || r.asOf > m) ? r.asOf : m), null) ?? new Date();
        return {
          places,
          source: mongoVenueLabel(asOf),
          asOf: asOf.toISOString(),
          live: false,
          ms: Date.now() - t0,
          note: `Venues come from the OSM snapshot of ${dayLabel(asOf)} stored in MongoDB Atlas, not a live Overpass call`,
          via: `Searched ${fmtN(n)} venues in MongoDB Atlas (${method})`,
          stepSource,
        };
      })(),
      QUERY_BUDGET_MS,
      "MongoDB venue query",
    );
  } catch {
    return null;
  }
}

/**
 * Venue finder for the plan: MongoDB Atlas first. When Atlas has fewer than MIN_CANDIDATES for the category
 * (it only holds the seeded hubs), the bundled OSM snapshot (with the outer-hub extract) tops it up, then live
 * Overpass (mirrors, 12 s budget, 10-min in-process cache). Live results are used in memory only: nothing is
 * written back to Atlas from the request path. No MongoDB: live Overpass → bundled snapshot.
 */
export async function findVenues(kind: OsmKind, center: LatLng, radiusM: number, deps?: { mongo?: OsmResult | null; overpass?: OverpassDeps }): Promise<OsmResult> {
  const m = deps && "mongo" in deps ? deps.mongo ?? null : await mongoVenuesNear(kind, center, radiusM);
  if (!m) return findPlaces(kind, center, radiusM, deps?.overpass);
  if (m.places.length >= MIN_CANDIDATES) return m;
  const key = (p: OsmPlace) => `${p.type}/${p.id}`;
  const seen = new Set(m.places.map(key));
  const snap = snapshotPlaces(kind, center, radiusM).places.filter((p) => !seen.has(key(p)));
  for (const p of snap) seen.add(key(p));
  const out: OsmResult = { ...m, places: [...m.places, ...snap], more: [...(m.more ?? [])] };
  const bits = [`${m.places.length} in Atlas`];
  if (snap.length) {
    bits.push(`+ ${snap.length} from the bundled OSM snapshot`);
    out.more!.push({ source: "OSM snapshot", asOf: snapshotPlaces(kind, center, 0).asOf });
  }
  if (out.places.length < MIN_CANDIDATES) {
    const live = await livePlaces(kind, center, radiusM, deps?.overpass);
    if (live.ok) {
      const add = live.places.filter((p) => !seen.has(key(p)));
      out.places = [...out.places, ...add];
      bits.push(`+ ${add.length} from ${OVERPASS_LIVE.replace(")", `, ${live.mirror}${live.cached ? ", cached" : ""})`)}`);
      out.more!.push({ source: OVERPASS_LIVE, asOf: live.fetchedAt });
      out.live = true;
      out.stepSource = `${m.stepSource ?? m.source} + ${OVERPASS_LIVE}`;
    } else bits.push(`live Overpass failed (${live.error})`);
  }
  out.places.sort((a, b) => a.distanceM - b.distanceM);
  out.via = `${m.via ?? m.source} · ${bits.join(" ")}`;
  if (out.live) delete out.note;
  return out;
}

export function eventSearchPipeline(center: LatLng, radiusM: number, at: Date, dayEnd: Date): Document[] {
  return [
    {
      $search: {
        index: EVENTS_SEARCH_INDEX,
        compound: {
          filter: [
            { geoWithin: { circle: { center: geoPoint(center), radius: radiusM }, path: "location" } },
            { range: { path: "end", gt: at } },
            { range: { path: "start", lt: dayEnd } },
          ],
        },
      },
    },
    { $limit: LIMIT },
  ];
}

export function eventGeoNearPipeline(center: LatLng, radiusM: number, at: Date, dayEnd: Date): Document[] {
  return [
    { $geoNear: { near: geoPoint(center), distanceField: "distanceM", maxDistance: radiusM, spherical: true, query: { end: { $gt: at }, start: { $lt: dayEnd } } } },
    { $limit: LIMIT },
  ];
}

export type MongoEvents = { events: SeedEvent[]; source: string; asOf: string; via: string; stepSource: string };

/**
 * Events within `radiusM` of `center` that are on `londonDate` (or running at `at`) and haven't ended by `at`
 * (same rule as seedEventsOn), from MongoDB; null when Mongo is unavailable or not seeded.
 */
export async function mongoEventsNear(
  center: LatLng,
  radiusM: number,
  at: Date,
  londonDate: string,
  dayEnd: Date,
  toLondonDate: (d: Date) => string,
  dbIn?: Db | null,
): Promise<MongoEvents | null> {
  try {
    const db = dbIn === undefined ? await getDb() : dbIn;
    if (!db) return null;
    return await withTimeout(
      (async (): Promise<MongoEvents | null> => {
        const n = await total(db, "events");
        if (!n) return null;
        const coll = db.collection<EventDoc>("events");
        let rows: EventDoc[];
        let method = "Atlas Search, geo + time";
        let stepSource = "MongoDB Atlas Search";
        try {
          rows = await coll.aggregate<EventDoc>(eventSearchPipeline(center, radiusM, at, dayEnd), { maxTimeMS: 2000 }).toArray();
        } catch {
          rows = await coll.aggregate<EventDoc>(eventGeoNearPipeline(center, radiusM, at, dayEnd), { maxTimeMS: 2000 }).toArray();
          method = "2dsphere $geoNear + time; Atlas Search unavailable";
          stepSource = "MongoDB Atlas $geoNear";
        }
        const events: SeedEvent[] = rows
          .filter((r) => (toLondonDate(r.start) === londonDate || (r.start <= at && r.end > at)) && r.end > at)
          .map((r) => ({
            id: r._id,
            title: r.title,
            url: r.url ?? undefined,
            start: r.start.toISOString(),
            end: r.endListed ? r.end.toISOString() : undefined,
            lat: r.location.coordinates[1],
            lng: r.location.coordinates[0],
            place: r.place ?? undefined,
            organiser: r.organiser ?? undefined,
            source: r.source,
            asOf: r.asOf.toISOString(),
            walkIn: r.walkIn,
          }));
        const asOf = rows.reduce<Date | null>((m, r) => (!m || r.asOf > m ? r.asOf : m), null) ?? new Date();
        return { events, source: mongoEventLabel(asOf), asOf: asOf.toISOString(), via: `Searched ${fmtN(n)} events in MongoDB Atlas (${method})`, stepSource };
      })(),
      QUERY_BUDGET_MS,
      "MongoDB event query",
    );
  } catch {
    return null;
  }
}
