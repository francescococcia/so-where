// Instant answers for Ask Lumap from data we already hold (bundled sessions + public venue rows),
// shown straight away while the slower community-memory answer is on its way.

import { LONDON_AREAS, type LondonArea } from "@/lib/areas";
import { coworkSessions, nearestArea, type CoworkItem } from "@/lib/cowork";
import { addDays, dateLabel, londonToday, sessionOnDate, weekdayOf } from "@/lib/dates";
import { dayWindow, type DayKey, type Hours } from "@/lib/hours";
import { sessionLink } from "@/lib/links";
import { allSessions, TYPE_LABEL, venueGoodFor, venueType, type GoodFor } from "@/lib/venue-facts";
import { mentionedIn } from "@/lib/venue-match";
import { matchPlace } from "@/lib/gazetteer";
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

// ---------------------------------------------------------------------------------------------
// "So where?" plan intent: rules first (no network). Gemini, when configured, only fills gaps.
// ---------------------------------------------------------------------------------------------

export type PlanCategory = "pub" | "cafe" | "restaurant" | "event";
export type PlanAsk = {
  intent: "meet_halfway" | "near_me" | null;
  youPlace: string | null;
  themPlace: string | null;
  themWho: string; // "her" | "him" | "them" | a first name
  date: string | null; // YYYY-MM-DD (London), null when the ask names no day
  time: string | null; // HH:MM (London), null when the ask names no time
  /** "clock" = the user typed a clock time ("at 7", "8pm"); "word" = a default from a word ("tonight" → 19:00). */
  timeKind?: "clock" | "word";
  dayPhrase: string | null;
  category: PlanCategory | null;
  budgetGBP: number | null;
  walkIn: boolean;
  free: boolean;
  maxMinutes: number | null;
  /** A broad area was given ("lives in NE", "south London"): the place is an approximate centroid station. */
  youApprox?: string;
  themApprox?: string;
  signals: string[]; // which rules fired, shown in the "parse" step
};

const PLACE_STOP =
  /\s+(?:and|but|so|then|who|which|for|with|tomorrow|tonight|today|this|next|later|after|before|in the|morning|afternoon|evening|on\s+(?:mon|tue|wed|thu|fri|sat|sun)\w*|(?:at|around|about|by|from)\s+\d|(?:she|he|they|them|him|her|me|friend|mate|my\s+\w+)(?:'s|'re|\s+is|\s+are|\s+will|\s+lives|\s+works|\s+at|\s+in|\s+near|\s+around|\s+by)|(?:mon|tues?|wed|thu(?:rs)?|fri|sat|sun)(?:day)?|weekend|\d{1,2}(?::\d{2})?\s*(?:am|pm)|drinks?|pints?|pubs?|coffee|lunch|dinner|brunch|breakfast|check|find|looking|please|pls|need|want|can|could)\b.*$/i;
const ELEPHANT = /elephant\s+(?:and|&)\s+castle/gi;

function cleanPlace(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = raw.replace(ELEPHANT, "Elephant & Castle").replace(PLACE_STOP, "");
  s = s.replace(/^(?:the\s+)?(?:area\s+(?:of|around)\s+)/i, "").replace(/\s+(?:station|area|way|ish)$/i, "").trim();
  s = s.replace(/^(?:around|near|in|at)\s+/i, "").trim();
  if (!s || s.length < 3 || /^(me|here|home|work|the office|you|him|her|them)$/i.test(s)) return null;
  return s.length > 40 ? null : s;
}

// "me at Waterloo", "them near Camden Town": slot phrases at the start of a clause.
const ME_SLOT_RE = /(?:^|[,;]\s*|\band\s+)me\s+(?:at|in|near|around|by|from)\s+([^,.;!?]+)/i;
const THEM_SLOT_RE = /(?:^|[,;]\s*|\band\s+)(?:them|him|her|they|she|he|my friend|my mate|friend|mate)\s+(?:at|in|near|around|by|from)\s+([^,.;!?]+)/i;
// Lowercase "between kings x and brixton" / "kings x and brixton drinks friday 7": only kept when both
// sides are confident gazetteer hits, so ordinary prose ("drinks and dinner") is never read as places.
const BETWEEN_ANY_RE = /\bbetween\s+(.+?)\s+and\s+([^,.;!?]+)/i;
const PAIR_RE = /^\s*(?:from\s+)?([a-z][\w'&. ]{1,30}?)\s+(?:and|&|\/|to)\s+([a-z][\w'&. ]{1,30}?)(?=\s+(?:drinks?|pints?|pubs?|coffee|lunch|dinner|brunch|meet|halfway|on|this|tonight|tomorrow|today|at|(?:mon|tues?|wed|thu(?:rs)?|fri|sat|sun)(?:day)?)\b|\s*[,.;!?]|\s*$)/i;
const known = (p: string | null) => !!p && matchPlace(p).confidence === "high";
// Answers to earlier clarify questions, appended by the server: "…; them: Camden Town; you: Waterloo".
const SLOT_TOKEN_RE = /;\s*(them|you):\s*([^;]+)/gi;

// Common typos and text-speak, fixed before any rule runs.
const TYPOS: [RegExp, string][] = [
  [/\b(?:tonigh|tonite|tonght|tonihgt|2nite|2night|toniht)\b/gi, "tonight"],
  [/\b(?:frind|freind|frend|firend|frnd)\b/gi, "friend"],
  [/\b(?:opern|opne|oepn)\b/gi, "open"],
  [/\bnee\b/gi, "need"],
  [/\b(?:tmrw|tmr|tmrow|tomoz|2moro|2morrow|tommorow|tomorow)\b/gi, "tomorrow"],
  [/\b(?:drnks|drinkz|drinsk)\b/gi, "drinks"],
  [/\b(?:coffe|cofee|cofffee)\b/gi, "coffee"],
  [/\b(?:resturant|restraunt|restaraunt)\b/gi, "restaurant"],
  [/\b(?:ths|tis) (evening|weekend|afternoon)\b/gi, "this $1"],
  [/\b(?:satuday|saturady|satruday)\b/gi, "saturday"],
  [/\b(?:firday|fridy|friady)\b/gi, "friday"],
];
export function fixTypos(q: string): string {
  return TYPOS.reduce((s, [re, to]) => s.replace(re, to), q);
}

const YOU_RE = /\b(?:i'?m|i am|im)\s+(?:currently\s+|now\s+|based\s+|staying\s+)?(?:at|in|near|around|by|over in|coming from|leaving from|starting from|starting at|working at|working in)\s+([^,.;!?]+)/i;
const THEM_PRONOUN_RE = /\b(she|he|they)(?:'s|'re| is| are| lives| works| will be| 'll be|'ll be)\s+(?:currently\s+|now\s+|based\s+|staying\s+)?(?:at|in|near|around|by|over in|based in|coming from|from|out in)\s+([^,.;!?]+)/i;
const THEM_NAME_RE = /\b([A-Z][a-z]{1,15})(?:'s| is| lives| works| will be)\s+(?:currently\s+|now\s+|based\s+)?(?:at|in|near|around|by|over in|coming from|from)\s+([^,.;!?]+)/;
const WITH_FROM_RE = /\bwith\s+(?:my\s+\w+\s+|([A-Z][a-z]{1,15})\s+)?(?:who'?s\s+|who is\s+)?(?:in|from|at|near|around)\s+([A-Z][^,.;!?]+)/;
const BETWEEN_RE = /\bbetween\s+([A-Z][^,.;!?]+?)\s+and\s+([A-Z][^,.;!?]+)/;
const NEAR_PLACE_RE = /\b(?:near|around|in|by)\s+((?:[A-Z][\w'&.-]*)(?:\s+(?:[A-Z&][\w'&.-]*|and\s+Castle))*)/;

/** No other person: "i'm solo", "alone", "just me", "no one", "on my own". */
export const SOLO_RE = /\b(?:solo|alone|by myself|on my own)\b|\bjust (?:me|myself)\b|\bonly me\b|\bno[- ]?one\b|\bnobody\b/i;
/** "the centre" / "central London" / "in town": a central London area, not a TfL search. */
const CENTRE_RE = /\b(?:in|to|into|around|near)\s+(?:the\s+)?(?:city\s+|town\s+)?cent(?:re|er)\b(?!\s+point)|\bcentral\s+london\b|\b(?:in|into)\s+town\b|\b(?:in|to)\s+central\b(?!\s+line)/i;
const CENTRE_PLACE_RE = /^(?:the\s+)?(?:central(?:\s+london)?|(?:city|town|london)\s+cent(?:re|er)|cent(?:re|er)|town)$/i;
export const CENTRE_AREA = "Leicester Square";
/** Broad London areas → an approximate centroid station ("NE" ≈ Walthamstow, "east" ≈ Stratford). Only when
 *  the direction stands alone ("ne", "north east London", "east, not sure where"), never "East Ham" / "West Hampstead". */
const COARSE: { re: RegExp; label: string; station: string }[] = [
  { re: /^(?:ne|n\.e\.?|north[\s-]?east)$/i, label: "north-east London", station: "Walthamstow Central" },
  { re: /^(?:nw|n\.w\.?|north[\s-]?west)$/i, label: "north-west London", station: "Kilburn" },
  { re: /^(?:se|s\.e\.?|south[\s-]?east)$/i, label: "south-east London", station: "Lewisham" },
  { re: /^(?:sw|s\.w\.?|south[\s-]?west)$/i, label: "south-west London", station: "Clapham Junction" },
  { re: /^(?:n|north)$/i, label: "north London", station: "Finsbury Park" },
  { re: /^(?:e|east)$/i, label: "east London", station: "Stratford" },
  { re: /^(?:s|south)$/i, label: "south London", station: "Brixton" },
  { re: /^(?:w|west)$/i, label: "west London", station: "Hammersmith" },
];
const VAGUE_TAIL = /^(?:(?:somewhere|area|side|ish|way|end)\b.*|(?:i|but|not|no|idk|dunno|don'?t|dont|or)\b.*|)$/i;
export function coarseArea(place: string | null): { label: string; station: string } | null {
  if (!place) return null;
  const m = /^(?:the\s+)?([a-z.]+(?:[\s-]+(?:east|west))?)(?:\s+(?:of\s+)?london)?(?:[\s,]+(.*))?$/i.exec(place.trim());
  if (!m || !VAGUE_TAIL.test((m[2] ?? "").trim())) return null;
  const c = COARSE.find((x) => x.re.test(m[1].trim()));
  return c ? { label: c.label, station: c.station } : null;
}

const NEAR_ME_RE = /\bnear (?:me|here|us)\b|\bnearby\b|\baround (?:me|here)\b|\bclose (?:to|by) (?:me|here)\b|what'?s on|\bwhats on\b|things to do|anything (?:on|happening)|\bwalk[- ]?in\b|\bwalk into\b|\bdrop[- ]in\b|\bjust (?:turn|show) up\b/i;
const HALFWAY_RE = /half[- ]?way|in the middle|middle ground|meet(?:ing)? (?:in )?between|\bbetween\b|fair(?:est)? (?:spot|place|middle)|\bmeet (?:up )?(?:with )?\w+|\bmeet\b/i;
const SOCIAL_RE = /\b(?:date|friend|mate|colleague|partner|girlfriend|boyfriend|she|he|they|her|him)\b|\bwith (?:my )?[A-Z]?[a-z]+\b/;
const WALKIN_RE = /walk[- ]?in|walk into|drop[- ]in|just (?:turn|show) up|no (?:registration|sign[- ]?ups?|tickets?|rsvp|booking)|without (?:registering|registration|booking|a ticket|signing up)|don'?t (?:need|have) to (?:register|book|sign up)/i;

function categoryOf(q: string): PlanCategory | null {
  if (/\bpubs?\b|\bdrinks?\b|\bpints?\b|\bbeers?\b|\bbar\b|\bwine\b/i.test(q)) return "pub";
  if (/\bcoffee\b|\bcaf[eé]s?\b|\bbrunch\b|\bbreakfast\b|\btea\b/i.test(q)) return "cafe";
  if (/\bdinner\b|\blunch\b|\brestaurants?\b|\bsomewhere to eat\b|\bfood\b|\bbite\b/i.test(q)) return "restaurant";
  if (/\bevents?\b|what'?s on|whats on|things to do|\bgigs?\b|exhibitions?|museums?|galler(?:y|ies)|walk[- ]?in|walk into|happening/i.test(q)) return "event";
  return null;
}

function whoOf(q: string): string {
  const pron = /\b(she|he|they)(?:'s|'re| is| are| lives| works)\b/i.exec(q)?.[1]?.toLowerCase();
  if (pron) return pron === "she" ? "her" : pron === "he" ? "him" : "them";
  const name = /\bwith ([A-Z][a-z]{1,15})\b/.exec(q)?.[1] ?? THEM_NAME_RE.exec(q)?.[1];
  if (name && !/^(The|My|Me|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|London)$/.test(name)) return name;
  if (/\b(she|her|girlfriend|wife)\b/i.test(q)) return "her";
  if (/\b(he|him|boyfriend|husband)\b/i.test(q)) return "him";
  return "them";
}

function timeOf(q: string, category: PlanCategory | null): string | null {
  // "I am at Waterloo" is not "am": only a number followed by am counts.
  const morningish = /\bmorning\b|\bbreakfast\b|\bbrunch\b|\d\s*am\b/i.test(q) || category === "cafe";
  // Tonight / this evening / drinks / pub / dinner + a bare hour 1–11 is always PM ("tonight at 8" = 20:00).
  const eveningish = /\btonight\b|\bthis evening\b|\bevening\b|\bdrinks?\b|\bpubs?\b|\bpints?\b|\bbar\b|\bdinner\b|\bafter work\b/i.test(q) || category === "pub";
  const toHH = (h: number, mer?: string) => {
    if (mer) return mer.toLowerCase() === "pm" ? (h % 12) + 12 : h % 12;
    if (h >= 13) return h;
    if (h === 12) return 12;
    if (eveningish) return h + 12;
    if (h <= 6) return h + 12;
    return morningish ? h : h + 12;
  };
  let m = /\b(\d{1,2})[:.](\d{2})\s*(am|pm)?\b/i.exec(q);
  if (m && Number(m[1]) <= 23) return `${String(toHH(Number(m[1]), m[3])).padStart(2, "0")}:${m[2]}`;
  m = /\b(\d{1,2})\s*(am|pm)\b/i.exec(q);
  if (m && Number(m[1]) <= 12) return `${String(toHH(Number(m[1]), m[2])).padStart(2, "0")}:00`;
  m = /\b(?:at|around|about|by|from|for)\s+(?:half (?:past )?)?(\d{1,2})(?!\s*(?:min|mins|minutes|people|of us|quid|pounds|£|%|\/|th|st|nd|rd))\b/i.exec(q);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 23) return `${String(toHH(Number(m[1]))).padStart(2, "0")}:${/half/i.test(m[0]) ? "30" : "00"}`;
  // "friday 7", "saturday at 3", "tonight 8"
  m = /\b(?:(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|tonight|tomorrow)\s+(\d{1,2})(?![:.\d]|\s*(?:min|mins|minutes|people|of us|quid|pounds|th|st|nd|rd))\b/i.exec(q);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 23) return `${String(toHH(Number(m[1]))).padStart(2, "0")}:00`;
  if (/\bnoon\b|\bmidday\b/i.test(q)) return "12:00";
  return null;
}

/** Time implied by a word, not a clock ("tonight" → 19:00); planTime moves these to now when already past. */
function wordTimeOf(q: string): string | null {
  if (/\bbreakfast\b/i.test(q)) return "09:00";
  if (/\bmorning\b/i.test(q)) return "10:00";
  if (/\blunch(?:time)?\b/i.test(q)) return "12:30";
  if (/\bafternoon\b/i.test(q)) return "15:00";
  if (/\bafter work\b/i.test(q)) return "18:00";
  if (/\bevening\b|\btonight\b|\bdinner\b/i.test(q)) return "19:00";
  return null;
}

/** Rules-only parse of a "where shall we meet / what's on" ask. `today` is a London YYYY-MM-DD. */
export function parsePlanAsk(raw: string, today = londonToday()): PlanAsk {
  const slots: { them?: string; you?: string } = {};
  const q = fixTypos(raw.replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim())
    .replace(SLOT_TOKEN_RE, (_m, k: string, v: string) => {
      slots[k.toLowerCase() as "them" | "you"] = v.trim();
      return "";
    })
    .trim();
  const signals: string[] = [];
  let youPlace: string | null = null;
  let themPlace: string | null = null;
  let between: RegExpExecArray | null = BETWEEN_RE.exec(q);
  if (!between) {
    const b = BETWEEN_ANY_RE.exec(q) ?? (YOU_RE.test(q) ? null : PAIR_RE.exec(q));
    if (b && known(cleanPlace(b[1])) && known(cleanPlace(b[2]))) between = b;
  }
  if (between) {
    youPlace = cleanPlace(between[1]);
    themPlace = cleanPlace(between[2]);
    signals.push("between A and B");
  }
  if (!youPlace) {
    const m = YOU_RE.exec(q) ?? ME_SLOT_RE.exec(q);
    youPlace = cleanPlace(m?.[1]);
    if (youPlace) signals.push(`you: "${youPlace}"`);
  }
  if (!themPlace) {
    const m = THEM_PRONOUN_RE.exec(q) ?? THEM_NAME_RE.exec(q);
    const n = m ? null : (WITH_FROM_RE.exec(q) ?? THEM_SLOT_RE.exec(q));
    themPlace = cleanPlace(m?.[2] ?? n?.[2] ?? n?.[1]);
    if (themPlace) signals.push("other person's place found");
  }
  if (slots.you && cleanPlace(slots.you)) {
    youPlace = cleanPlace(slots.you);
    signals.push("your place from your answer");
  }
  if (slots.them && cleanPlace(slots.them)) {
    themPlace = cleanPlace(slots.them);
    signals.push("their place from your answer");
  }
  const themCoarse = coarseArea(themPlace);
  if (themCoarse) {
    themPlace = themCoarse.station;
    signals.push("their area approximate");
  }
  const youCoarse = coarseArea(youPlace);
  if (youCoarse) {
    youPlace = youCoarse.station;
    signals.push("your area approximate");
  }
  const category = categoryOf(q);
  const walkIn = WALKIN_RE.test(q);
  const free = /\bfree\b/i.test(q);
  const near = NEAR_ME_RE.test(q);
  let intent: PlanAsk["intent"] = null;
  if (themPlace || between) intent = "meet_halfway";
  else if (near) intent = "near_me";
  else if (HALFWAY_RE.test(q) || SOCIAL_RE.test(q)) intent = "meet_halfway";
  else if (category || youPlace) intent = "near_me";
  if (SOLO_RE.test(q) && !between && !slots.them) {
    // Just the user: no other person to meet halfway with, so plan near them (or the area they named).
    intent = "near_me";
    themPlace = null;
    signals.push("solo");
  }
  if (youPlace && CENTRE_PLACE_RE.test(youPlace)) youPlace = null;
  if (intent === "near_me" && !youPlace && CENTRE_RE.test(q)) {
    youPlace = CENTRE_AREA;
    signals.push(`central London → ${CENTRE_AREA}`);
  }
  if (intent === "near_me" && !youPlace) {
    const m = NEAR_PLACE_RE.exec(q);
    const p = cleanPlace(m?.[1]);
    if (p && !/^(Saturday|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|London)$/i.test(p)) youPlace = p;
  }
  if (intent) signals.unshift(`intent ${intent}`);
  const when = resolveWhen(q, today);
  const clockTime = timeOf(q, category);
  const time = clockTime ?? wordTimeOf(q);
  const budget = /£\s?(\d{1,4}(?:\.\d{1,2})?)/.exec(q) ?? /\b(\d{1,4})\s?(?:quid|pounds|gbp)\b/i.exec(q);
  const maxM = /\bwithin\s+(\d{1,3})\s*(?:min|mins|minutes)\b/i.exec(q) ?? /\b(\d{1,3})\s*(?:min|mins|minutes)\s+(?:away|from me|walk)\b/i.exec(q);
  if (when) signals.push(`day ${when.from}`);
  if (time) signals.push(`time ${time}`);
  if (category) signals.push(`category ${category}`);
  if (budget) signals.push(`budget £${budget[1]}`);
  if (walkIn) signals.push("walk-in");
  if (free) signals.push("free");
  return {
    intent,
    youPlace,
    themPlace,
    themWho: whoOf(q),
    date: when ? when.from : null,
    time,
    ...(time ? { timeKind: clockTime ? ("clock" as const) : ("word" as const) } : {}),
    dayPhrase: when?.phrase ?? null,
    category,
    budgetGBP: budget ? Number(budget[1]) : null,
    walkIn,
    free,
    maxMinutes: maxM ? Number(maxM[1]) : null,
    ...(youCoarse ? { youApprox: youCoarse.label } : {}),
    ...(themCoarse ? { themApprox: themCoarse.label } : {}),
    signals,
  };
}
