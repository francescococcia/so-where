// npm run test:mongo — MongoDB logic against mongodb-memory-server (no Atlas needed): seed + idempotency,
// $geoNear fallback venue/event queries (Atlas Search isn't available locally, so this exercises the fallback),
// getDb() null paths, plan_runs insert + privacy, hub tie-break, and the /api/stats aggregation.
// One end-to-end runPlan (live TfL) checks the plan uses MongoDB and records an anonymised run.
import assert from "node:assert/strict";
import { MongoMemoryServer } from "mongodb-memory-server";
import { MongoClient } from "mongodb";
import snapshot from "@/data/osm-snapshot.json";
import { seedEvents, seedEventsOn } from "@/lib/events";
import { metresBetween } from "@/lib/geo";
import { londonParts, londonToUtc } from "@/lib/london-time";
import { getDb, resetMongoForTests } from "@/lib/mongo";
import { seedAll, venueDocs } from "@/lib/mongo-seed";
import { KIND_FILTER, findVenues, mongoEventsNear, mongoVenuesNear } from "@/lib/mongo-venues";
import { matches, type OsmKind } from "@/lib/osm";
import { planRunDoc, planStats, recordPlanRun, tieBreakByHistory } from "@/lib/plan-memory";
import type { PlanResultWithAgent } from "@/lib/plan-types";
import type { HubScore, Journey } from "@/lib/tfl";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  const t0 = Date.now();
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name} (${Date.now() - t0} ms)`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${(e as Error).message}`);
  }
}

const BOROUGH = { lat: 51.501199, lng: -0.09337 };
const SHOREDITCH = { lat: 51.529, lng: -0.083 };
const snap = snapshot as unknown as { elements: { type: string; id: number; lat: number; lng: number; tags: Record<string, string> }[] };
const snapIds = (kind: OsmKind, c: { lat: number; lng: number }, r: number) =>
  snap.elements.filter((e) => matches(kind, e.tags, e.type) && metresBetween(c, e) <= r).map((e) => `${e.type}/${e.id}`).sort();

function fakeResult(over: Partial<PlanResultWithAgent> = {}): PlanResultWithAgent {
  const f = (verdict: "confirmed" | "likely" | "unknown" | "forecast") => ({ label: "x", value: "y", verdict, source: "TfL", asOf: "2026-10-24T18:00:00Z" });
  return {
    intent: "meet_halfway",
    query: "Drinks with Priya, I'm at Old Street, she's in Brixton",
    headline: "Borough is the fair middle",
    when: "2026-10-30T20:00:00.000Z",
    you: { lat: 51.5257, lng: -0.0877 },
    them: { area: "Brixton", center: { lat: 51.4627, lng: -0.1145 }, radiusM: 500 },
    middle: { name: "Borough", location: BOROUGH },
    filters: { category: "pub", maxMinutes: 30 },
    cards: [{ id: "osm-node-1", kind: "venue", name: "The Pub", subtitle: "Pub", location: BOROUGH, legs: [], facts: [f("confirmed"), f("confirmed"), f("likely"), f("unknown")], why: "" }],
    unknowns: ["a"],
    sources: [{ name: "TfL", asOf: "2026-10-24T18:00:00Z" }],
    draftMessage: "Fri 20:00 at The Pub?",
    steps: [{ id: "parse", label: "Reading", status: "done", detail: 'you: "Old Street"', ms: 3 }, { id: "venues", label: "Finding", status: "done", source: "MongoDB Atlas $geoNear", detail: "x", ms: 40 }],
    ...over,
  };
}

(async () => {
  const server = await MongoMemoryServer.create();
  const client = await new MongoClient(server.getUri()).connect();
  const db = client.db("sowhere");

  await test("seed: venues/events loaded with GeoJSON + 2dsphere, counts printed", async () => {
    const r = await seedAll(db, () => {});
    assert.equal(r.counts.venues, venueDocs().length);
    assert.equal(r.counts.venues, 2765);
    assert.equal(r.counts.events, seedEvents().length);
    const v = await db.collection("venues").findOne({ _id: "node/26699558" as never });
    assert.ok(v && v.location.type === "Point" && v.location.coordinates[0] < 0 && v.name === "The Flying Horse" && v.category === "pub" && v.opening_hours && v.check_date === "2026-01-07");
    const booth = await db.collection("venues").findOne({ _id: "node/8071803025" as never }); // "Restored K6 phone booth", tourism=museum
    assert.ok(booth && booth.visitable === false && booth.tags.includes("unvisitable"));
    assert.equal(await db.collection("venues").countDocuments({ $and: [{ _id: "node/8071803025" as never }, KIND_FILTER.free] }), 0);
    assert.ok(v && "outdoor_seating" in v && "indoor_seating" in v && "covered" in v && "beer_garden" in v); // normalised seating fields
    assert.ok((await db.collection("venues").countDocuments({ indoor_seating: true, tags: "indoor" })) > 100);
    assert.ok((await db.collection("venues").countDocuments({ outdoor_seating: true, tags: "outdoor" })) > 100);
    const idx = await db.collection("venues").indexes();
    assert.ok(idx.some((i) => i.key.location === "2dsphere"));
    assert.equal(r.searchIndexes.venues, "unsupported"); // not Atlas: logged, not thrown
  });

  await test("seed: idempotent (second run inserts nothing, documents unchanged)", async () => {
    const before = JSON.stringify(await db.collection("venues").find().sort({ _id: 1 }).toArray());
    const logs: string[] = [];
    const r = await seedAll(db, (m) => logs.push(m));
    assert.equal(r.counts.venues, 2765);
    assert.equal(r.counts.events, seedEvents().length);
    assert.ok(logs.some((l) => /^venues: 2765 docs \(0 new/.test(l)), logs.join("\n"));
    assert.ok(logs.some((l) => /^events: \d+ docs \(0 new/.test(l)), logs.join("\n"));
    assert.equal(JSON.stringify(await db.collection("venues").find().sort({ _id: 1 }).toArray()), before);
  });

  for (const [kind, c, r] of [["pub", BOROUGH, 500], ["cafe", SHOREDITCH, 1200], ["free", SHOREDITCH, 2500]] as const) {
    await test(`venues: $geoNear fallback for ${kind} within ${r} m matches the snapshot path exactly`, async () => {
      const res = await mongoVenuesNear(kind, c, r, db);
      assert.ok(res, "null result");
      assert.match(res.via!, /^Searched 2,765 venues in MongoDB Atlas \(2dsphere \$geoNear; Atlas Search unavailable\)$/);
      assert.equal(res.stepSource, "MongoDB Atlas $geoNear");
      assert.equal(res.source, "MongoDB Atlas (OSM snapshot 24 Oct)");
      const got = res.places.map((p) => `${p.type}/${p.id}`).sort();
      assert.deepEqual(got, snapIds(kind, c, r));
      assert.ok(got.length > 0);
      for (let i = 1; i < res.places.length; i++) assert.ok(res.places[i - 1].distanceM <= res.places[i].distanceM);
    });
  }

  await test("events: $geoNear + time fallback matches seedEventsOn within 8 km", async () => {
    const ev = seedEvents();
    const counts = new Map<string, number>();
    for (const e of ev) {
      const d = londonParts(new Date(e.start)).date;
      if (metresBetween(SHOREDITCH, e) < 8000) counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    const date = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const at = londonToUtc(date, 9, 0);
    const dayEnd = new Date(londonToUtc(date, 23, 59).getTime() + 60_000);
    const toDate = (d: Date) => londonParts(d).date;
    const res = await mongoEventsNear(SHOREDITCH, 8000, at, date, dayEnd, toDate, db);
    assert.ok(res);
    const want = seedEventsOn(date, at, toDate).filter((e) => metresBetween(SHOREDITCH, e) < 8000).map((e) => e.id).sort();
    assert.deepEqual(res.events.map((e) => e.id).sort(), want);
    assert.ok(want.length > 0, `no events on ${date}`);
    assert.match(res.via, /events in MongoDB Atlas \(2dsphere \$geoNear \+ time/);
  });

  await test("getDb(): null without MONGODB_URI, null within ~2.5 s for an unreachable server, a Db when reachable", async () => {
    delete process.env.MONGODB_URI;
    await resetMongoForTests();
    assert.equal(await getDb(), null);
    process.env.MONGODB_URI = "mongodb://127.0.0.1:1/?directConnection=true";
    const t0 = Date.now();
    assert.equal(await getDb(), null);
    assert.ok(Date.now() - t0 < 3200, `took ${Date.now() - t0} ms`);
    const t1 = Date.now();
    assert.equal(await getDb(), null); // failure is cached: no second 2.5 s wait
    assert.ok(Date.now() - t1 < 100);
    assert.equal(await mongoVenuesNear("pub", BOROUGH, 500), null);
    await resetMongoForTests();
    process.env.MONGODB_URI = server.getUri();
    const d = await getDb();
    assert.ok(d && d.databaseName === "sowhere");
    const v = await findVenues("pub", BOROUGH, 500);
    assert.equal(v.source, "MongoDB Atlas (OSM snapshot 24 Oct)");
  });

  await test("plan_runs: anonymised doc has no coordinates, typed places or query text", async () => {
    const doc = planRunDoc(fakeResult(), 1234);
    const json = JSON.stringify(doc);
    for (const bad of ["Brixton", "Old Street", "Priya", '"lat"', '"lng"', "51.", "-0.0", "-0.1", '"query"', "headline", "draftMessage", "Fri 20:00", "The Pub"]) assert.ok(!json.includes(bad), `leaked ${bad}: ${json}`);
    assert.equal(doc.hub, "Borough");
    assert.deepEqual(doc.cards, [{ id: "osm-node-1", kind: "venue" }]);
    assert.deepEqual(doc.verdicts, { confirmed: 2, likely: 1, unknown: 1, forecast: 0 });
    assert.equal(doc.venueSource, "MongoDB Atlas $geoNear");
    const atHub = planRunDoc(fakeResult({ you: { lat: 51.5013, lng: -0.0935 } }), 1);
    assert.equal(atHub.hub, null);
    assert.equal(atHub.hubSuppressed, true);
    assert.deepEqual(atHub.cards, []);
    const nearMe = planRunDoc(fakeResult({ intent: "near_me", middle: undefined, them: undefined }), 1);
    assert.deepEqual(nearMe.cards, []);
    assert.equal(nearMe.cardCount, 1);
  });

  await test("plan_runs: recordPlanRun inserts (and returns false without Mongo)", async () => {
    await db.collection("plan_runs").deleteMany({});
    assert.equal(await recordPlanRun(fakeResult(), 1000, db), true);
    assert.equal(await recordPlanRun(fakeResult(), 3000, db), true);
    assert.equal(await recordPlanRun(fakeResult({ middle: { name: "Bank", location: { lat: 51.513395, lng: -0.089095 } } }), 2000, db), true);
    assert.equal(await recordPlanRun(fakeResult(), 1, null), false);
    assert.equal(await db.collection("plan_runs").countDocuments(), 3);
  });

  await test("hub tie-break: near-tied hubs ordered by past picks", async () => {
    const j = (m: number): Journey => ({ minutes: m, summary: "", lines: [], path: [], segments: [], fetchedAt: "", ms: 0 });
    const h = (name: string, a: number, b: number): HubScore => ({ hub: { name, id: name, tflName: name, lat: 0, lng: 0 }, a: j(a), b: j(b), worst: Math.max(a, b), gap: Math.abs(a - b) });
    const ranked = [h("Bank", 20, 20), h("Borough", 21, 19), h("Victoria", 30, 10)];
    const note = await tieBreakByHistory(ranked, db);
    assert.equal(ranked[0].hub.name, "Borough");
    assert.match(note ?? "", /broken by past picks in MongoDB: Borough 2×, Bank 1×/);
    const clear = [h("Bank", 15, 15), h("Borough", 21, 19)];
    assert.equal(await tieBreakByHistory(clear, db), null);
    assert.equal(clear[0].hub.name, "Bank");
  });

  await test("/api/stats aggregation: totals, median latency, top hubs, % confirmed", async () => {
    const s = await planStats(db);
    assert.ok(s);
    assert.equal(s.totalPlans, 3);
    assert.equal(s.medianLatencyMs, 2000);
    assert.deepEqual(s.topHubs, [{ hub: "Borough", count: 2 }, { hub: "Bank", count: 1 }]);
    assert.equal(s.facts.total, 12);
    assert.equal(s.facts.confirmed, 6);
    assert.equal(s.facts.pctConfirmed, 50);
    assert.equal(s.evals.draftPrivacyPct, 100);
    const { GET } = await import("@/app/api/stats/route");
    const body = await (await GET()).json();
    assert.equal(body.available, true);
    assert.equal(body.totalPlans, 3);
  });

  await test("end-to-end runPlan (live TfL) uses MongoDB venues and records an anonymised plan_run", async () => {
    const { runPlan, planRunWrite } = await import("@/lib/plan");
    const before = await db.collection("plan_runs").countDocuments();
    const steps: { id: string; detail?: string; source?: string }[] = [];
    const r = await runPlan({ query: "Pub halfway between Old Street and Brixton on Thursday at 7" }, (s) => steps.push(s));
    const venues = r.steps.find((s) => s.id === "venues");
    console.log("      venues step:", venues?.source, "|", venues?.detail);
    console.log("      compare step:", r.steps.find((s) => s.id === "compare")?.detail);
    assert.match(venues?.detail ?? "", /Searched 2,765 venues in MongoDB Atlas/);
    assert.ok(r.sources.some((s) => s.name === "MongoDB Atlas (OSM snapshot 24 Oct)"), JSON.stringify(r.sources));
    assert.ok(r.cards.length >= 1);
    assert.equal(await planRunWrite(r), true, "plan_runs insert should complete (route awaits this before closing)");
    const last = await db.collection("plan_runs").find().sort({ createdAt: -1 }).limit(1).next();
    assert.equal(await db.collection("plan_runs").countDocuments(), before + 1);
    const json = JSON.stringify(last);
    for (const bad of ["Brixton", "Old Street", '"lat"', '"lng"', "51.", '"query"']) assert.ok(!json.includes(bad), `leaked ${bad}: ${json}`);
    console.log("      stored:", json.slice(0, 400), "…");
  });

  await test("events end-to-end: near-me plan reads events from MongoDB", async () => {
    const { runPlan } = await import("@/lib/plan");
    const r = await runPlan({ query: "Free things to do near me tomorrow afternoon", you: SHOREDITCH });
    const venues = r.steps.find((s) => s.id === "venues");
    console.log("      venues step:", venues?.source, "|", venues?.detail);
    assert.match(venues?.detail ?? "", /events in MongoDB Atlas/);
  });

  await test("place-snap: $geoNear ≤300 m + fuzzy name ('THE KINGS ARMS' → The Kings Arms, Roupell St)", async () => {
    const { snapPlace } = await import("@/lib/place-snap");
    const r = await snapPlace({ name: "THE KINGS ARMS", kind: "pub", signText: null, cuisine: null, confidence: 0.9, vibe: null }, { you: { lat: 51.505, lng: -0.11 } }, { db, blurb: { llm: null, fetch: (async () => new Response("{}", { status: 404 })) as typeof fetch } });
    assert.equal(r.place?.name, "The Kings Arms");
    assert.equal(r.place?.facts.find((f) => f.label === "Matched")?.source, "MongoDB Atlas $geoNear");
    assert.equal(r.suggestedQuery, "Meet at The Kings Arms");
  });

  await client.close();
  await resetMongoForTests();
  await server.stop();
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
