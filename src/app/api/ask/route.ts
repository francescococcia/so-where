import { askCognee } from "../../../../scripts/cognee_search";
import { intentOf, localAnswer, placesIn, sessionTitlesAt, venueDirectory, type VenueRow } from "../../../lib/ask-local";
import { dateLabel, londonToday, weekdayOf } from "../../../lib/dates";
import { datesIn, type When } from "../../../lib/when";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// Keeps answers to what the stored documents say: no guessed capacities, addresses or prices.
const GROUNDING =
  "Only state facts written in the context. Never estimate a capacity, address, price or time (for example a capacity from past attendance). Leave out details you don't have; only say 'not listed' when they asked for that detail. Don't invent venues, addresses or numbers.";

function systemPrompt(today: string, when: When | null) {
  return [
    `You are Lumap, a friendly London local who organises community events and knows the city's venues. Today is ${dateLabel(today)} ${today.slice(0, 4)} in London.`,
    when
      ? `They mean ${when.phrase}. The dates are: ${datesIn(when).map(dateLabel).join(", ")}. Only suggest sessions and venues that fit those dates, and put the date from that list next to each pick (a Friday session is on the Friday listed).`
      : "",
    "Answer using only the provided context, the way you'd reply to a friend, in British English:",
    "- one short, warm opening sentence (no heading);",
    "- then 2 to 4 picks as a bulleted list, each starting with the venue's name in bold, e.g. '**Somerset House Exchange**: Co-Working Fridays, Fri 30 Oct, 10:00-20:30, free.' plus one line on why it fits, and the registration link written as [Register on Luma](url) if there is one;",
    "- end with one natural follow-up question, like 'Want something closer to Shoreditch?'.",
    "Keep it under 130 words. No tables, no headings. Never mention memory, databases, documents, records, listings, sources or 'the context'.",
    GROUNDING,
  ]
    .filter(Boolean)
    .join("\n");
}

function splitEvidence(result: string): { answer: string; sources: string[] } {
  const evidence = /(?:^|\r?\n)\**(?:Evidence|Sources?|References?)\**\s*:?\s*(?:\r?\n)/im.exec(result);
  if (!evidence || evidence.index === undefined) {
    return { answer: result.trim(), sources: [] };
  }
  const answer = result.slice(0, evidence.index).trim();
  const sources = result
    .slice(evidence.index + evidence[0].length)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+\.)\s*/, "").trim())
    .filter(Boolean);
  return { answer, sources };
}

// The model sometimes computes weekdays from the wrong calendar ("Fri 27 Oct"); use the real date for that weekday.
const WD = "(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\\.?,?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
function fixDates(text: string, when: When | null) {
  if (!when) return text;
  const byDay = new Map(datesIn(when).map((d) => [weekdayOf(d), dateLabel(d)]));
  return text.replace(new RegExp(WD, "g"), (m, day: string) => byDay.get(day.toLowerCase().slice(0, 3) as never) ?? m);
}

/** Drops "time: not listed, price: not listed" filler the model adds for fields nobody asked about. */
function tidy(text: string) {
  return text
    .replace(/[;,–-]?\s*(?:time|price|registration|address|capacity|day)\s*:\s*not listed\b\.?/gi, "")
    .replace(/(?<!\])\(\s*(https?:\/\/[^\s)]+)\s*\)/g, (_m, url: string) => `[${/^https?:\/\/(www\.)?(luma\.com|lu\.ma)\//i.test(url) ? "Register on Luma" : "Event page"}](${url})`)
    .replace(/register on Luma\s*\[Register on Luma\]/gi, "[Register on Luma]")
    .replace(/[ \t]+$/gm, "");
}

type Hit = Omit<VenueRow, "guest_count_lower_bound"> & { reason: string | null; distance_m: number | null; sessions?: unknown; aliases?: string[] };

/** The same row shape the map search uses (with sessions and reason), so the venue panel opens fully. */
async function toHits(rows: VenueRow[]): Promise<Hit[]> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return Promise.all(
    rows.slice(0, 8).map(async (row) => {
      const aliases = sessionTitlesAt(row);
      const plain: Hit = { ...row, reason: null, distance_m: null, aliases };
      if (!url || !key) return plain;
      try {
        const res = await fetch(`${url.replace(/\/$/, "")}/rest/v1/rpc/search_venues`, {
          method: "POST",
          headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ lat: row.lat, lng: row.lng, radius_m: 80, max_results: 20 }),
          signal: AbortSignal.timeout(3000),
          cache: "no-store",
        });
        const list = res.ok ? ((await res.json()) as Hit[]) : [];
        const hit = Array.isArray(list) ? list.find((h) => h.id === row.id) : undefined;
        return hit ? { ...hit, distance_m: null, aliases } : plain;
      } catch {
        return plain;
      }
    }),
  );
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Send a valid JSON question." }, { status: 400 });
  }
  const question = str(body?.question);
  if (!question.trim() || question.length > 4000) {
    return Response.json({ error: "Enter a question under 4,000 characters." }, { status: 400 });
  }
  // "quick": instant answer from data we hold. "memory": community memory only. Default: memory, then quick.
  const mode = str(body.mode) || "auto";
  const latest = str(body.latest) || question;
  const previous = Array.isArray(body.previous) ? body.previous.filter((p): p is string => typeof p === "string").slice(-4) : [];
  const today = londonToday();
  const intent = intentOf(latest, previous, today);
  const rowsPromise = venueDirectory();

  const quick = async () => {
    const rows = await rowsPromise;
    const local = localAnswer(intent, rows, today);
    if (!local) return null;
    return { answer: local.answer, sources: [] as string[], places: await toHits(placesIn(local.answer, rows)), when: intent.when, from: "quick" };
  };

  if (mode === "quick") return Response.json((await quick()) ?? { answer: null, sources: [], places: [], when: intent.when, from: "quick" });

  const dated = intent.when ? `${question.trim()}\n\n(Dates they mean: ${intent.when.label}.)` : question.trim();
  const query = intent.occasion === "cowork" ? `${dated}\n\nWhich London coworking sessions or spaces fit? Include the venue, date, time, price and how to register.` : dated;
  const raw = await askCognee(query, { systemPrompt: systemPrompt(today, intent.when), timeoutMs: 22000 });
  if (raw && raw.length > 80) {
    // The model writes non-breaking hyphens (U+2011), which break URLs like luma.com/london-oct-23.
    const split = splitEvidence(raw.replace(/[\u2010\u2011]/g, "-"));
    const answer = tidy(fixDates(split.answer, intent.when));
    const sources = split.sources;
    const rows = await rowsPromise;
    return Response.json({ answer, sources, places: await toHits(placesIn(answer, rows)), when: intent.when, from: "memory" });
  }
  if (mode !== "memory") {
    const local = await quick();
    if (local) return Response.json(local);
  }
  return Response.json({ error: "I couldn't come up with an answer just now. Try asking in a different way?", answer: null, sources: [], places: [] }, { status: 503 });
}
