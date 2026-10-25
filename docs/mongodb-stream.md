# MongoDB Atlas Stream Processing · live TfL line status

**What:** a stream processor polls TfL's line status every 60 s and `$merge`s one row per line into
`sowhere.line_status`. The planner reads it, so cards say e.g. *"Elizabeth line: severe delays · rerouted"* and
the plan shows the step **MongoDB Atlas Stream Processing · live line status**.

```
cron $source (every 60 s) → $https GET api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,dlr,overground/Status
  → $unwind lines → worst status per line → $merge sowhere.line_status (on _id = line id)
```

Row: `{_id:"jubilee", line, mode, severity, status, reason, validUntil, updatedAt, via:"atlas-stream-processing"}`.
Bad TfL responses (4xx) go to `sowhere.line_status_dlq`.

## Files
| File | What |
| --- | --- |
| `scripts/stream-tfl-pipeline.cjs` | The pipeline (one source of truth for the processor and the test) |
| `scripts/stream-tfl.processor.json` | Same, as JSON to paste into the Atlas UI |
| `scripts/stream-tfl.js` | `mongosh <workspace URI> scripts/stream-tfl.js`: create + start |
| `scripts/asp-setup.sh` | Admin API: `up` / `status` / `stop` / `down` (workspace SP2, London) |
| `src/lib/line-status.ts` | Planner read: fresh stream rows only, 30 s cache, 600 ms budget |
| `scripts/test_line_status.ts` | `npx tsx scripts/test_line_status.ts` on mongodb-memory-server |

## How the planner uses it
- `lineStatus()` (tfl.ts) uses stream rows when **every** line asked for has a row updated in the last
  **10 min** with `via: "atlas-stream-processing"`. Otherwise it calls TfL directly, as before. Bus lines aren't
  streamed, so those plans use the direct call.
- `journey()` adds minutes to TfL options that ride a disrupted line (+15 for closures, suspensions and severe
  delays; +5 for reduced service and minor delays), so TfL's own next option wins when it's close. If the pick
  dodges a line TfL's fastest option used, the card says `· rerouted`.
- The plan step and the "MongoDB Atlas Stream Processing" source show **only** when the rows came from the
  stream. Empty, stale or slow collection: nothing is shown and nothing is invented.
- Disrupted = TfL severity 1–9, 11 (Part Closed), 15 (Diverted), 16 (Not Running).

## Run it (smallest tier)
1. Atlas → Stream Processing → Create workspace: AWS **London**, tier **SP2**, max tier **SP2**.
2. Connection Registry → Add: **Atlas Database** `sowhere_cluster` → cluster `so-where`, role *Read and write to any database*.
3. Connection Registry → Add: **HTTPS** `tfl_api` → URL `https://api.tfl.gov.uk/`.
4. Stream Processors → Create → JSON editor → paste `scripts/stream-tfl.processor.json` → Save → Start.
   (Or `scripts/asp-setup.sh up` with a project API key, which does 1–4.)
5. Check: `sowhere.line_status` has ~19 rows with a fresh `updatedAt`.

**Cost:** SP2 ≈ $0.07/h plus a small workspace fee, while running. **Stop it after the finale**
(`scripts/asp-setup.sh stop`, or *Stop* in the UI; `down` deletes it).
