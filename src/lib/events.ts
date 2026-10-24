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
