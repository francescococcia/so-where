// Calendar dates for the search (London time). Dates are "YYYY-MM-DD" strings.

import { DAY_LABEL, WEEK, type DayKey } from "@/lib/hours";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function londonToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const parts = (iso: string) => iso.split("-").map(Number) as [number, number, number];
const utc = (iso: string) => {
  const [y, m, d] = parts(iso);
  return new Date(Date.UTC(y, m - 1, d));
};
const toIso = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(iso: string, n: number) {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

export function weekdayOf(iso: string): DayKey {
  return WEEK[(utc(iso).getUTCDay() + 6) % 7];
}

/** "Sat 24 Oct" */
export function dateLabel(iso: string) {
  const [, m, d] = parts(iso);
  return `${DAY_LABEL[weekdayOf(iso)]} ${d} ${MONTHS[m - 1]}`;
}

/** The next date (today included) that falls on this weekday. */
export function nextWeekday(from: string, day: DayKey) {
  const diff = (WEEK.indexOf(day) - WEEK.indexOf(weekdayOf(from)) + 7) % 7;
  return addDays(from, diff);
}

export function quickDates(today: string) {
  const thisFri = nextWeekday(today, "fri");
  const chips = [
    { label: "Today", date: today },
    { label: "Tomorrow", date: addDays(today, 1) },
    { label: "This Fri", date: thisFri },
    { label: "This Sat", date: nextWeekday(today, "sat") },
    { label: "This Sun", date: nextWeekday(today, "sun") },
    { label: "Next Fri", date: addDays(thisFri, 7) },
  ];
  const seen = new Set<string>();
  return chips.filter((c) => (seen.has(c.date) ? false : (seen.add(c.date), true)));
}

/** Local-midnight Date for the calendar widget, and back. */
export const isoToLocalDate = (iso: string) => {
  const [y, m, d] = parts(iso);
  return new Date(y, m - 1, d);
};
export const localDateToIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const ORD: Record<string, number> = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4, "5th": 5, fifth: 5 };

/**
 * Does a recurring session happen on this exact date?
 * "yes" for weekly sessions and computable monthly ones (e.g. "4th Tuesday of the month"),
 * "no" when the weekday or the nth-weekday rule doesn't match,
 * "check" when the cadence can't be pinned down (fortnightly without a start date, "dates on Luma").
 */
export function sessionOnDate(s: { day_of_week: DayKey; cadence?: string | null; anchor_date?: string | null }, iso: string): "yes" | "no" | "check" {
  if (weekdayOf(iso) !== s.day_of_week) return "no";
  const c = (s.cadence ?? "").trim().toLowerCase();
  if (!c || /^weekly$|every week/.test(c)) return "yes";
  const [, , d] = parts(iso);
  const nth = /(1st|2nd|3rd|4th|5th|first|second|third|fourth|fifth|last)\s+\w+\s+of\s+(the|every)\s+month/.exec(c);
  if (nth) {
    if (nth[1] === "last") return addDays(iso, 7).slice(5, 7) !== iso.slice(5, 7) ? "yes" : "no";
    return Math.ceil(d / 7) === ORD[nth[1]] ? "yes" : "no";
  }
  if (/every other|fortnight|bi-?weekly/.test(c) && s.anchor_date) {
    const days = Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${s.anchor_date}T12:00:00Z`)) / 86400000);
    return ((days % 14) + 14) % 14 === 0 ? "yes" : "no";
  }
  return "check";
}
