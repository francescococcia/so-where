// Display helpers. Every time is shown in London time.
const TZ = "Europe/London";

export function fmtWhen(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" }).format(d);
  return `${day} · ${fmtTime(iso)}`;
}

export function fmtTime(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
}

/** "as of 18:49" today, "as of 22 Oct 18:49" on other days. */
export function fmtAsOf(iso?: string) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameDay = (a: Date, b: Date) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, dateStyle: "short" }).format(a) ===
    new Intl.DateTimeFormat("en-GB", { timeZone: TZ, dateStyle: "short" }).format(b);
  if (sameDay(d, new Date())) return fmtTime(iso);
  const day = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" }).format(d);
  return `${day} ${fmtTime(iso)}`;
}

export function fmtSeconds(ms: number) {
  return ms < 1000 ? `${Math.max(0.1, ms / 1000).toFixed(1)} s` : `${(ms / 1000).toFixed(1)} s`;
}

export function gmapsDirections(lat: number, lng: number) {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=transit`;
}
