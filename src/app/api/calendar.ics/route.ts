import { getEvents } from "../../../lib/events";
import { eventsToIcs } from "../../../lib/ics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return new Response(eventsToIcs(getEvents()), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="lumap-london.ics"',
      "Cache-Control": "no-store",
    },
  });
}
