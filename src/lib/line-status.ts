// Live TfL line status written by MongoDB Atlas Stream Processing (scripts/stream-tfl.js): a processor polls
// TfL every 60 s and $merges one row per line into sowhere.line_status
//   {_id: "jubilee", line, mode, severity, status, reason, validUntil, updatedAt, via: "atlas-stream-processing"}.
// The planner reads it here. Rules: only rows the stream wrote (via), only if updated in the last 10 min, and a
// short Mongo budget. Empty, stale or slow → null, and the caller keeps its direct TfL path (or shows nothing).
// Nothing here invents a status.
import type { Db } from "mongodb";
import { getDb } from "@/lib/mongo";

export const LINE_STATUS_COLL = "line_status";
export const VIA_STREAM = "atlas-stream-processing";
export const STREAM_SOURCE = "MongoDB Atlas Stream Processing";
export const STALE_MS = 10 * 60_000;
const DB_WAIT_MS = 600; // the plan's critical path: never wait long for this
const CACHE_MS = 30_000;

export type StreamedLine = { id: string; name: string; status: string; reason?: string; severity: number; updatedAt: string; validUntil?: string };
type Snapshot = { lines: Map<string, StreamedLine>; newest: string; readAt: number };

const g = globalThis as typeof globalThis & { __soWhereLineStatus?: { snap?: Snapshot | null; at?: number; p?: Promise<Snapshot | null> } };
const cache = (g.__soWhereLineStatus ??= {});

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : typeof d === "string" && !Number.isNaN(Date.parse(d)) ? new Date(d).toISOString() : null);

/** Fresh stream-written rows (≤ 10 min old), or null when none. `db` / `now` are test hooks. */
export async function readStreamed(opts: { db?: Db | null; now?: number; noCache?: boolean } = {}): Promise<Snapshot | null> {
  const now = opts.now ?? Date.now();
  if (!opts.noCache && cache.at && now - cache.at < CACHE_MS) return cache.snap ?? null;
  if (!opts.noCache && cache.p) return cache.p;
  const run = (async () => {
    try {
      const db = opts.db !== undefined ? opts.db : await getDb(DB_WAIT_MS);
      if (!db) return null;
      const rows = await db
        .collection(LINE_STATUS_COLL)
        .find({ via: VIA_STREAM, updatedAt: { $gte: new Date(now - STALE_MS) } }, { maxTimeMS: 800 })
        .limit(60)
        .toArray();
      const lines = new Map<string, StreamedLine>();
      let newest = "";
      for (const r of rows) {
        const updatedAt = iso(r.updatedAt);
        if (typeof r._id !== "string" || typeof r.severity !== "number" || typeof r.status !== "string" || !updatedAt) continue;
        lines.set(r._id, { id: r._id, name: typeof r.line === "string" ? r.line : r._id, status: r.status, severity: r.severity, updatedAt, ...(typeof r.reason === "string" && r.reason ? { reason: r.reason } : {}), ...(iso(r.validUntil) ? { validUntil: iso(r.validUntil)! } : {}) });
        if (updatedAt > newest) newest = updatedAt;
      }
      return lines.size ? { lines, newest, readAt: now } : null;
    } catch {
      return null;
    }
  })();
  if (opts.noCache) return run;
  cache.p = run;
  const snap = await run;
  Object.assign(cache, { snap, at: now, p: undefined });
  return snap;
}

/** TfL severities that mean trouble for a rider (1 Closed … 9 Minor Delays, 11 Part Closed, 15 Diverted, 16 Not Running). */
export const isDisrupted = (severity: number) => (severity >= 1 && severity <= 9) || severity === 11 || severity === 15 || severity === 16;
/** Minutes added to a journey option that rides a disrupted line, so TfL's other options win when close. */
export const disruptionPenalty = (severity: number) => (!isDisrupted(severity) ? 0 : severity <= 6 || severity === 11 || severity === 16 ? 15 : 5);

/** Status rows for `ids` in the shape tfl.ts lineStatus() returns, but only when EVERY id has a fresh stream row. */
export async function streamedLineStatus(ids: string[], opts?: Parameters<typeof readStreamed>[0]) {
  if (!ids.length) return null;
  const snap = await readStreamed(opts);
  if (!snap || !ids.every((id) => snap.lines.has(id))) return null;
  const used = ids.map((id) => snap.lines.get(id)!);
  const oldest = used.map((l) => l.updatedAt).sort()[0];
  return { lines: used.map(({ id, name, status, reason, severity }) => ({ id, name, status, severity, ...(reason ? { reason } : {}) })), fetchedAt: oldest, ms: 0, via: VIA_STREAM as typeof VIA_STREAM };
}

/** Disrupted lines right now (stream rows only), for journey choice. Empty map when there's no fresh stream data. */
export async function disruptedLines(opts?: Parameters<typeof readStreamed>[0]): Promise<Map<string, StreamedLine>> {
  const snap = await readStreamed(opts);
  return new Map([...(snap?.lines ?? new Map<string, StreamedLine>())].filter(([, l]) => isDisrupted(l.severity)));
}

/** "Jubilee line" → "Jubilee"; "Elizabeth line" stays; "DLR" stays. */
export const shortLine = (name: string) => (/^elizabeth/i.test(name) ? "Elizabeth line" : name.replace(/\s+line$/i, ""));
/** "Part Closure" → "part closure", "Minor Delays" → "minor delays". */
export const statusText = (s: string) => s.toLowerCase();

/** Plan step, only when the line status really came from the stream. `begin` is the plan's stepper. */
export function streamStep(begin: (id: string, label: string, source?: string) => (status: "done", detail?: string) => void, ls: unknown) {
  if (!ls || typeof ls !== "object" || (ls as { via?: string }).via !== VIA_STREAM) return;
  const r = ls as { lines: { name: string; status: string; severity: number }[]; fetchedAt: string };
  const bad = r.lines.filter((l) => isDisrupted(l.severity));
  const clock = new Date(r.fetchedAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
  begin("stream", "MongoDB Atlas Stream Processing · live line status", STREAM_SOURCE)(
    "done",
    `${r.lines.length} line${r.lines.length === 1 ? "" : "s"} from sowhere.line_status (TfL, streamed every 60 s, as of ${clock})${bad.length ? ` · ${bad.map((l) => `${shortLine(l.name)} ${statusText(l.status)}`).join(", ")}` : " · all good service"}`,
  );
}

/** Source-list name: the stream when the rows came from it, else TfL's own endpoint. */
export const lineSourceName = (ls: { via?: string }) => (ls.via === VIA_STREAM ? `${STREAM_SOURCE} (TfL Line Status)` : "TfL Line Status");

/** Test hook: forget the 30 s cache. */
export const resetLineStatusCache = () => void Object.assign(cache, { snap: undefined, at: undefined, p: undefined });
