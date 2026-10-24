# MongoDB Atlas in So where?

MongoDB Atlas is where the agent reads its places from and where it keeps its memory.

- **Venues**: 2,765 London OSM venues (pubs, bars, cafes, restaurants, free museums, galleries and markets). These come from the 24 Oct snapshot, stored as GeoJSON with 2dsphere and Atlas Search indexes.
- **Events**: the Luma seed (61 events), stored the same way, plus a start/end index.
- **Agent memory**: each finished plan writes one anonymised record to `plan_runs`. `/api/stats` aggregates those records, and the hub comparison uses them to break near-ties.

Everything is optional at runtime. If `MONGODB_URI` is unset, unreachable or slow (more than 2.5 s), `getDb()` returns `null` and the plan carries on with the existing Overpass → bundled snapshot path. A Mongo error never reaches the plan stream.

## Code

| File | What it does |
|---|---|
| `src/lib/mongo.ts` | Cached `MongoClient` (on `globalThis`, so it survives hot reload and warm lambdas). `getDb()` returns a `Db` or `null` (no URI, connect over 2.5 s, or an error; after a failure it waits 30 s before trying again). DB name: `MONGODB_DB` or `sowhere`. |
| `src/lib/mongo-seed.ts` | Builds the documents, creates indexes and Atlas Search indexes. Used by the seed script and the tests. |
| `scripts/seed_mongo.mjs` | `npm run seed:mongo`. Idempotent: upserts by `_id`, and creates or updates the indexes. Sets DNS to 8.8.8.8/1.1.1.1 so `mongodb+srv` lookups work on networks with broken DNS. That setting is script-only and is not in Vercel code. |
| `src/lib/mongo-venues.ts` | `findVenues()`: MongoDB first, then `findPlaces()` (Overpass → snapshot). `mongoEventsNear()` is the same idea for events. |
| `src/lib/plan-memory.ts` | `plan_runs` record builder (privacy filter), insert, hub tie-break, and the stats `$facet` pipeline. |
| `src/app/api/stats/route.ts` | `GET /api/stats` returns the aggregation as JSON, or `{available:false}` without Mongo. |

## Collections and indexes (`sowhere` database)

**`venues`** (`_id` = `"node/26699558"` / `"way/…"`)
- Fields: `name`, `category` (amenity or tourism), `amenity`, `tourism`, `address`, `opening_hours`, `check_date`, `fee`, `wheelchair`, `website`, `phone`.
- `tags`: normalised keywords such as `pub`, `drinks`, `coffee`, `free`, `wheelchair`, `outdoor`, and cuisine.
- `osm_tags`: the raw OSM tags, so opening-hours parsing is identical to the live path.
- `location`: GeoJSON Point.
- `source`, `asOf`.
- Indexes: `location_2dsphere`, `category_1`.
- Atlas Search index **`venues_search`**: `name` (string + autocomplete), `category`/`tags`/`address` (string), `location` (geo).

**`events`** (`_id` = Luma id)
- Fields: `title`/`name`, `url`, `start`/`end` (Date; end = listed end, or start + 3 h, as in `seedEventsOn`), `place`, `organiser`, `walkIn`, `tags`, `location`, `source`, `asOf`.
- Indexes: `location_2dsphere`, `start_1_end_1`.
- Atlas Search index **`events_search`**: `name` (string + autocomplete), `tags`/`organiser` (string), `location` (geo), `start`/`end` (date).

**`plan_runs`**: see below.
- Indexes: `createdAt_-1`, `hub_1`.

## How the plan queries it

Venue step for meet-halfway (500 m around the fair hub) and for near-me (1.2 km, or 2.5 km for free places):

1. **Atlas Search** (`venues_search`):
   ```js
   { $search: { index: "venues_search", compound: {
       filter: [{ geoWithin: { circle: { center: <hub Point>, radius: 500 }, path: "location" } }],
       must:   [{ text: { query: ["pub","bar"], path: ["category","tags"], fuzzy: { maxEdits: 1, prefixLength: 2 } } }] } } }
   ```
   Step text: `Searched 2,765 venues in MongoDB Atlas (Atlas Search, geo + text) · 39 within 500 m · …`. Step source: `MongoDB Atlas Search`.
2. If `$search` errors (index missing or not READY) or returns nothing, the plan uses **`$geoNear`** on the 2dsphere index with the equivalent category filter. Step text: `Searched 2,765 venues in MongoDB Atlas (2dsphere $geoNear; Atlas Search unavailable)`.
3. If MongoDB is unavailable, it falls back to the existing Overpass → snapshot path, with the original step text.

Either way, results are post-filtered with the same `matches()` rule as `osm.ts`, so cards are identical whichever path served them. The tests check this against the snapshot. The answer's sources list gains `MongoDB Atlas (OSM snapshot 24 Oct)`, with its as-of time.

Events (near-me with no venue type) use the same approach: `$search` geoWithin 8 km plus a `start` range, then `$geoNear` plus the same time predicate as `seedEventsOn`, then the bundled seed.

## Agent memory (`plan_runs`) and the privacy rule

**Never stored:** any coordinates (yours or the other person's), any place name you typed, the other person's name or area, the query text, the headline, the draft message, or step detail strings (they contain place names).

**Stored:**
- `intent`, `category`, and filter flags: walk-in, free, has budget, and max minutes.
- `hub`: the curated central hub chosen as the fair middle, such as "Borough". This is public, and it's what lets the agent learn.
- Venue card ids and kinds. Meet-halfway only, because near-me cards sit next to you.
- Card count, verdict counts (confirmed/likely/unknown/forecast), facts total, unknowns count.
- Step `{id, status, ms, source}`.
- `latencyMs`, the London hour of the plan, and the eval flags (all facts sourced, sources have as-of, draft omits their area, ≤ 3 cards).

**Hub suppression:** if the chosen hub is within 1 km of either person (for example "I'm at Waterloo" and Waterloo wins), then `hub` is stored as `null` with `hubSuppressed: true`, and card ids are dropped. That way, a record can never place a person.

The test suite asserts that a record built from a full plan result contains no coordinates, names, typed places or query text.

**Tie-break:** when two or more hubs are within 1 minute on worst-case journey time, they are reordered by how often each has been chosen before. The compare step then says so, e.g. `near-tie (2 hubs within 1 min) broken by past picks in MongoDB: Borough 2×, Bank 1×`. Otherwise TfL numbers decide alone.

**`GET /api/stats`** is one `$facet` aggregation. It returns:
- total plans, and plans in the last 24 h
- median latency
- plans by intent
- most-chosen hubs and venues
- facts confirmed / total and % confirmed
- venue source mix (Atlas Search vs $geoNear vs Overpass)
- eval pass rates

## Seeding Atlas (Windows)

You need Node 20+ and the repo on branch `mongo`. In PowerShell:

```powershell
cd C:\path\to\so-where
git checkout mongo
npm ci
$env:MONGODB_URI = "mongodb+srv://<user>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority&appName=so-where"
npm run seed:mongo
```

On cmd.exe, use `set MONGODB_URI=mongodb+srv://...` instead. You can also put `MONGODB_URI=...` in `.env.local`, which the script reads too.

The script prints document counts and the Atlas Search index status. The search indexes take about a minute to build. When `venues_search` and `events_search` show **READY** (Atlas UI → Search, or run the script again), `$search` is used. Until then the app transparently uses `$geoNear`.

Re-running the script is safe: it upserts and updates the index definitions.

**Vercel setup:**
- Set `MONGODB_URI` (and optionally `MONGODB_DB`, default `sowhere`) for Production and Preview.
- In Atlas Network Access, allow `0.0.0.0/0`, since Vercel has no fixed egress IPs.
- Then open `/api/stats` and run a plan: the venues step should read "Searched 2,765 venues in MongoDB Atlas (Atlas Search, geo + text)".

## Tests

`npm run test:mongo` runs against `mongodb-memory-server`. No Atlas is needed, and it downloads a mongod binary on first run. It covers:
- seeding and idempotency
- `$geoNear` venue results equal to the snapshot path, for pub, cafe and free
- `$geoNear` events equal to `seedEventsOn`
- `getDb()` returning null with no URI and within 2.5 s for an unreachable server
- the `plan_runs` privacy filter and insert
- the history tie-break
- the stats aggregation and the `/api/stats` handler
- two end-to-end `runPlan` calls (live TfL) that read from MongoDB and record a run

`$search` itself can't run on the memory server. The tests confirm it fails cleanly into `$geoNear`. Verify it on Atlas after seeding.
