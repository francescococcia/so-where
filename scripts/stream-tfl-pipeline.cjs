// So where? · MongoDB Atlas Stream Processing pipeline for live TfL line status.
// Shared by scripts/stream-tfl.js (the real processor, run in mongosh against the Stream Processing
// workspace) and scripts/stream-tfl-dryrun.mjs (the same normalise stages run once on the cluster with
// $documents, writing to a separate dry-run collection the planner never reads).
//
// Flow: cron $source (every 60 s) → $https GET TfL /Line/Mode/…/Status → one doc per line →
//       {_id: line id, line, mode, severity, status, reason, validUntil, updatedAt, via} → $merge line_status.
// No $$NOW / $$ROOT (not available in stream processing): updatedAt is the cron's scheduled time.

const TFL_PATH = "Line/Mode/tube,elizabeth-line,dlr,overground/Status";
const DB = "sowhere";
const COLL = "line_status";
const VIA_STREAM = "atlas-stream-processing";

/** Worst (lowest statusSeverity) status of a line, then the flat shape the planner reads. */
function normaliseStages(via) {
  const worst = {
    $reduce: {
      input: { $ifNull: ["$lines.lineStatuses", []] },
      initialValue: null,
      in: { $cond: [{ $or: [{ $eq: ["$$value", null] }, { $lt: ["$$this.statusSeverity", "$$value.statusSeverity"] }] }, "$$this", "$$value"] },
    },
  };
  const until = {
    $let: {
      vars: { p: { $ifNull: ["$$w.validityPeriods", []] } },
      in: {
        $convert: {
          input: { $ifNull: [{ $first: { $map: { input: { $filter: { input: "$$p", cond: { $eq: ["$$this.isNow", true] } } }, in: "$$this.toDate" } } }, { $max: "$$p.toDate" }] },
          to: "date", onError: null, onNull: null,
        },
      },
    },
  };
  return [
    { $unwind: "$lines" },
    { $match: { "lines.id": { $type: "string" } } },
    {
      $replaceRoot: {
        newRoot: {
          $let: {
            vars: { w: worst },
            in: {
              _id: "$lines.id",
              line: "$lines.name",
              mode: "$lines.modeName",
              severity: { $ifNull: ["$$w.statusSeverity", -1] },
              status: { $ifNull: ["$$w.statusSeverityDescription", "Unknown"] },
              reason: { $ifNull: ["$$w.reason", null] },
              validUntil: until,
              updatedAt: "$polledAt",
              via: { $literal: via },
            },
          },
        },
      },
    },
  ];
}

/** The deployed processor. `cluster` / `tfl` are Connection Registry names. */
function streamPipeline({ cluster = "sowhere_cluster", tfl = "tfl_api", everySec = 60 } = {}) {
  return [
    { $source: { schedule: `0/${everySec} * * * * *`.replace(/^0\/60 /, "0 "), tsFieldName: "polledAt" } },
    { $https: { connectionName: tfl, path: TFL_PATH, method: "GET", as: "lines", onError: "dlq", config: { connectionTimeoutSec: 10, requestTimeoutSec: 20 } } },
    ...normaliseStages(VIA_STREAM),
    { $merge: { into: { connectionName: cluster, db: DB, coll: COLL }, on: "_id", whenMatched: "replace", whenNotMatched: "insert" } },
  ];
}

module.exports = { TFL_PATH, DB, COLL, VIA_STREAM, normaliseStages, streamPipeline };
