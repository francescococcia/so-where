// Venue type, use cases and recurring sessions.
// The database fields (venue_type, good_for, sessions from search_venues) win.
// Until the 20261023 migration is pasted, the public facts bundled in
// src/data fill the gap, and the name rules in use-cases.ts are the last resort.

import factsDoc from "@/data/venue-facts.json";
import sessionsDoc from "@/data/recurring-sessions.json";
import { venueKind, type UseCaseId, type VenueKind } from "@/lib/use-cases";
import { DAY_LABEL, toMin, type DayKey } from "@/lib/hours";
import { sessionOnDate } from "@/lib/dates";

export type VenueType =
  | "cafe" | "coworking" | "library" | "community_space" | "bar" | "hotel" | "private_room"
  | "studio" | "office" | "campus" | "hall" | "shop" | "outdoor" | "other";

export type GoodFor = "coworking" | "community_event" | "private_party" | "workshop";

export const TYPE_LABEL: Record<VenueType, string> = {
  cafe: "Café",
  coworking: "Coworking space",
  library: "Library",
  community_space: "Community space",
  bar: "Bar or pub",
  hotel: "Hotel",
  private_room: "Private room",
  studio: "Studio",
  office: "Office",
  campus: "Campus",
  hall: "Hall",
  shop: "Shop",
  outdoor: "Outdoor",
  other: "Venue",
};

export const USE_CASE_GOOD_FOR: Record<UseCaseId, GoodFor> = {
  meetup: "community_event",
  cowork: "coworking",
  party: "private_party",
  workshop: "workshop",
};

const DEFAULT_GOOD_FOR: Record<VenueType, GoodFor[]> = {
  cafe: ["coworking"],
  coworking: ["coworking", "workshop"],
  library: ["coworking"],
  community_space: ["community_event", "workshop"],
  bar: ["private_party"],
  hotel: ["private_party", "community_event"],
  private_room: ["private_party", "community_event"],
  studio: ["workshop", "community_event"],
  office: ["community_event"],
  campus: ["community_event", "workshop"],
  hall: ["community_event", "private_party"],
  shop: ["community_event"],
  outdoor: ["community_event"],
  other: [],
};

const KIND_TO_TYPE: Record<VenueKind, VenueType> = {
  community: "community_space",
  office: "office",
  cafe: "cafe",
  bar: "bar",
  studio: "studio",
  campus: "campus",
  outdoor: "outdoor",
  venue: "other",
};

export type Session = {
  id?: string;
  key?: string;
  title: string;
  organiser: string | null;
  use_case: UseCaseId;
  day_of_week: DayKey;
  start_time: string;
  end_time: string;
  cadence: string | null;
  /** A known date of a fortnightly session (YYYY-MM-DD), so other dates can be computed. */
  anchor_date?: string | null;
  price: string | null;
  rsvp: string | null;
  url: string | null;
  source_url?: string | null;
  source_urls?: string[];
  summary: string | null;
  venue_name?: string;
  with_others?: boolean;
  audience?: string;
};

type Fact = {
  match: string;
  also_match?: string;
  venue_type: VenueType;
  good_for: GoodFor[];
  sources: string[];
  capacity_note?: string;
  hours_note?: string;
};

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, " ").trim();
const FACTS = (factsDoc.venues as Fact[]).map((f) => ({ ...f, keys: [f.match, f.also_match].filter(Boolean).map((k) => norm(k as string)) }));
const SESSIONS = sessionsDoc.sessions as Session[];

export type VenueLike = {
  name?: string | null;
  notes?: string | null;
  terms?: string | null;
  venue_type?: string | null;
  good_for?: string[] | null;
  source_url?: string | null;
  sessions?: Session[] | null;
};

function factFor(name?: string | null) {
  if (!name) return undefined;
  const n = norm(name);
  return FACTS.find((f) => f.keys.includes(n)) ?? FACTS.find((f) => f.keys.some((k) => n.startsWith(k)));
}

export function venueType(v: VenueLike): VenueType {
  if (v.venue_type && v.venue_type in TYPE_LABEL) return v.venue_type as VenueType;
  return factFor(v.name)?.venue_type ?? KIND_TO_TYPE[venueKind(v)];
}

export function venueGoodFor(v: VenueLike): GoodFor[] {
  if (v.good_for?.length) return v.good_for as GoodFor[];
  return factFor(v.name)?.good_for ?? DEFAULT_GOOD_FOR[venueType(v)];
}

export function venueSources(v: VenueLike): string[] {
  const fact = factFor(v.name);
  const list = [v.source_url, ...(fact?.sources ?? [])].filter((s): s is string => Boolean(s));
  return [...new Set(list)];
}

export function venueSessions(v: VenueLike): Session[] {
  if (Array.isArray(v.sessions) && v.sessions.length) return v.sessions;
  if (!v.name) return [];
  const n = norm(v.name);
  return SESSIONS.filter((s) => s.venue_name && (norm(s.venue_name) === n || n.startsWith(norm(s.venue_name))));
}

// A session matches when it is for this use case, on this day, and overlaps the window.
// With a calendar date, sessions whose cadence rules that date out (e.g. "4th Tuesday") are skipped.
export function matchingSession(v: VenueLike, useCase: UseCaseId, day: DayKey, start: string, end: string, date?: string): Session | null {
  const from = toMin(start);
  let to = toMin(end);
  if (from == null || to == null) return null;
  if (to <= from) to += 24 * 60;
  for (const s of venueSessions(v)) {
    if (s.use_case !== useCase || s.day_of_week !== day) continue;
    if (date && sessionOnDate(s, date) === "no") continue;
    const a = toMin(s.start_time);
    const b = toMin(s.end_time);
    if (a == null || b == null) continue;
    if (a < to && b > from) return s;
  }
  return null;
}

// How well a venue suits the use case: 3 if it is listed as good for it, 0 otherwise.
export function useCaseScore(v: VenueLike, useCase: UseCaseId) {
  return venueGoodFor(v).includes(USE_CASE_GOOD_FOR[useCase]) ? 3 : 0;
}

export function sessionWhen(s: Session) {
  return `${DAY_LABEL[s.day_of_week]} ${s.start_time.slice(0, 5)}–${s.end_time.slice(0, 5)}`;
}

// Every known session for this use case and slot, wherever it is.
export function sessionsInSlot(useCase: UseCaseId, day: DayKey, start: string, end: string, date?: string) {
  return SESSIONS.filter((s) => matchingSession({ name: s.venue_name, sessions: [s] }, useCase, day, start, end, date)) as (Session & { lat: number; lng: number })[];
}

/** Every bundled session with coordinates (for the cowork-with-others list and calendar feed). */
export function allSessions() {
  return SESSIONS.filter((s) => typeof (s as { lat?: number }).lat === "number") as (Session & { lat: number; lng: number })[];
}
