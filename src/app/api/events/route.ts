import { NextResponse } from "next/server";
import { getEvents } from "../../../lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const londonDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

/** Events-feed events on one London calendar date: /api/events?date=YYYY-MM-DD */
export function GET(request: Request) {
  const date = new URL(request.url).searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return NextResponse.json({ error: "date=YYYY-MM-DD required" }, { status: 400 });
  const events = getEvents()
    .filter((e) => londonDate(e.start_at) === date)
    .map((e) => ({
      id: e.id,
      title: e.title,
      url: e.url ?? null,
      start_at: e.start_at,
      end_at: e.end_at ?? null,
      organiser: typeof e.organiser === "string" ? e.organiser : null,
      lat: typeof e.lat === "number" ? e.lat : null,
      lng: typeof e.lng === "number" ? e.lng : null,
      size: typeof e.size === "number" ? e.size : null,
      score: e.score,
    }));
  return NextResponse.json({ date, events }, { headers: { "cache-control": "public, max-age=300" } });
}
