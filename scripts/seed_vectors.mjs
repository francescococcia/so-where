// npm run seed:vectors — MongoDB Atlas Vector Search for vibe asks. Idempotent and batched:
//  1. upserts every snapshot venue (same docs as seed:mongo, $set so nothing else is lost),
//  2. builds `embed_text` from each venue's own OSM data and sets `lat`/`lng` (vector-search filter fields),
//  3. embeds only venues whose text/model changed (Gemini gemini-embedding-001, 768 dims, 100 per request),
//  4. creates/updates the `venues_vector` vector index and the `venues_search` index (adds embed_text).
//     Default: Atlas Automated Embedding (autoEmbed, Voyage AI voyage-4) on embed_text. `--index=gemini` indexes the
//     stored Gemini vectors instead (Atlas can't mix both in one index; this tier allows 3 search indexes).
//     `--no-gemini` skips step 3.
// Needs MONGODB_URI and GEMINI_API_KEY (env or .env.local / .env). Prints counts, never secrets.
// `--wait` polls until both indexes are queryable.
import dns from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { seedAll, VENUES_SEARCH_INDEX, VENUES_SEARCH_DEFINITION } from "../src/lib/mongo-seed.ts";
import { AUTO_EMBED_MODEL, EMBED_DIMS, EMBED_MODEL, VECTOR_INDEX, vectorIndexDefinition, embedHash, embedText, geminiEmbed } from "../src/lib/mongo-vectors.ts";

dns.setServers(["8.8.8.8", "1.1.1.1"]); // scripts only (Windows SRV lookups), never the app
for (const f of [".env.local", ".env"]) {
  if (!existsSync(f)) continue;
  for (const k of ["MONGODB_URI", "GEMINI_API_KEY"]) {
    if (process.env[k]) continue;
    const m = readFileSync(f, "utf8").match(new RegExp(`^\\s*${k}\\s*=\\s*["']?([^"'\\r\\n]+)["']?\\s*$`, "m"));
    if (m) process.env[k] = m[1];
  }
}
const missing = ["MONGODB_URI", ...(process.argv.includes("--index=gemini") ? ["GEMINI_API_KEY"] : [])].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing: ${missing.join(", ")} (env, .env.local or .env).`);
  process.exit(1);
}
const MODE = process.argv.includes("--index=gemini") ? "gemini" : "voyage";
const SKIP_GEMINI = process.argv.includes("--no-gemini") || !process.env.GEMINI_API_KEY;
const BATCH = 100;
const PARALLEL = 2;
const client = new MongoClient(process.env.MONGODB_URI, { appName: "so-where-seed-vectors", serverSelectionTimeoutMS: 15_000 });
const t0 = Date.now();
try {
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || "sowhere");
  await seedAll(db, (m) => console.log("seed:", m));
  const coll = db.collection("venues");
  const docs = await coll.find({}, { projection: { name: 1, category: 1, osm_tags: 1, location: 1, embed_hash: 1 } }).toArray();
  const todo = [];
  const meta = [];
  for (const d of docs) {
    const text = embedText(d);
    const hash = embedHash(text);
    meta.push({ updateOne: { filter: { _id: d._id }, update: { $set: { embed_text: text, lat: d.location.coordinates[1], lng: d.location.coordinates[0] } } } });
    if (!SKIP_GEMINI && d.embed_hash !== hash) todo.push({ _id: d._id, text, hash });
  }
  for (let i = 0; i < meta.length; i += 1000) await coll.bulkWrite(meta.slice(i, i + 1000), { ordered: false });
  console.log(`embed_text + lat/lng set on ${docs.length} venues; ${SKIP_GEMINI ? "Gemini vectors skipped" : `${todo.length} need (re-)embedding with ${EMBED_MODEL} (${EMBED_DIMS} dims)`}`);
  let done = 0;
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  async function run(b, tries = 8) {
    try {
      const vecs = await geminiEmbed(b.map((x) => x.text), "RETRIEVAL_DOCUMENT", 60_000);
      await coll.bulkWrite(b.map((x, j) => ({ updateOne: { filter: { _id: x._id }, update: { $set: { embedding: vecs[j], embed_hash: x.hash, embed_model: EMBED_MODEL } } } })), { ordered: false });
      done += b.length;
      if (done % 1000 < BATCH || done === todo.length) console.log(`  embedded ${done}/${todo.length}`);
    } catch (e) {
      if (tries <= 1) throw e;
      await new Promise((r) => setTimeout(r, 8000 * (9 - tries)));
      return run(b, tries - 1);
    }
  }
  for (let i = 0; i < batches.length; i += PARALLEL) await Promise.all(batches.slice(i, i + PARALLEL).map((b) => run(b)));

  async function ensure(name, type, definition) {
    const ex = await coll.listSearchIndexes(name).toArray();
    if (ex.length) { await coll.updateSearchIndex(name, definition); return `updated (was ${ex[0].status})`; }
    await coll.createSearchIndex({ name, type, definition });
    return "created";
  }
  console.log(`index ${VECTOR_INDEX} (vectorSearch, ${MODE === "voyage" ? `autoEmbed ${AUTO_EMBED_MODEL} on embed_text` : `${EMBED_MODEL} vectors`}): ${await ensure(VECTOR_INDEX, "vectorSearch", vectorIndexDefinition(MODE))}`);
  console.log(`index ${VENUES_SEARCH_INDEX} (search, + embed_text): ${await ensure(VENUES_SEARCH_INDEX, "search", VENUES_SEARCH_DEFINITION)}`);
  const status = async () => Object.fromEntries((await coll.listSearchIndexes().toArray()).map((x) => [x.name, `${x.status}${x.queryable ? " queryable" : ""}`]));
  let st = await status();
  if (process.argv.includes("--wait")) {
    for (let i = 0; i < 60 && !(String(st[VECTOR_INDEX]).startsWith("READY") && String(st[VENUES_SEARCH_INDEX]).startsWith("READY")); i++) {
      await new Promise((r) => setTimeout(r, 5000));
      st = await status();
    }
  }
  console.log("search indexes:", JSON.stringify(st));
  console.log(`venues with embed_text: ${await coll.countDocuments({ embed_text: { $type: "string" } })} · with Gemini embedding: ${await coll.countDocuments({ embedding: { $exists: true } })}/${await coll.countDocuments()} · ${((Date.now() - t0) / 1000).toFixed(1)} s`);
} catch (err) {
  console.error("seed:vectors failed:", String(err?.message ?? err).split("\n")[0]);
  process.exitCode = 1;
} finally {
  await client.close();
}
