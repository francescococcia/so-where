// "What time do I need to leave?" follow-ups: answered from the TfL Journey Planner (timeIs=Arriving) for the
// plan on screen, which stays unchanged (like "is it open?"). Typo-tolerant ("a what time i need to leave form my hose?").
// The other person's start is only the rounded area centre already in the result; their area is never named.
import { LONDON_CENTER } from "@/lib/areas";
import { addDays, londonToday } from "@/lib/dates";
import { shortDay } from "@/lib/destination";
import { matchPlace } from "@/lib/gazetteer";
import { londonParts, londonToUtc } from "@/lib/london-time";
import type { LatLng, PlanCard, PlanResultWithAgent } from "@/lib/plan-types";
import { journey, type Journey } from "@/lib/tfl";

/** Response field: when to leave so everyone arrives by `arriveBy` on `date` (YYYY-MM-DD). */
export type LeaveBy = { you?: string; them?: string; arriveBy: string; date: string };

const FIX: [RegExp, string][] = [
  [/\bhose\b|\bhouse\b|\bhous\b|\bhom\b/g, "home"],
  [/\bform\b|\bfrm\b|\bfom\b/g, "from"],
  [/\b(?:leve|leav|leae|lave|lv)\b/g, "leave"],
  [/\b(?:wat|wht|waht|whta|wot)\b/g, "what"],
  [/\b(?:tim|tme|tiem)\b/g, "time"],
  [/\b(?:wen|whn|wehn)\b/g, "when"],
  [/\b(?:arive|arrvie|arrve|arrivve)\b/g, "arrive"],
  [/\b(?:shoud|shuold|shld)\b/g, "should"],
  [/\b(?:ned|nead|neeed)\b/g, "need"],
  [/\b(?:tomorow|tommorow|tommorrow|tmrw|tmr|2moro)\b/g, "tomorrow"],
];
export function normLeave(text: string): string {
  let t = ` ${text.toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ")} `;
  for (const [re, to] of FIX) t = t.replace(re, to);
  return t.trim();
}

const GO = "(?:leave|go|set off|set out|depart|head out|head off|get going|start out|get moving)";
/** Is this follow-up asking when to leave / how to arrive on time (and nothing else)? */
export function isLeaveQuestion(text: string): boolean {
  const t = normLeave(text);
  if (t.length > 160) return false;
  return (
    new RegExp(`\\b(?:when|what time|at what time|which time|by when|how early|how soon|what hour)\\b.{0,40}\\b${GO}\\b`).test(t) ||
    new RegExp(`\\b${GO}\\b.{0,30}\\b(?:by )?(?:when|what time)\\b`).test(t) ||
    /\bhow early\b/.test(t) ||
    /\b(?:get|be) there (?:on time|in time)\b/.test(t) ||
    /\b(?:arrive|be there|get there) (?:by|at|for|before)\b/.test(t) ||
    /\bif i (?:want|need|wanna|have) to (?:arrive|be there|get there)\b/.test(t) ||
    /\bwhen should i (?:go|leave)\b/.test(t)
  );
}

/** Arrival clock in the follow-up ("arrive at 11:30", "by 9am"); without am/pm, the reading nearer the plan time. */
export function arrivalClock(text: string, planHHMM: string): string | null {
  const t = normLeave(text);
  const m = /\b(?:at|by|for|before|arrive|there)\s+(\d{1,2})(?:[:.](\d\d))?\s*(am|pm)?\b/.exec(t) ?? /\b(\d{1,2})[:.](\d\d)\s*(am|pm)?\b/.exec(t) ?? /\b(\d{1,2})()\s*(am|pm)\b/.exec(t);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  const ap = m[3];
  if (ap === "pm" && h < 12) h += 12;
  else if (ap === "am" && h === 12) h = 0;
  else if (!ap && h >= 1 && h <= 11) {
    const [ph, pm] = planHHMM.split(":").map(Number);
    const plan = ph * 60 + pm;
    if (Math.abs(h * 60 + 12 * 60 + min - plan) < Math.abs(h * 60 + min - plan)) h += 12;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** A start named in the follow-up ("from Greenwich"); "from home / my place" is not a place. */
export function statedOrigin(text: string): { name: string; location: LatLng } | null {
  const t = normLeave(text);
  const m = /\bfrom (?!home\b|my\b|here\b|the house\b|work\b)([a-z][a-z'&. -]{1,40}?)(?:\s+(?:to|at|by|for|tomorrow|tonight|today)\b|[?.!,]|$)/.exec(t);
  if (!m) return null;
  const g = matchPlace(m[1]);
  return g.best && g.confidence !== "low" ? { name: g.best.entry.name, location: g.best.entry.location } : null;
}

const pronoun = (r: PlanResultWithAgent) => /\b(her|him)\s+\d+\b/.exec(r.headline)?.[1] ?? "them";
const minus = (hhmm: string, mins: number) => {
  const [h, m] = hhmm.split(":").map(Number);
  const x = (((h * 60 + m - mins) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

/** Your route in words: "6 min walk, then DLR from Greenwich to Canary Wharf, then Jubilee line …". */
function route(j: Journey, short = false): string {
  const lines = j.lines.map((l) => l.name).filter(Boolean);
  if (short || !j.lines.length) return lines.length ? `${[...new Set(lines)].join(" and ")}${/line|DLR|Overground|Elizabeth/i.test(lines.join(" ")) ? "" : " line"}` : "on foot";
  const walk = j.segments[0]?.mode === "walking" && j.segments[0].minutes >= 2 ? `${j.segments[0].minutes} min walk, then ` : "";
  return `${walk}${j.summary.replace(/\s*\(direct\)$/, "")}`;
}

export type LeaveDeps = { journey?: typeof journey };
export type LeaveAnswer = { reply: string; leaveBy?: LeaveBy; detail: string };

/**
 * Leave times for the focus/top card of `r`. `you`: the user's start (request, else stated in the follow-up, else the
 * plan's own start). Date: the plan's day, or "tomorrow"/"today" in the follow-up; time: the plan / event start, or
 * "arrive at X". Halfway plans also give the other person's leave time.
 */
export async function leaveTimes(r: PlanResultWithAgent, card: PlanCard, text: string, now: Date, deps: LeaveDeps = {}, you?: LatLng): Promise<LeaveAnswer> {
  const jp = deps.journey ?? journey;
  const t = normLeave(text);
  const plan = londonParts(new Date(r.when));
  const planHHMM = `${String(plan.hh).padStart(2, "0")}:${String(plan.mm).padStart(2, "0")}`;
  const today = londonToday(now);
  const date = /\btomorrow\b/.test(t) ? addDays(today, 1) : /\b(?:today|tonight)\b/.test(t) ? today : plan.date;
  // An event's own start ("When" fact, e.g. "Fri 23 Oct 12:00 – Sun 25 Oct 16:30"): for an event that's on now the plan
  // time is the next slot, but "tomorrow" means getting there for its start.
  const evClock = /\b([01]\d|2[0-3]):[0-5]\d\b/.exec(card.facts.find((f) => f.label === "When")?.value ?? "")?.[0];
  const nowClock = `${String(londonParts(now).hh).padStart(2, "0")}:${String(londonParts(now).mm).padStart(2, "0")}`;
  const target = evClock && (date !== today || evClock > nowClock) ? evClock : planHHMM;
  const arriveBy = arrivalClock(text, target) ?? target;
  const [ah, am] = arriveBy.split(":").map(Number);
  const at = londonToUtc(date, ah, am);
  const day = shortDay(date);
  const stated = statedOrigin(text);
  const planYou = r.cards.some((c) => c.legs.some((l) => l.who === "you")) && !(Math.abs(r.you.lat - LONDON_CENTER.lat) < 1e-4 && Math.abs(r.you.lng - LONDON_CENTER.lng) < 1e-4) ? r.you : null;
  const from = stated?.location ?? you ?? planYou;
  const them = r.intent === "meet_halfway" && r.them ? r.them.center : null;
  if (!from && !them) return { reply: `Where are you leaving from? Say e.g. "from Greenwich" and I'll work out when to leave for ${card.name}.`, detail: "No start known" };
  if (at.getTime() < now.getTime() - 60_000) {
    return { reply: `${arriveBy} on ${day} has already passed, so ask again with a later time (e.g. "arrive at 19:00") or "tomorrow".`, detail: "Arrival time already passed" };
  }
  const [jy, jt] = await Promise.all([from ? jp(from, card.location, at) : null, them ? jp(them, card.location, at) : null]);
  const ok = (j: Awaited<ReturnType<typeof jp>> | null): j is Journey => !!j && !("error" in j);
  const leave = (j: Journey) => (j.leaveAt && j.arriveAt && j.arriveAt <= arriveBy ? j.leaveAt : minus(arriveBy, j.minutes));
  const out: LeaveBy = { arriveBy, date };
  if (ok(jy)) out.you = leave(jy);
  if (ok(jt)) out.them = leave(jt);
  if (!out.you && !out.them) return { reply: `TfL's Journey Planner didn't return a route to ${card.name} for ${arriveBy} on ${day}, so try again in a moment.`, detail: "TfL Journey Planner: no journey" };
  const p = pronoun(r);
  const buffer = "so add a few minutes' buffer.";
  let reply: string;
  if (them) {
    const you1 = ok(jy) ? `You: leave by ${out.you} (${route(jy, true)}, ${jy.minutes} min)` : "You: no TfL route found";
    const them1 = ok(jt) ? `${p}: leave by ${out.them} (${jt.minutes} min)` : `${p}: no TfL route found`;
    reply = `${you1}; ${them1}, to arrive at ${card.name} by ${arriveBy} (${day}), ${buffer}`;
  } else {
    const j = jy as Journey;
    const lead = `Leave by ${out.you}${stated ? ` from ${stated.name}` : ""} to arrive at ${arriveBy} (${day}): `;
    reply = `${lead}${route(j)}, ${j.minutes} min, ${buffer}`;
    if (reply.length > 235) reply = `${lead}${route(j, true)}, ${j.minutes} min, ${buffer}`;
  }
  return { reply, leaveBy: out, detail: `TfL Journey Planner, arriving ${arriveBy} ${day}${out.you ? ` · you leave ${out.you}` : ""}${out.them ? ` · ${p} leaves ${out.them}` : ""}` };
}
