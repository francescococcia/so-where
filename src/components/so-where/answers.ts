import type { Fact, PlanCard as Card } from "@/lib/plan-types";
import { fmtTime } from "./format";

export function findFact(card: Card, re: RegExp) {
  return card.facts.find((f) => re.test(f.label));
}

/** "01:00–01:00", "00:00-00:00", "" → no real time. Such values are hidden rather than shown. */
export function noTime(v: string | undefined | null): boolean {
  if (!v || !v.trim()) return true;
  const m = v.match(/^\s*(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})\s*$/);
  return !!m && +m[1] === +m[3] && m[2] === m[4];
}

/** Category/type label without repeats: "Event · event" → "Event". */
export function kindLabel(type: string, kind: string): string {
  const parts = [type, kind].map((x) => x.trim()).filter(Boolean);
  const seen = new Set<string>();
  return parts.filter((x) => { const k = x.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(" · ");
}

/** "12:00–00:00" → is `when` inside it (London time)? Returns null when we can't tell. */
export function openAt(hours: string | undefined, whenIso: string): boolean | null {
  if (!hours) return null;
  const m = hours.match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = fmtTime(whenIso).split(":").map(Number);
  if (t.length < 2 || t.some(Number.isNaN)) return null;
  const now = t[0] * 60 + t[1];
  const a = +m[1] * 60 + +m[2];
  let b = +m[3] * 60 + +m[4];
  if (b === a) return null; // "01:00–01:00": not real hours
  if (b < a) b += 24 * 60;
  return (now >= a && now < b) || (now + 1440 >= a && now + 1440 < b);
}

export const hoursFact = (card: Card) => findFact(card, /^open/i);
export const priceFact = (card: Card) => findFact(card, /price|entry|fee|£|cost/i);

export type OpenTone = "ok" | "soon" | "closed" | "unknown";
/** Optional server hours fields (intersection type; plan-types.ts unchanged). Read defensively. */
type HoursX = { openAtPlan?: boolean | null; closesAt?: string | null; closingSoon?: boolean | null; hoursKnown?: boolean | null };

/** "23:00" from "23:00", "23:00:00" or an ISO datetime; else undefined. */
function hhmm(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  if (/T\d{2}:\d{2}/.test(v)) return fmtTime(v) || undefined;
  return v.match(/\b([01]?\d|2[0-4]):([0-5]\d)\b/)?.[0];
}
const untilText = (t: string) => (/^(00|24):00$/.test(t) ? "Open until midnight" : `Open until ${t}`);

/** Parsed server hours fact: "Open until 23:00 (12:00–23:00) · checked …", "Open 24 hours", "Closed at 19:00 (12:00–17:00)",
 *  "Hours not in OSM", "OSM hours: …", or an older plain range "12:00–23:00". */
export function parseHours(v: string | undefined): { kind: "until" | "24h" | "closed" | "unknown" | "range" | "other"; until?: string; ranges?: string; checked?: string } {
  if (!v || !v.trim()) return { kind: "unknown" };
  const checked = v.match(/·\s*checked\s+([\d-]+)/)?.[1];
  const ranges = v.match(/\(([^)]*)\)/)?.[1]?.trim();
  if (/^open 24 hours/i.test(v)) return { kind: "24h", checked };
  const u = v.match(/^open until\s+(\d{1,2}:\d{2})/i);
  if (u) return { kind: "until", until: u[1], ranges, checked };
  if (/^closed\b/i.test(v)) return { kind: "closed", ranges, checked };
  if (/not in osm|not listed|unknown|not machine-readable|^osm hours/i.test(v)) return { kind: "unknown" };
  if (/^\s*\d{1,2}:\d{2}\s*[–-]\s*\d{1,2}:\d{2}/.test(v)) return { kind: "range", ranges: v.trim() };
  return { kind: "other" };
}

/** Plain-English "Open?" answer. Prefers the server's openAtPlan/closesAt/closingSoon/hoursKnown when present, then the
 *  hours fact text, then a plain range. Never repeats the fact text: `sub` is only the day's ranges ("12:00–23:00"). */
export function openAnswer(card: Card, whenIso: string): { text: string; sub?: string; state: boolean | null; tone: OpenTone; fact?: Fact } {
  const raw = hoursFact(card);
  const h = raw && !noTime(raw.value) ? raw : undefined;
  const ph = parseHours(h?.value);
  const at = fmtTime(whenIso);
  const x = card as Card & HoursX;
  const closes = hhmm(x.closesAt) ?? ph.until;
  const sub = ph.ranges && ph.kind !== "range" ? ph.ranges : ph.kind === "range" ? ph.ranges : undefined;
  const none = { text: "Hours not listed", state: null, tone: "unknown" as const, fact: h };
  const openTo = (soon: boolean) =>
    soon ? { text: closes ? `Closes soon · ${closes}` : "Closes soon", sub, state: true, tone: "soon" as const, fact: h }
      : ph.kind === "24h" && !hhmm(x.closesAt) ? { text: "Open 24 hours", state: true, tone: "ok" as const, fact: h }
      : { text: closes ? untilText(closes) : `Open at ${at}`, sub, state: true, tone: "ok" as const, fact: h };
  if (x.openAtPlan === true) return openTo(!!x.closingSoon);
  if (x.openAtPlan === false) return { text: `Closed at ${at}`, sub, state: false, tone: "closed", fact: h };
  if (x.hoursKnown === false) return none;
  if (ph.kind === "until" || ph.kind === "24h") return openTo(!!x.closingSoon || /closes within the hour/i.test(h?.value ?? ""));
  if (ph.kind === "closed") return { text: `Closed at ${at}`, sub, state: false, tone: "closed", fact: h };
  if (ph.kind === "unknown" || !h) return none;
  const s = openAt(h.value, whenIso);
  if (s === true) {
    const end = h.value.match(/[–-]\s*(\d{1,2}:\d{2})/)?.[1];
    return { text: end ? untilText(end) : `Open at ${at}`, sub, state: s, tone: "ok", fact: h };
  }
  if (s === false) return { text: `Probably closed at ${at}`, sub, state: s, tone: "closed", fact: h };
  return none;
}

/** Hours row for the checks list: "Hours Thursday" + "Open until 23:00 (12:00–23:00) · checked …", or "Hours not listed". */
export function hoursRow(f: Fact | undefined): Fact | undefined {
  if (!f) return f;
  const label = f.label.replace(/^open\b/i, "Hours");
  return { ...f, label, value: parseHours(f.value).kind === "unknown" ? "not listed" : f.value };
}

/** Cuisine chip text from the server's "Cuisine" fact: "Italian (OSM cuisine=italian)" → "Italian". Null when it's a "Not …". */
export function cuisineChip(card: Card): { text: string; likely: boolean } | null {
  const f = findFact(card, /^cuisine/i);
  if (!f || /^not\b/i.test(f.value) || f.verdict === "unknown") return null;
  const text = f.value.split(/\s*[(,;·]/)[0].trim();
  if (!text || text.length > 24) return null;
  return { text: text.replace(/^./, (c) => c.toUpperCase()), likely: f.verdict !== "confirmed" };
}

export const TONE_CLASS: Record<OpenTone, string> = { ok: "text-ok", soon: "text-amber-ink", closed: "text-amber-ink", unknown: "text-unknown" };

/** Plain-English "Cost?" answer. */
export function costAnswer(card: Card): { text: string; fact?: Fact } {
  const p = priceFact(card);
  if (!p || /^(no |not |none|unknown)/i.test(p.value)) return { text: "Price not listed", fact: p };
  return { text: p.value, fact: p };
}

/** Short version of an unknowns line: "Prices: none of our sources has them" → "Prices". */
export function shortUnknown(u: string): string {
  const s = u.trim().replace(/\.$/, "");
  if (/^prices?\b|price/i.test(s)) return "Prices";
  if (/busy|noisy|noise/i.test(s)) return /noise/i.test(s) && !/busy/i.test(s) ? "Noise level" : "How busy it'll be";
  if (/step-free|wheelchair/i.test(s)) return "Step-free access";
  if (/line status is as of now/i.test(s)) return "Line status is for now, not later";
  if (/live line status/i.test(s)) return "Live line status";
  if (/^weather/i.test(s)) return "Weather";
  let m = s.match(/^(.+?): opening hours not in OSM/i);
  if (m) return `${m[1]}: hours`;
  m = s.match(/^TfL didn't return times for (.+?),/i);
  if (m) return `Times from ${m[1]}`;
  if (/^No time given/i.test(s)) return s.replace(/^No time given, so this is planned for/i, "No time given: planned for");
  if (/^You didn't say what kind of place/i.test(s)) return s.replace(/^You didn't say what kind of place, so these are/i, "Kind of place: showing");
  return s.split(/,\s*so\b|:\s*(?:no source|the seed|none of)/i)[0];
}
