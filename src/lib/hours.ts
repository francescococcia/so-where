export type DayKey = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
export type Hours = Partial<Record<DayKey, { start?: string; end?: string }>> | null | undefined;

export const DAY_LABEL: Record<DayKey, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
export const WEEK: DayKey[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

// covers: the venue is open for the whole window.
// short: open that day but opens later or closes earlier than the window.
// closed: hours are listed and the day is missing.
// unknown: no hours listed yet.
export type HoursFit = {
  state: "covers" | "short" | "closed" | "unknown";
  label: string;
  open?: { start: string; end: string };
};

export function toMin(t: string | undefined | null): number | null {
  if (!t) return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hasHours(hours: Hours) {
  return !!hours && typeof hours === "object" && Object.keys(hours).length > 0;
}

export function dayWindow(hours: Hours, day: DayKey) {
  if (!hasHours(hours)) return undefined;
  const slot = hours?.[day];
  if (!slot?.start || !slot?.end) return null;
  return { start: slot.start.slice(0, 5), end: slot.end.slice(0, 5) };
}

export function hoursFit(hours: Hours, day: DayKey | "", start: string, end: string): HoursFit {
  if (!hasHours(hours)) return { state: "unknown", label: "Hours not listed yet" };
  if (!day) return { state: "covers", label: "Any day" };
  const open = dayWindow(hours, day);
  if (!open) return { state: "closed", label: `Closed ${DAY_LABEL[day]}` };
  const os = toMin(open.start)!;
  let oe = toMin(open.end)!;
  if (oe <= os) oe += 24 * 60;
  const ws = toMin(start);
  let we = toMin(end);
  if (ws != null && we != null && we <= ws) we += 24 * 60;
  const range = `${open.start}–${open.end}`;
  if (ws != null && ws < os) return { state: "short", label: `Opens ${open.start}`, open };
  if (we != null && we > oe) return { state: "short", label: `Closes ${open.end}`, open };
  if (ws != null && ws >= oe) return { state: "short", label: `Closes ${open.end}`, open };
  return { state: "covers", label: `Open ${range} ✓`, open };
}
