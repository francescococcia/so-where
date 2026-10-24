// npm run seed:mongo — loads the OSM snapshot venues and the Luma/Meetup seed events into MongoDB Atlas
// (database `sowhere`, collections `venues` and `events`), creates 2dsphere + Atlas Search indexes, and
// prints counts. Idempotent: upserts by OSM id / event id. Needs MONGODB_URI (env or .env.local / .env).
import dns from "node:dns";
import { existsSync, readFileSync } from "node:fs";
import { MongoClient } from "mongodb";
import { seedAll } from "../src/lib/mongo-seed.ts";

// Windows/home-router DNS often refuses SRV lookups (querySrv ECONNREFUSED); scripts only, never the app.
dns.setServers(["8.8.8.8", "1.1.1.1"]);

for (const f of [".env.local", ".env"]) {
  if (process.env.MONGODB_URI || !existsSync(f)) continue;
  const m = readFileSync(f, "utf8").match(/^\s*MONGODB_URI\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m);
  if (m) process.env.MONGODB_URI = m[1];
}
const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not set (env, .env.local or .env).");
  process.exit(1);
}
const dbName = process.env.MONGODB_DB || "sowhere";
const client = new MongoClient(uri, { appName: "so-where-seed", serverSelectionTimeoutMS: 15_000 });
try {
  await client.connect();
  console.log(`Connected to ${uri.replace(/\/\/[^@]*@/, "//<credentials>@").split("?")[0]} db=${dbName}`);
  await seedAll(client.db(dbName));
} catch (err) {
  console.error("Seed failed:", err?.message ?? err);
  process.exitCode = 1;
} finally {
  await client.close();
}
