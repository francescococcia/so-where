// TfL Unified API (no key needed; TFL_APP_KEY used when set): StopPoint search, Journey Planner, line status.
import hubsDoc from "@/data/hubs.json";
import { LONDON_AREAS } from "@/lib/areas";
import { metresBetween, walkMinutes } from "@/lib/geo";
import { getJson } from "@/lib/http";
import { londonParts } from "@/lib/london-time";
import type { LatLng } from "@/lib/plan-types";

const BASE = "https://api.tfl.gov.uk";
const key = () => (process.env.TFL_APP_KEY ? `app_key=${encodeURIComponent(process.env.TFL_APP_KEY)}` : "");
const withKey = (url: string) => (key() ? `${url}${url.includes("?") ? "&" : "?"}${key()}` : url);

export type Hub = { name: string; id: string; tflName: string; lat: number; lng: number };
export const HUBS: Hub[] = (hubsDoc as { hubs: Hub[] }).hubs;

export type Place = { query: string; name: string; id: string | null; location: LatLng; modes: string[]; source: string; asOf: string };

type StopMatch = { id: string; name: string; lat: number; lon: number; modes?: string[] };
const MODE_RANK = ["tube", "elizabeth-line", "overground", "dlr", "national-rail"];
const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/st\.?\s/g, "st ").replace(/[^a-z0-9]/g, "");

/** Resolve a typed place ("Old Street", "Clapham") to a station via TfL StopPoint search. */
export async function searchPlace(text: string): Promise<{ place: Place | null; ms: number; error?: string }> {
  const url = withKey(`${BASE}/StopPoint/Search/${encodeURIComponent(text)}?modes=tube,elizabeth-line,overground,dlr,national-rail&maxResults=12`);
  const r = await getJson<{ matches?: StopMatch[] }>(url, { ttlMs: 60 * 60_000 });
  if (r.ok) {
    const q = norm(text);
    const ms = (r.data.matches ?? []).filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon));
    const rank = (m: StopMatch) => {
      const n = norm(m.name.replace(/\s+(underground|rail|dlr|overground)?\s*station$/i, ""));
      const nameScore = n === q ? 0 : n.startsWith(q) ? 1 : n.includes(q) ? 2 : 3;
      const mode = Math.min(...(m.modes ?? []).map((x) => (MODE_RANK.includes(x) ? MODE_RANK.indexOf(x) : 9)), 9);
      return nameScore * 10 + mode;
    };
    const best = ms.sort((a, b) => rank(a) - rank(b))[0];
    if (best) {
      return {
        place: { query: text, name: best.name.replace(/\s+Underground Station$/i, "").replace(/\s+(Rail|DLR) Station$/i, ""), id: best.id, location: { lat: best.lat, lng: best.lon }, modes: best.modes ?? [], source: "TfL StopPoint", asOf: r.fetchedAt },
        ms: r.ms,
      };
    }
  }
  // Known neighbourhood names with no station of that name (e.g. "Soho"): the bundled area list.
  const area = LONDON_AREAS.find((a) => norm(a.name).includes(norm(text)) && norm(text).length >= 4);
  if (area) return { place: { query: text, name: area.name, id: null, location: { lat: area.lat, lng: area.lng }, modes: [], source: "Lumap area list", asOf: new Date().toISOString() }, ms: r.ms };
  return { place: null, ms: r.ms, error: r.ok ? "no match" : r.error };
}

/**
 * One stretch of a TfL journey, in the shape the UI's journey.tsx reads (`mode` / `line` / `from` / `to` /
 * `minutes` / `path`): mode is the TfL mode id (walking, tube, bus, dlr, overground, elizabeth-line,
 * national-rail, tram…), line is "Jubilee line" / "Bus 394", path is ≤ 80 points.
 */
export type LegSegment = { mode: string; line?: string; from?: string; to?: string; minutes: number; path: LatLng[]; est?: boolean };
export type Journey = { minutes: number; summary: string; lines: { id: string; name: string }[]; path: LatLng[]; segments: LegSegment[]; fetchedAt: string; ms: number };

type JpPoint = { commonName?: string; lat?: number; lon?: number };
type JpLeg = {
  duration: number;
  mode: { id: string; name: string };
  instruction?: { summary?: string; detailed?: string };
  routeOptions?: { name?: string; lineIdentifier?: { id: string; name: string } }[];
  departurePoint?: JpPoint;
  arrivalPoint?: JpPoint;
  path?: { lineString?: string; stopPoints?: { name?: string }[] };
};

export const SEGMENT_MAX_POINTS = 80;

/** Keep ≤ max points: evenly spaced, first and last always kept, rounded to ~1 m. */
export function simplifyPath(p: LatLng[], max = SEGMENT_MAX_POINTS): LatLng[] {
  const r = (x: LatLng) => ({ lat: +x.lat.toFixed(5), lng: +x.lng.toFixed(5) });
  if (p.length <= max) return p.map(r);
  const out: LatLng[] = [];
  for (let i = 0; i < max; i++) out.push(r(p[Math.round((i * (p.length - 1)) / (max - 1))]));
  return out;
}

/** "Canary Wharf Underground Station" → "Canary Wharf"; street addresses are not stop names. */
export function stopName(s?: string): string | undefined {
  if (!s || /,\s*London\b|^\d|walk inside|^(entrance|exit)\b/i.test(s)) return undefined; // street addresses / building notes
  const t = s
    .replace(/\s+(Underground|Rail|DLR|Overground|Elizabeth line|Tram|Bus)?\s*Station\b.*$/i, "")
    .replace(/\s*\((?:Stop|Stand)[^)]*\)$/i, "")
    .trim();
  return t || undefined;
}

const RAIL_WORD: Record<string, (n: string) => string> = {
  tube: (n) => (/line$/i.test(n) ? n : `${n} line`),
  overground: (n) => (/line$|overground/i.test(n) ? n : `${n} line`),
  "elizabeth-line": () => "Elizabeth line",
  dlr: () => "DLR",
  bus: (n) => `Bus ${n}`,
  tram: (n) => (n ? `Tram ${n}`.replace(/^Tram tram/i, "Tram") : "Tram"),
};

function segmentOf(l: JpLeg, first: boolean): LegSegment {
  const id = l.mode.id;
  const name = (l.routeOptions?.[0]?.name ?? l.routeOptions?.[0]?.lineIdentifier?.name ?? "").trim();
  const walk = id === "walking";
  const line = walk ? undefined : name ? (RAIL_WORD[id]?.(name) ?? name) : l.mode.name;
  // The first walk starts at the person's own coordinates: TfL names it with a street address, so drop it.
  const from = walk && first ? undefined : stopName(l.departurePoint?.commonName);
  return { mode: id, ...(line ? { line } : {}), ...(from ? { from } : {}), ...(stopName(l.arrivalPoint?.commonName) ? { to: stopName(l.arrivalPoint?.commonName) } : {}), minutes: l.duration, path: simplifyPath(parsePath(l.path?.lineString)) };
}

/** "Jubilee line from Canary Wharf to Waterloo" (falls back to TfL's own summary). */
const segText = (s: LegSegment, l: JpLeg) => (s.line && s.to ? `${s.line}${s.from ? ` from ${s.from}` : ""} to ${s.to}` : l.instruction?.summary ?? l.mode.name);

const same = (a?: string, b?: string) => !!a && !!b && (stopName(a) ?? a).toLowerCase().trim() === (stopName(b) ?? b).toLowerCase().trim();

/** Readable stretches: back-to-back walks become one ("3 min walk, then 8 min walk" → "11 min walk to X"),
 *  and a first walk "to <stop>" is unnamed when that stop is where the person already is ("walk to London
 *  Bridge" for someone at London Bridge). */
export function tidySegments(segs: LegSegment[], originName?: string): LegSegment[] {
  const out: LegSegment[] = [];
  for (const s of segs) {
    const prev = out[out.length - 1];
    if (prev && prev.mode === "walking" && s.mode === "walking") {
      const { to: _to, ...rest } = prev;
      void _to;
      out[out.length - 1] = { ...rest, ...(s.to ? { to: s.to } : {}), minutes: prev.minutes + s.minutes, path: [...prev.path, ...s.path], ...(prev.est || s.est ? { est: true } : {}) };
    } else out.push(s);
  }
  // Intra-station walks ("Southeastern to London Bridge, 9 min walk to London Bridge, Bus 43 …"): a walk between
  // two rides that ends where the previous ride stopped (or a ≤2 min transfer) is a change, not a step.
  for (let i = out.length - 2; i > 0; i--) {
    const w = out[i];
    if (w.mode === "walking" && out[i - 1].mode !== "walking" && out[i + 1].mode !== "walking" && (w.minutes <= 2 || same(w.to, out[i - 1].to) || same(w.to, out[i + 1].from))) out.splice(i, 1);
  }
  const first = out[0];
  if (first?.mode === "walking" && out.length > 1 && same(first.to, originName)) {
    const { to: _to, ...rest } = first;
    void _to;
    out[0] = rest;
  }
  return out;
}

/** Route sanity: minutes of penalty for a journey whose transit legs head away from the destination
 *  or swing back past the start (e.g. a bus looping back through the origin area). */
export function backtrackPenalty(legs: { mode: string; path: LatLng[] }[], from: LatLng, to: LatLng): number {
  let pen = 0;
  let away = 0; // furthest we've been from the start so far
  for (const l of legs) {
    if (!l.path.length) continue;
    const s = l.path[0];
    const e = l.path[l.path.length - 1];
    if (l.mode !== "walking") {
      if (metresBetween(e, to) - metresBetween(s, to) > 400) pen += 10; // this ride ends farther from the destination
      if (away > 800 && l.path.some((p) => metresBetween(p, from) < 250)) pen += 10; // came back past the start
    }
    for (const p of l.path) away = Math.max(away, metresBetween(p, from));
  }
  return pen;
}

/** Hide the first `m` metres around the start (same radial rule as trimPathStart): the other person's start is never shown precisely. */
export function trimSegmentsStart(segs: LegSegment[], m: number, dist: (a: LatLng, b: LatLng) => number): LegSegment[] {
  const origin = segs.find((s) => s.path.length)?.path[0];
  if (!origin) return segs;
  let done = false;
  return segs.map((s, n) => {
    if (done) return s;
    const i = s.path.findIndex((p) => dist(origin, p) >= m);
    if (i >= 0) done = true;
    const { from, ...rest } = s;
    return { ...(n === 0 ? rest : { ...rest, ...(from ? { from } : {}) }), path: i < 0 ? [] : s.path.slice(i) };
  });
}
type JpResponse = { journeys?: { duration: number; legs: JpLeg[] }[] };

const ll = (p: LatLng) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

function parsePath(s?: string): LatLng[] {
  if (!s) return [];
  try {
    return (JSON.parse(s) as [number, number][]).map(([lat, lng]) => ({ lat, lng }));
  } catch {
    return [];
  }
}

/** Fastest TfL journey that arrives by `arriveBy` (London time is derived from the instant). */
type End = LatLng & { id?: string };
// Station NaPTAN ids (not HUB ids, which trigger disambiguation) as a fallback: the planner sometimes
// returns "No journey found" for a station's own coordinates (seen for Camden Town) but works with its id.
const stopId = (x: End) => (x.id && /^(940G|910G|930G|490)/.test(x.id) ? x.id : null);

export async function journey(from: End, to: End, arriveBy: Date): Promise<Journey | { error: string; ms: number }> {
  const p = londonParts(arriveBy);
  const date = p.date.replace(/-/g, "");
  const time = `${String(p.hh).padStart(2, "0")}${String(p.mm).padStart(2, "0")}`;
  const q = `?date=${date}&time=${time}&timeIs=Arriving&journeyPreference=leasttime`;
  let r = await getJson<JpResponse>(withKey(`${BASE}/Journey/JourneyResults/${ll(from)}/to/${ll(to)}${q}`), { maxPerHost: 12 });
  if (!r.ok && r.status === 404 && (stopId(from) || stopId(to))) {
    const ms0 = r.ms;
    r = await getJson<JpResponse>(withKey(`${BASE}/Journey/JourneyResults/${stopId(from) ?? ll(from)}/to/${stopId(to) ?? ll(to)}${q}`), { maxPerHost: 12 });
    r.ms += ms0;
  }
  if (!r.ok) return { error: r.error, ms: r.ms };
  const js = r.data.journeys ?? [];
  if (!js.length) return { error: "no journeys", ms: r.ms };
  // Fastest sensible option: a route that rides away from the destination or loops back past the start is penalised.
  const pen = (j: (typeof js)[number]) => backtrackPenalty(j.legs.map((l) => ({ mode: l.mode.id, path: parsePath(l.path?.lineString) })), from, to);
  // Prefer fewer changes (+3 min per extra ride) and, on near-ties, TfL's own order.
  const rides = (j: (typeof js)[number]) => j.legs.filter((l) => l.mode.id !== "walking").length;
  const best = [...js].map((j, i) => ({ j, k: j.duration + pen(j) + 3 * Math.max(0, rides(j) - 1) + i * 0.5 })).sort((a, b) => a.k - b.k)[0].j;
  const transit = best.legs.filter((l) => l.mode.id !== "walking");
  const lines = transit.flatMap((l) => (l.routeOptions ?? []).map((o) => o.lineIdentifier).filter(Boolean).slice(0, 1)) as { id: string; name: string }[];
  const raw = best.legs.map((l, i) => segmentOf(l, i === 0));
  const segments = tidySegments(raw);
  const summary = transit.length
    ? transit.map((l) => segText(raw[best.legs.indexOf(l)], l)).join(", then ") + (transit.length === 1 ? " (direct)" : "")
    : "Walk";
  return { minutes: best.duration, summary, lines, path: best.legs.flatMap((l) => parsePath(l.path?.lineString)), segments, fetchedAt: r.fetchedAt, ms: r.ms };
}

export type HubScore = { hub: Hub; a: Journey; b: Journey; worst: number; gap: number };

const AT_HUB_M = 400;
/**
 * Someone starting AT a hub (e.g. "I'm at Waterloo"): TfL returns no journey from a station to itself, which
 * used to drop that hub from the comparison. Treat it as a walk instead: 0 min for the same station.
 */
function atHubJourney(from: End, hub: Hub): Journey | null {
  const m = metresBetween(from, hub);
  const same = (!!from.id && from.id === hub.id) || m < 150;
  if (!same && m > AT_HUB_M) return null;
  const minutes = same ? 0 : walkMinutes(m);
  return { minutes, summary: same ? `Already at ${hub.name} (walk)` : `Walk to ${hub.name} (~${minutes} min, estimate)`, lines: [], path: [], segments: same ? [] : [{ mode: "walking", to: hub.name, minutes, path: [], est: true }], fetchedAt: new Date().toISOString(), ms: 0 };
}

/** Fairest hub: minimise the worse of the two journey times, then the gap between them. */
export async function fairPoint(a: End, b: End, arriveBy: Date, hubs: Hub[] = HUBS) {
  const t0 = Date.now();
  const rows = await Promise.all(
    hubs.map(async (hub) => {
      // One retry per leg: TfL times out on a few of the 24 calls, and a missing hub can change the answer.
      const leg = async (from: End) => {
        const here = atHubJourney(from, hub);
        if (here) return here;
        const j = await journey(from, hub, arriveBy);
        return "error" in j ? journey(from, hub, arriveBy) : j;
      };
      const [ja, jb] = await Promise.all([leg(a), leg(b)]);
      return { hub, ja, jb };
    }),
  );
  const ok: HubScore[] = [];
  const failedHubs: string[] = [];
  let failed = 0;
  for (const { hub, ja, jb } of rows) {
    if ("error" in ja || "error" in jb) {
      failed++;
      failedHubs.push(hub.name);
      continue;
    }
    ok.push({ hub, a: ja, b: jb, worst: Math.max(ja.minutes, jb.minutes), gap: Math.abs(ja.minutes - jb.minutes) });
  }
  ok.sort((x, y) => x.worst - y.worst || x.gap - y.gap);
  return { ranked: ok, compared: hubs.length, failed, failedHubs, ms: Date.now() - t0, calls: hubs.length * 2 };
}

export type LineStatus = { id: string; name: string; status: string; reason?: string; severity: number };

export async function lineStatus(ids: string[]): Promise<{ lines: LineStatus[]; fetchedAt: string; ms: number } | { error: string; ms: number }> {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return { lines: [], fetchedAt: new Date().toISOString(), ms: 0 };
  const r = await getJson<{ id: string; name: string; lineStatuses: { statusSeverity: number; statusSeverityDescription: string; reason?: string }[] }[]>(
    withKey(`${BASE}/Line/${uniq.map(encodeURIComponent).join(",")}/Status`),
    { ttlMs: 2 * 60_000 },
  );
  if (!r.ok) return { error: r.error, ms: r.ms };
  return {
    lines: r.data.map((l) => {
      const worst = [...(l.lineStatuses ?? [])].sort((a, b) => a.statusSeverity - b.statusSeverity)[0];
      return { id: l.id, name: l.name, status: worst?.statusSeverityDescription ?? "Unknown", reason: worst?.reason, severity: worst?.statusSeverity ?? -1 };
    }),
    fetchedAt: r.fetchedAt,
    ms: r.ms,
  };
}

/** Drop the part of a path within `metres` of its start, so a route line doesn't pinpoint where someone set off. */
export function trimPathStart(path: LatLng[], metres: number, dist: (a: LatLng, b: LatLng) => number): LatLng[] {
  if (!path.length) return path;
  const start = path[0];
  const i = path.findIndex((p) => dist(start, p) >= metres);
  return i < 0 ? [] : path.slice(i);
}
