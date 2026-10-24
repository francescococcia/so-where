// Server-built "Send plan" text: short, friendly, ready to paste. No TfL line status, no sources, and never the
// other person's area or address (only the venue, the time, the hub station and their journey time).
import { londonToday } from "@/lib/dates";
import { londonDayShort, londonParts } from "@/lib/london-time";
import { clock12 } from "@/lib/refine";

/** "tonight at 8pm", "tomorrow at 1pm", "Fri 30 Oct at 7pm". */
export function friendlyWhen(when: Date, now = new Date()): string {
  const p = londonParts(when);
  const t = clock12(p.hh, p.mm);
  const today = londonToday(now);
  const tomorrow = londonToday(new Date(now.getTime() + 24 * 3600_000));
  if (p.date === today) return `${p.hh >= 17 ? "tonight" : "today"} at ${t}`;
  // A late-night slot just past midnight is still "tonight" to the person reading it.
  if (p.date === tomorrow && p.hh < 4 && londonParts(now).hh >= 20) return `tonight at ${t}`;
  if (p.date === tomorrow) return `tomorrow at ${t}`;
  const [, m, d] = p.date.split("-").map(Number);
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${londonDayShort(when)} ${d} ${MON[m - 1]} at ${t}`;
}

function activity(category: string | null | undefined, when: Date): string {
  const h = londonParts(when).hh;
  if (category === "cafe") return "a coffee";
  if (category === "restaurant") return h < 16 ? "lunch" : "dinner";
  if (category === "pub") return "a drink";
  return "meeting up";
}

const strip = (s: string) => s.replace(/\s+/g, " ").trim();

export function meetDraft(o: { venue?: string; address?: string; hub: string; when: Date; category?: string | null; themMinutes: number; url?: string; now?: Date }): string {
  const when = friendlyWhen(o.when, o.now);
  const what = activity(o.category, o.when);
  if (!o.venue) return strip(`Hey! Fancy ${what} ${when}? Somewhere near ${o.hub} station works out fair for both of us, about ${o.themMinutes} min for you 🙂`);
  const place = `${o.venue}${o.address ? `, ${o.address}` : ""} (near ${o.hub} station)`;
  return strip(`Hey! Fancy ${what} ${when}? How about ${place}? It's about ${o.themMinutes} min for you 🙂${o.url ? ` ${o.url}` : ""}`);
}

export function nearDraft(o: { picks: { name: string; event: boolean; free: boolean; url?: string }[]; when: Date; now?: Date }): string {
  const [top, ...rest] = o.picks;
  if (!top) return "";
  const when = friendlyWhen(o.when, o.now);
  const lead = top.event ? `Fancy coming to ${top.name} with me ${when}?` : `Fancy ${top.name} ${when}?`;
  const extra = top.free ? " It's free to get in." : "";
  const others = rest.length ? ` Or ${rest.map((r) => r.name).join(" or ")}.` : "";
  return strip(`Hey! ${lead}${extra}${others}${top.url ? ` ${top.url}` : ""}`);
}
