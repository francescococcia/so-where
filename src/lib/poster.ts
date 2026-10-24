// "Snap a poster": Gemini reads a poster / venue sign / menu photo into structured fields, and
// buildSuggestedQuery turns those into an ask /api/plan understands ("Get me to <title> at <venue>, …").
// The image and its text are never stored or logged.
import { addDays, londonToday } from "@/lib/dates";

export type PosterKind = "event" | "venue" | "menu" | "other";
export type PosterExtract = {
  kind: PosterKind;
  title: string | null;
  venueName: string | null;
  address: string | null;
  area: string | null;
  /** YYYY-MM-DD (London), resolved against today when the poster says "Sat" / "this Friday". */
  date: string | null;
  /** Last day (YYYY-MM-DD) of a multi-day event ("Fri 23 – Sun 25 Oct"), else null. */
  endDate: string | null;
  /** HH:MM, 24 h. */
  startTime: string | null;
  endTime: string | null;
  price: string | null;
  free: boolean | null;
  needsRegistration: boolean | null;
  url: string | null;
  confidence: number;
  notes: string | null;
};

const MODEL = process.env.GEMINI_MODEL || "gemini-3-flash-preview";
const S = { type: "STRING", nullable: true };
const B = { type: "BOOLEAN", nullable: true };
const SCHEMA = {
  type: "OBJECT",
  properties: {
    kind: { type: "STRING", enum: ["event", "venue", "menu", "other"] },
    title: S, venueName: S, address: S, area: S, date: S, endDate: S, startTime: S, endTime: S, price: S, free: B, needsRegistration: B, url: S,
    confidence: { type: "NUMBER" },
    notes: S,
  },
  required: ["kind", "confidence"],
  propertyOrdering: ["kind", "title", "venueName", "address", "area", "date", "endDate", "startTime", "endTime", "price", "free", "needsRegistration", "url", "confidence", "notes"],
};

const WEEKDAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function prompt(today: string): string {
  const wd = WEEKDAY[new Date(`${today}T12:00:00Z`).getUTCDay()];
  return [
    `Today is ${wd} ${today} in London. Read this photo (an event poster, flyer, venue sign, shop front or menu in London) and fill the JSON fields.`,
    `kind: "event" for a dated happening, "venue" for a place sign/shop front, "menu" for a menu, else "other".`,
    `title: the event name (null for a plain venue). venueName: the place it's at. address: street + postcode exactly as printed, else null. area: London neighbourhood if printed or obvious from the address.`,
    `date: YYYY-MM-DD. Resolve relative or partial dates against today: a weekday alone = the next one on or after today; a day+month without year = this year (even if it has just passed; never jump to next year for a date in the last two months). endDate: the last day of a multi-day event (e.g. "Fri 23 – Sun 25 Oct" → date 23rd, endDate 25th), else null. If several separate dates, the next upcoming one (mention others in notes).`,
    `startTime/endTime: HH:MM 24-hour ("7pm" = "19:00", "doors 7.30" = "19:30"). price: as printed e.g. "£8" or "£5–£10". free: true only if it says free/no charge. needsRegistration: true if it says register/sign up/book/RSVP/tickets required, false if "no booking needed"/"just turn up", else null.`,
    `url: a printed web address (add https://). confidence 0–1 for how sure you are of title+venue+date. notes: one short line of anything else useful (age limit, last entry), else null.`,
    `Use null for anything not visible. Never invent a venue, address or date.`,
  ].join("\n");
}

export class PosterError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, max = 160) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, max) : null);
const bool = (v: unknown) => (typeof v === "boolean" ? v : null);
const TIME = /^([01]?\d|2[0-3])[:.]([0-5]\d)$/;
const clockOf = (v: unknown) => {
  const s = str(v, 10);
  const m = s?.match(TIME);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
};

export function cleanExtract(raw: unknown, today: string): PosterExtract {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = (["event", "venue", "menu", "other"] as const).find((k) => k === o.kind) ?? "other";
  let date = str(o.date, 10);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) date = null;
  let endDate = str(o.endDate, 10);
  if (endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || !date || endDate <= date || endDate > addDays(date, 31))) endDate = null;
  // A poster's "31 Oct" read as last year: roll forward to the next occurrence (within a year). A date that
  // has only just passed (the last two months) stays put, so "this weekend's" event reads as on / over.
  if (date && date < addDays(today, -60) && date >= addDays(today, -366)) {
    const bump = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
    const next = bump(date);
    if (next >= today && next <= addDays(today, 366)) {
      date = next;
      if (endDate) endDate = bump(endDate);
    }
  }
  const url = str(o.url, 300);
  const conf = typeof o.confidence === "number" && Number.isFinite(o.confidence) ? Math.max(0, Math.min(1, o.confidence)) : 0;
  return {
    kind,
    title: str(o.title, 120),
    venueName: str(o.venueName, 120),
    address: str(o.address, 200),
    area: str(o.area, 60),
    date,
    endDate,
    startTime: clockOf(o.startTime),
    endTime: clockOf(o.endTime),
    price: str(o.price, 40),
    free: bool(o.free),
    needsRegistration: bool(o.needsRegistration),
    url: url && /^https?:\/\//i.test(url) ? url : url && /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(url) ? `https://${url}` : null,
    confidence: Math.round(conf * 100) / 100,
    notes: str(o.notes, 200),
  };
}

/** Gemini vision → PosterExtract. Throws PosterError with a user-facing message. */
export async function extractPoster(img: { mime: string; base64: string }, opts: { now?: Date; timeoutMs?: number } = {}): Promise<PosterExtract> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new PosterError(503, "Poster reading isn't switched on here yet. Type the event and venue instead.");
  const today = londonToday(opts.now);
  let res: Response;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ inline_data: { mime_type: img.mime, data: img.base64 } }, { text: prompt(today) }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: "low" } },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 11_000),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    throw new PosterError(timeout ? 504 : 502, timeout ? "Reading the poster took too long. Try again, or a closer photo." : "Couldn't reach the poster reader. Try again in a moment.");
  }
  if (!res.ok) {
    // Status only: the body can echo the request.
    throw new PosterError(res.status === 400 ? 422 : 502, res.status === 400 ? "That image couldn't be read. Try a JPEG or PNG photo." : `The poster reader is unavailable right now (${res.status}). Try again shortly.`);
  }
  const j = (await res.json().catch(() => null)) as { candidates?: { content?: { parts?: { text?: string }[] } }[] } | null;
  const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PosterError(502, "Couldn't make sense of that photo. Try again with the poster filling the frame.");
  }
  return cleanExtract(raw, today);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-31" → "Sat 31 Oct" (the form parsePlanAsk reads). */
export function dayPhrase(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  return `${WEEKDAY[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}

// Words the destination parser treats as the end of the place clause, so a title like
// "Live on Sunday" or "Late at 8" can't cut it short.
// (A word joiner after the word, which isn't whitespace to the parser and is invisible on screen.)
const CUT_WORDS = /\b(on|at|by|for)\s+(?=\d|(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b)|\b(from)\s+/gi;
const safe = (s: string) => s.replace(/[,;!?()[\]{}]/g, " ").replace(/\s+/g, " ").trim().replace(CUT_WORDS, (_m, a?: string, b?: string) => `${a ?? b}\u2060 `);

/** A natural ask /api/plan understands, or null when there's nothing to route to. */
export function buildSuggestedQuery(x: PosterExtract, context?: { query?: string | null } | null): string | null {
  const venue = x.venueName ? safe(x.venueName) : null;
  const addr = x.address ? x.address.replace(/[;!?()]/g, " ").replace(/\s+/g, " ").trim() : null;
  const when = `${x.date ? ` on ${dayPhrase(x.date)}${x.endDate ? ` until ${dayPhrase(x.endDate)}` : ""}` : ""}${x.startTime ? ` at ${x.startTime}${x.endTime ? `–${x.endTime}` : ""}` : ""}`;
  const extras = [x.free ? "free" : x.price ? x.price : null, x.needsRegistration === true ? "sign-up needed" : x.needsRegistration === false ? "no sign-up" : null].filter(Boolean);
  const tail = `${when}${extras.length ? ` (${extras.join(", ")})` : ""}`;
  const ctx = context?.query?.trim().replace(/\s+/g, " ").slice(0, 300);
  if (!venue && !addr) {
    if (!x.area) return null;
    const what = x.kind === "menu" ? "Restaurants" : "What's on";
    return `${what} near ${x.area}${when}`;
  }
  // Venue unknown but address printed: route to the address itself.
  const place = venue ? `${venue}${addr && !addr.toLowerCase().startsWith(venue.toLowerCase()) ? `, ${addr}` : addr ? `, ${addr.slice(venue.length).replace(/^[\s,]+/, "") || addr}` : ""}` : `${safe(addr!.split(",")[0])}${addr!.includes(",") ? `, ${addr!.split(",").slice(1).join(",").trim()}` : ""}`;
  const title = x.kind === "event" && x.title && (!venue || x.title.toLowerCase() !== venue.toLowerCase()) ? safe(x.title) : null;
  const head = title ? `${title} at ${place}` : place;
  return ctx ? `Meet halfway for ${head}${tail}. ${ctx}` : `Get me to ${head}${tail}`;
}
