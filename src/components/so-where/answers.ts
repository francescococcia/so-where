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

/** Plain-English "Open?" answer. Prefers the server's openAtPlan/closesAt/closingSoon/hoursKnown when present. */
export function openAnswer(card: Card, whenIso: string): { text: string; sub?: string; state: boolean | null; tone: OpenTone; fact?: Fact } {
  const raw = hoursFact(card);
  const h = raw && !noTime(raw.value) ? raw : undefined;
  const at = fmtTime(whenIso);
  const x = card as Card & HoursX;
  const closes = hhmm(x.closesAt);
  const sub = h?.value ? `Hours ${h.value}` : undefined;
  if (x.hoursKnown === false && typeof x.openAtPlan !== "boolean") return { text: "Hours not listed", state: null, tone: "unknown", fact: h };
  if (x.openAtPlan === true) {
    if (x.closingSoon) return { text: closes ? `Closes soon · ${closes}` : "Closes soon", sub, state: true, tone: "soon", fact: h };
    return { text: closes ? untilText(closes) : `Open at ${at}`, sub, state: true, tone: "ok", fact: h };
  }
  if (x.openAtPlan === false) return { text: `Closed at ${at}`, sub, state: false, tone: "closed", fact: h };
  const s = openAt(h?.value, whenIso);
  if (s === true) {
    const end = h?.value.match(/[–-]\s*(\d{1,2}:\d{2})/)?.[1];
    return { text: end ? untilText(end) : `Open at ${at}`, sub, state: s, tone: "ok", fact: h };
  }
  if (s === false) return { text: `Probably closed at ${at}`, sub, state: s, tone: "closed", fact: h };
  return { text: h?.value && !/not|unknown/i.test(h.value) ? h.value : "Hours not listed", state: null, tone: "unknown", fact: h };
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
