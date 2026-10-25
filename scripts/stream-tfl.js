// So where? · creates and starts the Atlas Stream Processing processor for live TfL line status.
//
// Run from the repo root with mongosh connected to the Stream Processing workspace (not the cluster):
//   mongosh "$ATLAS_SP_URI" --tls --username "$ATLAS_SP_USER" --password "$ATLAS_SP_PASSWORD" scripts/stream-tfl.js
// Env (optional): SP_CLUSTER_CONN (default sowhere_cluster), SP_TFL_CONN (default tfl_api), SP_NAME (default tfl_line_status).
// Needs two Connection Registry entries: an Atlas cluster connection and an HTTPS connection to https://api.tfl.gov.uk/
// Idempotent: drops an existing processor with the same name first. Writes sowhere.line_status; DLQ sowhere.line_status_dlq.
const path = require("path");
const { streamPipeline, DB } = require(path.resolve("scripts/stream-tfl-pipeline.cjs"));

const name = process.env.SP_NAME || "tfl_line_status";
const cluster = process.env.SP_CLUSTER_CONN || "sowhere_cluster";
const tfl = process.env.SP_TFL_CONN || "tfl_api";
const pipeline = streamPipeline({ cluster, tfl });

// Re-runnable: remove an older processor of the same name (errors just mean there wasn't one).
try { sp[name].stop(); } catch (e) {}
try { sp[name].drop(); print(`dropped old ${name}`); } catch (e) {}
sp.createStreamProcessor(name, pipeline, { dlq: { connectionName: cluster, db: DB, coll: "line_status_dlq" } });
sp[name].start();
print(`started ${name}: every 60 s, TfL → ${DB}.line_status`);
sleep(70_000);
printjson(sp[name].stats());
