// "Cowork with others": recurring sessions where the answer is people, not just a desk.

import { LONDON_AREAS } from "@/lib/areas";
import { DAY_LABEL, WEEK, type DayKey } from "@/lib/hours";
import { allSessions, type Session } from "@/lib/venue-facts";

export type CoworkItem = Session & {
  key: string;
  lat: number;
  lng: number;
  area: string;
  community?: boolean; // hosted through Lumap and vouched in this browser
};

export function nearestArea(lat: number, lng: number) {
  return [...LONDON_AREAS].sort((a, b) => Math.hypot(a.lat - lat, (a.lng - lng) * 0.62) - Math.hypot(b.lat - lat, (b.lng - lng) * 0.62))[0];
}

export function coworkSessions(): CoworkItem[] {
  return allSessions()
    .filter((s) => s.use_case === "cowork" || s.with_others)
    .map((s) => ({ ...s, key: s.key ?? s.title, area: nearestArea(s.lat, s.lng).name }));
}

/** London weekday for "today", as a DayKey. */
export function londonToday(now = new Date()): DayKey {
  const w = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "Europe/London" }).format(now).toLowerCase().slice(0, 3);
  return (WEEK as string[]).includes(w) ? (w as DayKey) : "mon";
}

/** The next 7 days starting today, with the date each weekday falls on. */
export function weekAhead(now = new Date()) {
  const today = londonToday(now);
  const start = WEEK.indexOf(today);
  const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });
  return Array.from({ length: 7 }, (_, i) => {
    const day = WEEK[(start + i) % 7];
    const date = new Date(now.getTime() + i * 86400_000);
    return { day, date, label: `${i === 0 ? "Today" : i === 1 ? "Tomorrow" : DAY_LABEL[day]} · ${dateFmt.format(date)}` };
  });
}

/** Sessions for each of the next 7 days. Fortnightly/monthly ones are flagged so people check the date. */
export function coworkWeek(items: CoworkItem[], now = new Date()) {
  return weekAhead(now)
    .map((d) => ({ ...d, sessions: items.filter((s) => s.day_of_week === d.day).sort((a, b) => a.start_time.localeCompare(b.start_time)) }))
    .filter((d) => d.sessions.length);
}

export function isWeekly(s: Pick<Session, "cadence">) {
  return !s.cadence || /^weekly$|every week/i.test(s.cadence.trim());
}
