import { coworkSessions, isWeekly } from "../../../lib/cowork";
import { WEEK } from "../../../lib/hours";
import { foldLine } from "../../../lib/ics";
import { sessionLink } from "../../../lib/links";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BYDAY = { mon: "MO", tue: "TU", wed: "WE", thu: "TH", fri: "FR", sat: "SA", sun: "SU" } as const;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/\r\n|\r|\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");

// London calendar date of the next given weekday (today counts).
function nextDate(day: keyof typeof BYDAY, now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(now).map((p) => [p.type, p.value]));
  const today = WEEK.indexOf(parts.weekday.toLowerCase().slice(0, 3) as (typeof WEEK)[number]);
  const add = (WEEK.indexOf(day) - today + 7) % 7;
  const d = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + add));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export function GET(): Response {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Lumap//London Cowork Sessions//EN",
    "CALSCALE:GREGORIAN",
    "X-WR-CALNAME:Lumap - Cowork with others",
    "X-WR-TIMEZONE:Europe/London",
    "X-WR-CALDESC:Weekly London sessions where founders and builders work side by side. Register on each event page.",
    "BEGIN:VTIMEZONE",
    "TZID:Europe/London",
    "BEGIN:DAYLIGHT",
    "TZOFFSETFROM:+0000",
    "TZOFFSETTO:+0100",
    "TZNAME:BST",
    "DTSTART:19700329T010000",
    "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
    "END:DAYLIGHT",
    "BEGIN:STANDARD",
    "TZOFFSETFROM:+0100",
    "TZOFFSETTO:+0000",
    "TZNAME:GMT",
    "DTSTART:19701025T020000",
    "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
    "END:STANDARD",
    "END:VTIMEZONE",
  ];
  // Only sessions with a confirmed weekly cadence repeat; fortnightly or
  // date-by-date ones would put wrong dates in people's calendars.
  for (const s of coworkSessions().filter(isWeekly)) {
    const date = nextDate(s.day_of_week);
    const link = sessionLink(s);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${s.key}@lumap-cowork`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/London:${date}T${s.start_time.replace(":", "")}00`,
      `DTEND;TZID=Europe/London:${date}T${s.end_time.replace(":", "")}00`,
      `RRULE:FREQ=WEEKLY;BYDAY=${BYDAY[s.day_of_week]}`,
      `SUMMARY:${esc(s.title)}`,
      `LOCATION:${esc(`${s.venue_name ?? ""}, London`)}`,
      `DESCRIPTION:${esc([s.summary, s.price, s.rsvp, link ? `${link.label}: ${link.url}` : ""].filter(Boolean).join("\n"))}`,
      ...(link ? [`URL:${link.url}`] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return new Response(lines.map(foldLine).join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="lumap-cowork.ics"', "Cache-Control": "no-store" },
  });
}
