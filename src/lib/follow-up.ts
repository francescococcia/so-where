// Compound follow-ups ("what time do they close? and what time do you recommend?"): split into questions, classify each,
// and answer the ones we can from the plan on screen. Any part we can't classify → the caller replans instead.
// Pure helpers only (no I/O); the user's text is never logged.
import { isLeaveQuestion, normLeave } from "@/lib/leave-time";

export type FollowKind = "open" | "leave" | "recommend";

/** "a? and b?" / "a, and what time…" / "a and when should…" → ["a", "b"]. */
export function splitQuestions(text: string): string[] {
  return text
    .split(/\?+|[;.]\s+|,?\s+(?:and|also|plus|then)\s+(?=(?:what|when|which|how|is|are|do|does|should|shall|can|could|will|would|by)\b)/i)
    .map((s) => s.replace(/^\s*(?:and|also|plus|then)\b\s*/i, "").trim())
    .filter((s) => s.replace(/[^a-z0-9]/gi, "").length > 2);
}

const RECO_RE = new RegExp(
  [
    String.raw`\b(?:what|which) time\b.{0,40}\b(?:recommend|suggest|best|ideal|good time|would you|do you think|should (?:we|i) meet|shall (?:we|i) meet)\b`,
    String.raw`\b(?:recommend|suggest)(?:ed)?\b.{0,25}\b(?:time|hour|when)\b`,
    String.raw`\bbest (?:time|hour)\b`,
    String.raw`\bgood time to (?:meet|go)\b`,
    String.raw`\bwhen (?:should|shall|do you think|would you) (?:we|i) meet\b`,
    String.raw`\bwhat time (?:should|shall) (?:we|i) meet\b`,
    String.raw`\bwhat time (?:is best|works best|would be best)\b`,
  ].join("|"),
);
const OPEN_RE = /\b(?:open|opens|opening|close|closes|closing|shut|shuts|hours)\b/;

/** One question → what it asks; null = something we can't answer from the plan on screen. */
export function classifyQuestion(q: string): FollowKind | null {
  const t = normLeave(q);
  if (RECO_RE.test(t)) return "recommend";
  if (isLeaveQuestion(t)) return "leave";
  if (OPEN_RE.test(t) && /\b(?:what time|when|until|is it|are they|is .{1,40} open|how late|till|hours)\b/.test(t) && !/\b(?:other|another|instead|cheaper|quieter|closer|nearer|change|different)\b/.test(t)) return "open";
  return null;
}

/** Opening window from a card's "Open <Day>" fact ("Open until 20:00 (08:00–20:00)"); null when unknown. */
export function openWindow(factValue: string): { opens: string; closes: string } | "24h" | null {
  if (/^Open 24 hours/.test(factValue)) return "24h";
  const m = /\((\d\d:\d\d)[–-](\d\d:\d\d)\)/.exec(factValue);
  return m ? { opens: m[1], closes: m[2] } : null;
}

const toMin = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fmt = (m: number) => `${String(Math.floor((((m % 1440) + 1440) % 1440) / 60)).padStart(2, "0")}:${String((((m % 1440) + 1440) % 1440) % 60).padStart(2, "0")}`;

/**
 * A meeting time for one venue from its real opening window, the plan time, both travel times and (when the plan is today)
 * the clock now. Never claims how busy it is: it only talks about the opening window.
 */
export function recommendTime(o: {
  name: string;
  window: { opens: string; closes: string } | "24h" | null;
  planMin: number;
  planClock: string;
  nowMin: number | null; // minutes since midnight now, only when the plan is today
  youMin?: number;
  themMin?: number;
  who: string;
  day?: string; // "Mon 26 Oct", the plan's date
}): { reply: string; clock: string | null } {
  const travel = Math.max(o.youMin ?? 0, o.themMin ?? 0);
  const trip = o.youMin !== undefined ? ` Travel: you ${o.youMin} min${o.themMin !== undefined ? `, ${o.who} ${o.themMin}` : ""}.` : "";
  if (!o.window) return { reply: `No opening hours are listed for ${o.name}, so I can't pick a time from them; your plan says ${o.planClock}.${trip}`, clock: null };
  if (o.window === "24h") return { reply: `${o.name} is open 24 hours, so any time works; your plan's ${o.planClock} is fine.${trip}`, clock: null };
  const opens = toMin(o.window.opens);
  let closes = toMin(o.window.closes);
  if (closes <= opens) closes += 1440; // past midnight
  const earliest = Math.max(opens, o.nowMin !== null ? Math.ceil((o.nowMin + travel + 5) / 15) * 15 : 0);
  const lastGood = closes - 60; // leave yourselves at least an hour there
  if (earliest > lastGood) return { reply: `${o.name} closes at ${o.window.closes}, which is too soon to meet there comfortably today; ask me for somewhere open later.`, clock: null };
  const plan = o.planMin < opens && o.planMin + 1440 <= closes ? o.planMin + 1440 : o.planMin;
  const planFits = plan >= earliest && plan <= closes - 90;
  const pick = planFits ? plan : Math.max(earliest, closes - 120);
  const left = closes - pick;
  const leftTxt = left >= 120 && left % 60 === 0 ? `${left / 60} hours` : left >= 60 ? `${Math.floor(left / 60)} h ${left % 60 ? `${left % 60} min` : ""}`.trim() : `${left} min`;
  const range = earliest === lastGood ? `${fmt(earliest)} is the last comfortable start` : `any start from ${fmt(earliest)} to ${fmt(lastGood)} fits its opening hours`;
  const why = planFits ? `your plan's ${fmt(pick)} works, with ${leftTxt} before it closes at ${o.window.closes}` : `I'd say ${fmt(pick)}, which leaves you ${leftTxt} before it closes at ${o.window.closes}`;
  return { reply: `At ${o.name}${o.day ? ` on ${o.day}` : ""}, ${range}; ${why}.${trip}`, clock: fmt(pick) };
}
