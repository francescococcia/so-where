// GET /api/now: the home screen's "right now" strip. Real data only, each part with its source and as-of time:
//   lines   TfL line status (MongoDB Atlas Stream Processing rows when fresh, else a direct TfL call)
//   weather Open-Meteo, central London, this hour
//   events  listed events today that haven't ended (the events seed), omitted when there are none
// Each part has its own timeout; a part that fails is left out (the card hides). No user data in or out.
import { readStreamed, isDisrupted, shortLine, VIA_STREAM } from "@/lib/line-status";
import { forecastAt } from "@/lib/weather";
import { seedEventsOn } from "@/lib/events";
import { londonParts } from "@/lib/london-time";
import { getJson } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PART_MS = 2500;
const within = <T,>(p: Promise<T>, ms = PART_MS): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), ms))]);

type Line = { name: string; status: string; severity: number };
type Lines = { ok: boolean; disrupted: Line[]; total: number; via: "stream" | "tfl"; asOf: string };

async function lines(): Promise<Lines | null> {
  const snap = await readStreamed();
  if (snap && snap.lines.size >= 10) {
    const all = [...snap.lines.values()];
    const bad = all.filter((l) => isDisrupted(l.severity)).map((l) => ({ name: shortLine(l.name), status: l.status, severity: l.severity }));
    return { ok: !bad.length, disrupted: bad.sort((a, b) => a.severity - b.severity), total: all.length, via: "stream", asOf: snap.newest };
  }
  const key = process.env.TFL_APP_KEY ? `?app_key=${encodeURIComponent(process.env.TFL_APP_KEY)}` : "";
  const r = await getJson<{ name: string; lineStatuses: { statusSeverity: number; statusSeverityDescription: string }[] }[]>(
    `https://api.tfl.gov.uk/Line/Mode/tube,elizabeth-line,dlr,overground/Status${key}`,
    { ttlMs: 60_000, timeoutMs: PART_MS },
  );
  if (!r.ok || !Array.isArray(r.data) || !r.data.length) return null;
  const all = r.data.map((l) => {
    const w = [...(l.lineStatuses ?? [])].sort((a, b) => a.statusSeverity - b.statusSeverity)[0];
    return { name: shortLine(l.name), status: w?.statusSeverityDescription ?? "", severity: w?.statusSeverity ?? -1 };
  }).filter((l) => l.status);
  if (!all.length) return null;
  const bad = all.filter((l) => isDisrupted(l.severity));
  return { ok: !bad.length, disrupted: bad.sort((a, b) => a.severity - b.severity), total: all.length, via: "tfl", asOf: r.fetchedAt };
}

async function weather() {
  const f = await forecastAt({ lat: 51.5074, lng: -0.1278 }, new Date());
  if ("error" in f) return null;
  const sky = f.value.split(", ")[1];
  return { tempC: f.tempC, sky: sky && !/chance of rain/.test(sky) ? sky : null, rainPct: f.rainPct, asOf: f.fetchedAt };
}

function events() {
  const now = new Date();
  const day = (d: Date) => londonParts(d).date;
  const list = seedEventsOn(day(now), now, day);
  if (!list.length) return null;
  return { count: list.length, walkIn: list.filter((e) => !e.walkIn.rsvpRequired && e.walkIn.verdict !== "unknown").length, source: [...new Set(list.map((e) => e.source))].join(", "), asOf: list[0].asOf };
}

export async function GET() {
  const [l, w] = await Promise.all([within(lines()), within(weather())]);
  let e: ReturnType<typeof events> = null;
  try {
    e = events();
  } catch {
    e = null;
  }
  return Response.json(
    { lines: l ? { ...l, via: l.via === "stream" ? VIA_STREAM : "tfl" } : null, weather: w, events: e, at: new Date().toISOString() },
    { headers: { "Cache-Control": "public, max-age=30, s-maxage=60, stale-while-revalidate=120" } },
  );
}
