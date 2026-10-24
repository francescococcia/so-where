// Europe/London wall-clock helpers (BST/GMT aware) for the plan pipeline.

export type LondonParts = { date: string; hh: number; mm: number };

export function londonParts(d: Date): LondonParts {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hh: Number(p.hour), mm: Number(p.minute) };
}

/** The UTC instant for a London wall-clock date + time. */
export function londonToUtc(date: string, hh: number, mm: number): Date {
  const [y, m, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  let t = wall;
  for (let i = 0; i < 3; i++) {
    const p = londonParts(new Date(t));
    const [py, pm, pd] = p.date.split("-").map(Number);
    const seen = Date.UTC(py, pm - 1, pd, p.hh, p.mm);
    t += wall - seen;
  }
  return new Date(t);
}

/** A Date whose *local* fields equal London wall time (for libraries that read getHours() etc.). */
export function londonWallAsLocal(d: Date): Date {
  const p = londonParts(d);
  const [y, m, day] = p.date.split("-").map(Number);
  return new Date(y, m - 1, day, p.hh, p.mm);
}

export const hhmm = (hh: number, mm: number) => `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Thu 29 Oct, 19:00" */
export function londonLabel(d: Date) {
  const p = londonParts(d);
  const [y, m, day] = p.date.split("-").map(Number);
  const wd = DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${wd} ${day} ${MONTHS[m - 1]}, ${hhmm(p.hh, p.mm)}`;
}
export function londonDayShort(d: Date) {
  const p = londonParts(d);
  const [y, m, day] = p.date.split("-").map(Number);
  return DAYS[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
}
/** "19:42" London, for "as of" labels. */
export const londonClock = (iso: string) => {
  const p = londonParts(new Date(iso));
  return hhmm(p.hh, p.mm);
};
