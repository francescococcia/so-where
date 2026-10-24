// Instant answers for Ask Lumap from data we already hold (bundled sessions + public venue rows),
// shown straight away while the slower community-memory answer is on its way.

import { LONDON_AREAS, type LondonArea } from "@/lib/areas";
import { coworkSessions, nearestArea, type CoworkItem } from "@/lib/cowork";
import { addDays, dateLabel, londonToday, sessionOnDate, weekdayOf } from "@/lib/dates";
import { dayWindow, type DayKey, type Hours } from "@/lib/hours";
import { sessionLink } from "@/lib/links";
import { allSessions, TYPE_LABEL, venueGoodFor, venueType, type GoodFor } from "@/lib/venue-facts";
import { mentionedIn } from "@/lib/venue-match";
import { datesIn, resolveWhen, type When } from "@/lib/when";

export type VenueRow = {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  capacity: number | null;
  guest_count_lower_bound: number | null;
  hours: Hours;
  notes: string | null;
  terms: string | null;
  status: string | null;
  venue_type: string | null;
  good_for: string[] | null;
  source_url: string | null;
};

let cache: { at: number; rows: VenueRow[] } | null = null;

/** Every public venue row (anon key, safe columns only). Cached for five minutes. */
export async function venueDirectory(): Promise<VenueRow[]> {
  if (cache && Date.now() - cache.at < 300_000) return cache.rows;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return [];
  const cols = "id,name,address,lat,lng,capacity,guest_count_lower_bound,hours,notes,terms,status,venue_type,good_for,source_url";
  let data: unknown = [];
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/venues_public?select=${cols}&limit=500`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(4000),
      cache: "no-store",
    });
    if (res.ok) data = await res.json();
  } catch {
    return cache?.rows ?? [];
  }
  const rows = (Array.isArray(data) ? (data as VenueRow[]) : []).filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
  cache = { at: Date.now(), rows };
  return rows;
}

type Occasion = "cowork" | "party" | "meetup" | "workshop";
export type Intent = { occasion: Occasion | null; birthday: boolean; people: number | null; area: LondonArea | null; when: When | null };

const COWORK_RE = /co-?work|work (alongside|with|next to)|deep work|\bdesk\b|laptop|somewhere to work/i;
const OCCASIONS: [Occasion, RegExp][] = [
  ["party", /birthday|bday|party|celebrat|drinks|leaving do|hen do|stag|anniversary|engagement|christening|baby shower/i],
  ["workshop", /workshop|class\b|training|course|hack ?night|life drawing/i],
  ["meetup", /meet-?up|talk|event|hackathon|launch|panel|networking|conference|community|demo day|book club/i],
];

function areaIn(q: string) {
  const s = q.toLowerCase().replace(/[’']/g, "");
  return (
    LONDON_AREAS.find((a) =>
      a.name
        .toLowerCase()
        .replace(/[’']/g, "")
        .split(/\s*&\s*/)
        .some((part) => s.includes(part)),
    ) ?? null
  );
}

function peopleIn(q: string) {
  const m =
    /\b(\d{1,4})\s*(?:-\s*)?(?:people|persons?|guests|pax|ppl|attendees|friends|of us|heads|person|seated|standing)\b/i.exec(q) ??
    /\bfor (?:about |around |roughly |~)?(\d{1,4})\b(?!\s*(?:st|nd|rd|th|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|am|pm|:|\/|-|minutes|mins|hours|hrs|days|weeks))/i.exec(q);
  const n = m ? Number(m[1]) : null;
  return n && n > 1 && n < 5000 ? n : null;
}

function occasionIn(q: string): Occasion | null {
  if (COWORK_RE.test(q)) return "cowork";
  return OCCASIONS.find(([, re]) => re.test(q))?.[0] ?? null;
}

/** What the latest question asks for, filling gaps from earlier questions in the chat (most recent last). */
export function intentOf(latest: string, previous: string[] = [], today = londonToday()): Intent {
  const all = [latest, ...[...previous].reverse()];
  const first = <T,>(f: (q: string) => T | null) => all.map(f).find((v) => v != null) ?? null;
  return {
    occasion: first(occasionIn),
    birthday: all.some((q) => /birthday|bday/i.test(q)),
    people: first(peopleIn),
    area: first(areaIn),
    when: first((q) => resolveWhen(q, today)),
  };
}

const DAY_NAME: Record<DayKey, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const GOOD_FOR: Record<Exclude<Occasion, "cowork">, GoodFor> = { party: "private_party", meetup: "community_event", workshop: "workshop" };
const GOOD_FOR_TEXT: Record<GoodFor, string> = {
  private_party: "good for private parties",
  community_event: "used for community events",
  workshop: "set up for workshops",
  coworking: "good for a laptop day",
};

const km = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => Math.hypot(a.lat - b.lat, (a.lng - b.lng) * 0.62) * 111;
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function followUp(intent: Intent) {
  if (intent.area) return `Want me to look a bit further out from ${intent.area.name}, or try another day?`;
  if (intent.occasion === "cowork") return "Want something closer to Shoreditch, or would a quiet café suit you better?";
  return "Want something closer to a particular area, like Shoreditch or King's Cross?";
}

/** One short "why it fits" line from a session summary, without repeating the venue name. */
function sessionWhy(s: CoworkItem) {
  if (!s.summary) return "";
  let line = s.summary.split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, "");
  if (s.venue_name) line = line.replace(new RegExp(`\\s+at\\s+${s.venue_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"), "");
  const parts = line.split(", ");
  return lowerFirst(parts.slice(0, 2).join(", "));
}

function coworkAnswer(intent: Intent, rows: VenueRow[], today: string) {
  const when = intent.when ?? { from: today, to: addDays(today, 6), phrase: "over the next week", label: "" };
  const sessions = coworkSessions();
  const picks: { s: CoworkItem; date: string; check: boolean }[] = [];
  for (const date of datesIn(when)) {
    for (const s of sessions) {
      const on = sessionOnDate(s, date);
      if (on !== "no" && !picks.some((p) => p.s.key === s.key)) picks.push({ s, date, check: on === "check" });
    }
  }
  // Nearest first when they named an area, otherwise in date order.
  picks.sort((a, b) => (intent.area ? km(a.s, intent.area) - km(b.s, intent.area) : 0) || a.date.localeCompare(b.date) || a.s.start_time.localeCompare(b.s.start_time));
  const lines: string[] = [];
  const names: string[] = [];
  if (picks.length) {
    lines.push(`Here are the coworking sessions I know about ${when.phrase}:`, "");
    for (const { s, date, check } of picks.slice(0, 4)) {
      const link = sessionLink(s);
      const why = sessionWhy(s);
      const when = check ? `usually ${DAY_NAME[s.day_of_week]}s (check the date)` : dateLabel(date);
      lines.push(
        `- **${s.venue_name ?? s.title}**: ${s.title}, ${when}, ${s.start_time}–${s.end_time}.${why ? ` ${why.charAt(0).toUpperCase()}${why.slice(1)}.` : ""}${s.price ? ` ${s.price}.` : ""}${link ? ` [${link.label}](${link.url})` : ""}`,
      );
      if (s.venue_name) names.push(s.venue_name);
    }
  } else {
    lines.push(`I don't know of any coworking sessions ${when.phrase}, but these spots are good for a laptop day:`, "");
    const spots = rows.filter((r) => venueGoodFor(r).includes("coworking")).sort((a, b) => (intent.area ? km(a, intent.area) - km(b, intent.area) : 0)).slice(0, 4);
    for (const r of spots) {
      lines.push(`- **${r.name}**: ${TYPE_LABEL[venueType(r)].toLowerCase()} near ${nearestArea(r.lat, r.lng).name}.`);
      names.push(r.name);
    }
  }
  lines.push("", followUp(intent));
  return { answer: lines.join("\n"), names };
}

function venueAnswer(intent: Intent, rows: VenueRow[]) {
  const occasion = intent.occasion as Exclude<Occasion, "cowork"> | null;
  const need = intent.people ?? 0;
  const day = intent.when && intent.when.from === intent.when.to ? weekdayOf(intent.when.from) : null;
  const size = (r: VenueRow) => r.capacity ?? r.guest_count_lower_bound;
  const fits = rows
    .filter((r) => !occasion || venueGoodFor(r).includes(GOOD_FOR[occasion]))
    .filter((r) => !need || size(r) == null || (size(r) as number) >= need)
    .filter((r) => !day || dayWindow(r.hours, day) !== null)
    .map((r) => {
      const s = size(r);
      const capScore = s == null ? 2 : need ? Math.min(s / Math.max(need, 1), 20) / 20 : 0;
      const areaScore = intent.area ? km(r, intent.area) / 2 : 0;
      return { r, score: capScore + areaScore - (r.status === "verified" ? 0.3 : 0) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 4)
    .map((x) => x.r);

  const what = intent.birthday ? "a birthday" : occasion === "party" ? "a party" : occasion === "workshop" ? "a workshop" : occasion === "meetup" ? "a meetup" : "your plans";
  const head = `${what}${need ? ` for ${need}` : ""}${intent.when ? ` ${intent.when.phrase}` : ""}${intent.area ? ` near ${intent.area.name}` : ""}`;
  const lines: string[] = [];
  const names: string[] = [];
  if (!fits.length) {
    lines.push(`I couldn't find a place I know that fits ${head}. Try a different area or a smaller group, or add a venue you know to the map.`);
    return { answer: lines.join("\n"), names };
  }
  lines.push(`Nice, ${head}! Here are a few places I'd look at:`, "");
  let anyHours = false;
  for (const r of fits) {
    const bits = [`${TYPE_LABEL[venueType(r)].toLowerCase()} near ${nearestArea(r.lat, r.lng).name}`];
    if (occasion) bits[0] += `, ${GOOD_FOR_TEXT[GOOD_FOR[occasion]]}`;
    if (r.capacity) bits.push(`takes up to ${r.capacity}`);
    else if (r.guest_count_lower_bound) bits.push(`has hosted ${r.guest_count_lower_bound}+ people`);
    else bits.push("capacity not listed");
    const open = day ? dayWindow(r.hours, day) : undefined;
    if (open && day) {
      anyHours = true;
      bits.push(`open ${open.start}–${open.end} on ${DAY_NAME[day]}s`);
    }
    lines.push(`- **${r.name}**: ${bits.join("; ")}.`);
    names.push(r.name);
  }
  lines.push("");
  if (day && !anyHours) lines.push(`None of them list ${DAY_NAME[day]} availability, so drop them a message before you book.`);
  lines.push(followUp(intent));
  return { answer: lines.join("\n"), names };
}

/** A quick answer, or null when the question isn't about finding a place. */
export function localAnswer(intent: Intent, rows: VenueRow[], today = londonToday()) {
  if (intent.occasion === "cowork") return coworkAnswer(intent, rows, today);
  if (intent.occasion || intent.people) return venueAnswer(intent, rows);
  return null;
}

/** Known venues named in an answer, including the venue of any session mentioned by title. */
export function placesIn(text: string, rows: VenueRow[]): VenueRow[] {
  const direct = mentionedIn(text, rows);
  const viaSessions = mentionedIn(text, allSessions().map((s) => ({ ...s, name: s.title })))
    .map((s) => rows.find((r) => s.venue_name && mentionedIn(s.venue_name, [r]).length))
    .filter((r): r is VenueRow => Boolean(r));
  const out = [...direct];
  for (const r of viaSessions) if (!out.some((o) => o.id === r.id)) out.push(r);
  return out;
}

/** Titles of the bundled sessions held at this venue, so an answer that names only the session still maps to it. */
export function sessionTitlesAt(row: Pick<VenueRow, "name">): string[] {
  return allSessions()
    .filter((s) => s.venue_name && mentionedIn(s.venue_name, [row]).length)
    .map((s) => s.title);
}
