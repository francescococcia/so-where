// TfL Unified API (no key needed; TFL_APP_KEY used when set): StopPoint search, Journey Planner, line status.
import hubsDoc from "@/data/hubs.json";
import { LONDON_AREAS } from "@/lib/areas";
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

export type Journey = { minutes: number; summary: string; lines: { id: string; name: string }[]; path: LatLng[]; fetchedAt: string; ms: number };

type JpLeg = {
  duration: number;
  mode: { id: string; name: string };
  instruction?: { summary?: string };
  routeOptions?: { name?: string; lineIdentifier?: { id: string; name: string } }[];
  path?: { lineString?: string };
};
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
  const best = [...js].sort((a, b) => a.duration - b.duration)[0];
  const transit = best.legs.filter((l) => l.mode.id !== "walking");
  const lines = transit.flatMap((l) => (l.routeOptions ?? []).map((o) => o.lineIdentifier).filter(Boolean).slice(0, 1)) as { id: string; name: string }[];
  const summary = transit.length
    ? transit.map((l) => l.instruction?.summary ?? l.mode.name).join(", then ") + (transit.length === 1 ? " (direct)" : "")
    : "Walk";
  return { minutes: best.duration, summary, lines, path: best.legs.flatMap((l) => parsePath(l.path?.lineString)), fetchedAt: r.fetchedAt, ms: r.ms };
}

export type HubScore = { hub: Hub; a: Journey; b: Journey; worst: number; gap: number };

/** Fairest hub: minimise the worse of the two journey times, then the gap between them. */
export async function fairPoint(a: End, b: End, arriveBy: Date, hubs: Hub[] = HUBS) {
  const t0 = Date.now();
  const rows = await Promise.all(
    hubs.map(async (hub) => {
      // One retry per leg: TfL times out on a few of the 24 calls, and a missing hub can change the answer.
      const leg = async (from: LatLng) => {
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
