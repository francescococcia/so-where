import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CommunityEvent {
  id: string;
  title: string;
  url?: string;
  start_at: string;
  end_at?: string;
  score: number;
  reasons: string[];
  [key: string]: unknown;
}

interface EventFeed {
  events?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read the cached feed, omit events whose start time has passed, and rank by score. */
export function getEvents(now: Date = new Date()): CommunityEvent[] {
  const path = resolve(process.cwd(), "seed", "events-all.json");
  const feed = JSON.parse(readFileSync(path, "utf8")) as EventFeed;
  if (!Array.isArray(feed.events)) return [];

  const nowMs = now.getTime();
  return feed.events
    .filter((value): value is Record<string, unknown> => isRecord(value))
    .filter((event) => {
      if (typeof event.start_at !== "string") return false;
      const startMs = Date.parse(event.start_at);
      return Number.isFinite(startMs) && startMs > nowMs;
    })
    .map((event) => ({
      ...event,
      id: typeof event.id === "string" ? event.id : "",
      title: typeof event.title === "string" ? event.title : "Untitled event",
      start_at: event.start_at as string,
      ...(typeof event.end_at === "string" ? { end_at: event.end_at } : {}),
      url: typeof event.url === "string" ? event.url : undefined,
      score: typeof event.score === "number" && Number.isFinite(event.score) ? event.score : 0,
      reasons: Array.isArray(event.reasons)
        ? event.reasons.filter((reason): reason is string => typeof reason === "string")
        : [],
    }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------------------------
// "So where?" near-me events: seed events on a given London day, with an honest walk-in verdict.
// The seed has no price or ticket fields, so walk-in is only ever "unknown" or a clear "needs RSVP".
// ---------------------------------------------------------------------------------------------
import allFeed from "../../seed/events-all.json";
import lumaFeed from "../../seed/luma-london.json";

type LumaRow = {
  api_id: string;
  name: string;
  start_at: string;
  end_at?: string;
  url: string;
  guest_count?: number;
  calendar?: { name?: string };
  geo_address_info?: { place_name?: string; short_address?: string; lat?: number; lng?: number; address_hidden?: boolean };
};
type FeedRow = {
  id: string; source: string; title: string; url?: string; start_at: string; end_at?: string | null; city?: string | null;
  lat?: number | null; lng?: number | null; format?: string; size?: number | null; size_kind?: string | null; organiser?: string | null; is_hackathon?: boolean;
};

export type SeedEvent = {
  id: string;
  title: string;
  url?: string;
  start: string;
  end?: string;
  lat: number;
  lng: number;
  place?: string;
  organiser?: string;
  source: string; // "Luma seed", "Meetup seed", ...
  asOf: string; // when the seed was fetched
  walkIn: { value: string; verdict: "confirmed" | "likely" | "unknown"; rsvpRequired: boolean };
};

const SOURCE_NAME: Record<string, string> = { luma: "Luma seed", meetup: "Meetup seed", devpost: "Devpost seed", builderbase: "BuilderBase seed", mlh: "MLH seed" };

export function seedEvents(): SeedEvent[] {
  const feed = allFeed as unknown as { fetched_at: string; events: FeedRow[] };
  const luma = lumaFeed as unknown as { fetched_at: string; events: LumaRow[] };
  const lumaById = new Map(luma.events.map((e) => [e.api_id, e]));
  const out: SeedEvent[] = [];
  for (const e of feed.events) {
    if (e.format === "online" || !Number.isFinite(e.lat) || !Number.isFinite(e.lng)) continue;
    const l = e.source === "luma" ? lumaById.get(e.id.replace(/^luma:/, "")) : undefined;
    const hidden = !!l?.geo_address_info?.address_hidden;
    let walkIn: SeedEvent["walkIn"];
    if (hidden) walkIn = { value: "Needs RSVP: Luma shows the address only after you register", verdict: "confirmed", rsvpRequired: true };
    else if (e.is_hackathon || e.size_kind === "registered" || e.size_kind === "participants")
      walkIn = { value: `Registration-based (${e.is_hackathon ? "hackathon" : e.size_kind})`, verdict: "likely", rsvpRequired: true };
    else walkIn = { value: `Not stated in the listing${e.size ? ` (${e.size} ${e.size_kind ?? "going"})` : ""}`, verdict: "unknown", rsvpRequired: false };
    out.push({
      id: e.id,
      title: e.title,
      url: e.url,
      start: e.start_at,
      end: e.end_at ?? undefined,
      lat: e.lat as number,
      lng: e.lng as number,
      place: hidden ? undefined : l?.geo_address_info?.place_name ?? l?.geo_address_info?.short_address,
      organiser: e.organiser ?? undefined,
      source: SOURCE_NAME[e.source] ?? `${e.source} seed`,
      asOf: e.source === "luma" ? luma.fetched_at : feed.fetched_at,
      walkIn,
    });
  }
  return out;
}

/** Seed events on this London date that haven't ended by `at` (3 h assumed when a listing has no end). */
export function seedEventsOn(londonDate: string, at: Date, toLondonDate: (d: Date) => string): SeedEvent[] {
  return seedEvents().filter((e) => {
    const s = new Date(e.start);
    const end = e.end ? new Date(e.end) : new Date(s.getTime() + 3 * 3600_000);
    return (toLondonDate(s) === londonDate || (s <= at && end > at)) && end > at;
  });
}
