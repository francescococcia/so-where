import { getEvents } from "@/lib/events";
import { EventsFeed, type FeedEvent } from "@/components/events-feed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function EventsPage() {
  const events: FeedEvent[] = getEvents()
    .slice(0, 40)
    .map((event) => ({
      id: event.id,
      title: event.title,
      url: event.url ?? null,
      start_at: event.start_at,
      end_at: event.end_at ?? null,
      reasons: event.reasons.slice(0, 3),
      score: event.score,
    }));
  return <EventsFeed events={events} />;
}
