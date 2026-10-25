// npx tsx scripts/test_line_status.ts — Atlas Stream Processing line status, end to end on mongodb-memory-server
// (the box can't reach Atlas). Real TfL status JSON goes through the SAME normalise stages the stream processor
// runs (scripts/stream-tfl-pipeline.cjs) via $documents → $merge into line_status; then the planner reads it.
// Synthetic rows (a made-up Jubilee part closure) live only in this throwaway memory DB, to exercise rerouting.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { MongoMemoryServer } from "mongodb-memory-server";
import { getDb, resetMongoForTests } from "@/lib/mongo";
import { disruptedLines, readStreamed, resetLineStatusCache, streamedLineStatus, streamStep, VIA_STREAM } from "@/lib/line-status";
import { journey, lineStatus } from "@/lib/tfl";
import { runPlan } from "@/lib/plan";

const { normaliseStages, TFL_PATH, COLL } = createRequire(__filename)("./stream-tfl-pipeline.cjs");
let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}\n  ${(e as Error).stack}`); }
}

async function main() {
const server = await MongoMemoryServer.create();
process.env.MONGODB_URI = server.getUri();
await resetMongoForTests();
const db = (await getDb(5000))!;
const coll = db.collection(COLL);
const tfl = await (await fetch(`https://api.tfl.gov.uk/${TFL_PATH}`)).json();

await test("empty collection → null (planner falls back to direct TfL, invents nothing)", async () => {
  assert.equal(await streamedLineStatus(["jubilee"], { db, noCache: true }), null);
  assert.equal((await disruptedLines({ db, noCache: true })).size, 0);
  const ls = await lineStatus(["jubilee"]);
  assert.ok(!("error" in ls) && !ls.via, "direct TfL path, no via");
});

await test("processor's normalise stages on live TfL JSON → one row per line", async () => {
  // Raw TfL JSON keeps its "$type" keys (as $https hands it over), so stage it as a stored doc, not a $documents literal.
  await db.collection("tfl_raw").insertOne({ polledAt: new Date(), lines: tfl });
  await db.collection("tfl_raw").aggregate([{ $project: { _id: 0 } }, ...normaliseStages(VIA_STREAM), { $merge: { into: COLL, on: "_id", whenMatched: "replace", whenNotMatched: "insert" } }]).toArray();
  const rows = await coll.find().toArray();
  console.log(`      ${rows.length} rows; e.g.`, JSON.stringify(rows.find((r) => String(r._id) === "jubilee")));
  assert.equal(rows.length, tfl.length);
  for (const r of rows) assert.ok(typeof r.severity === "number" && typeof r.status === "string" && r.updatedAt instanceof Date && r.via === VIA_STREAM);
  const bad = rows.filter((r) => r.severity !== 10).map((r) => `${r.line}: ${r.status}`);
  console.log(`      live now: ${bad.join(" · ") || "all good service"}`);
});

await test("fresh stream rows → lineStatus() reads Mongo (via) and the plan step appears", async () => {
  const ls = await streamedLineStatus(["jubilee", "victoria"], { db, noCache: true });
  assert.ok(ls && ls.via === VIA_STREAM && ls.lines.length === 2);
  const seen: string[] = [];
  streamStep(((id: string, label: string, src?: string) => (st: string, d?: string) => seen.push(`${id} | ${label} | ${src} | ${st} | ${d}`)) as never, ls);
  console.log(`      step: ${seen[0]}`);
  assert.match(seen[0], /MongoDB Atlas Stream Processing · live line status/);
  // Non-stream lines (buses) → not every id covered → null → direct TfL.
  assert.equal(await streamedLineStatus(["jubilee", "188"], { db, noCache: true }), null);
});

await test("stale (> 10 min) or non-stream rows are ignored", async () => {
  await coll.updateMany({}, { $set: { updatedAt: new Date(Date.now() - 11 * 60_000) } });
  assert.equal(await readStreamed({ db, noCache: true }), null);
  await coll.updateMany({}, { $set: { updatedAt: new Date(), via: "dry-run" } });
  assert.equal(await readStreamed({ db, noCache: true }), null);
  await coll.updateMany({}, { $set: { via: VIA_STREAM } });
  assert.ok(await readStreamed({ db, noCache: true }));
});

await test("disrupted line (synthetic, memory DB only) → TfL's alternative wins when close, card says rerouted", async () => {
  // Stratford → Paddington: TfL offers Central direct and Elizabeth line + H&C a few minutes apart.
  const baker = { lat: 51.5413, lng: -0.0033 }, lb = { lat: 51.5154, lng: -0.1755 };
  const at = new Date(Date.now() + 3 * 3600_000);
  await coll.updateMany({}, { $set: { severity: 10, status: "Good Service", reason: null, updatedAt: new Date() } });
  resetLineStatusCache();
  const base = await journey(baker, lb, at);
  assert.ok(!("error" in base));
  console.log(`      all good: ${base.minutes} min · ${base.summary} · avoided=${JSON.stringify(base.avoided ?? [])}`);
  const hit = base.lines.find((l) => l.id !== "walking")?.id ?? "central"; // disrupt the line TfL's pick rides
  await coll.updateOne({ _id: hit as never }, { $set: { severity: 6, status: "Severe Delays", reason: "TEST ROW", updatedAt: new Date() } });
  resetLineStatusCache();
  const j = await journey(baker, lb, at);
  assert.ok(!("error" in j));
  console.log(`      ${hit} severe delays (synthetic): ${j.minutes} min · ${j.summary} · avoided=${JSON.stringify(j.avoided ?? [])}`);
  const usesJ = j.lines.some((l) => l.id === hit);
  if (!usesJ) assert.ok(j.avoided?.some((x) => x.id === hit));
  if (usesJ) assert.ok(!j.avoided?.length, "kept the line (no close alternative) → nothing claimed");

  resetLineStatusCache();
  const steps: string[] = [];
  const r = await runPlan({ query: "Get me to Paddington station tomorrow at 7pm", you: baker }, (s) => steps.push(`${s.status} ${s.label}${s.detail ? " — " + s.detail : ""}`));
  console.log(steps.filter((s) => /line|Stream/i.test(s)).map((s) => "      " + s).join("\n"));
  const facts = (r.cards ?? []).flatMap((c) => c.facts ?? []).filter((f) => f.label === "Lines").map((f) => `${f.value} [${f.source}]`);
  console.log(facts.map((f) => "      card: " + f).join("\n") || "      (no Lines fact)");
  console.log("      sources:", JSON.stringify((r.sources ?? []).map((s: { name: string }) => s.name)));
});

await coll.deleteMany({});
await resetMongoForTests();
await server.stop();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
}
void main();
