// "So where?" plan pipeline: parse → resolve places → compare hubs → venues/events → line status → weather → verify.
// Every Fact carries a source; anything we couldn't check goes into `unknowns`. The other person's location
// is only ever kept as a ~500 m area, is never logged, and never appears in draftMessage.
import { parsePlanAsk, SOLO_RE, type PlanAsk } from "@/lib/ask-local";
import { LONDON_CENTER } from "@/lib/areas";
import { isLeaveQuestion, leaveTimes, type LeaveBy } from "@/lib/leave-time";
import { londonToday } from "@/lib/dates";
import { seedEventsOn, type SeedEvent } from "@/lib/events";
import { GAZETTEER_AS_OF, GAZETTEER_SOURCE, matchPlace, normPlace } from "@/lib/gazetteer";
import { geminiFill } from "@/lib/gemini-intent";
import { metresBetween, roundToArea, walkMinutes } from "@/lib/geo";
import { londonClock, londonDayShort, londonLabel, londonParts, londonToUtc } from "@/lib/london-time";
import { addressOf, hoursAt, kindLabel, osmUrl, type OsmKind, type OsmPlace, type OsmResult } from "@/lib/osm";
import { findVenues, mongoEventsNear } from "@/lib/mongo-venues";
import { recordPlanRun, tieBreakByHistory } from "@/lib/plan-memory";
import type { AgentStep, Clarify, Fact, LatLng, Leg, PlanCard, PlanResultWithAgent, Verdict } from "@/lib/plan-types";
import { fairPoint, HUBS, journey, lineStatus, searchPlace, tidySegments, trimPathStart, trimSegmentsStart, type Journey, type LegSegment, type LineStatus, type Place } from "@/lib/tfl";
import { forecastAt, type Forecast } from "@/lib/weather";
import { weatherDecision, weatherFitFact, weatherMode, weatherRank, type WeatherMode } from "@/lib/venue-weather";
import { applyRefinements, clock12, cuisineLabel, cuisineMatch, cuisineOf, joinRefine, pickHub, prefRank, refineReply, seatingWish, splitRefine, type Pref, type RefinedAsk, type Refinement } from "@/lib/refine";
import { goDraft, meetDraft, nearDraft } from "@/lib/draft-message";
import { eventDates, parseDestination, resolveDestination, shortDay, type Destination } from "@/lib/destination";
import type { Blurb } from "@/lib/blurb";
import { mentionsArea, sameArea, scrubArea, venueArea } from "@/lib/venue-area";
import { STEP_FREE_ASK, verifyPicks, type PlanResultVerified } from "@/lib/verify";

export type PlanRequest = { query: string; you?: LatLng; when?: string; previous?: { query: string; answer: string; /** Refine only: the result on screen, so "is it open?" answers without replanning. Echoed, never stored. */ result?: PlanResultWithAgent }; refine?: string;
  /** Refine only: the place the user has selected (a card), so "other Italian places in the area" searches around it and excludes it. Never stored. */
  focus?: PlanFocus };
export type PlanFocus = { id?: string; name?: string; lat: number; lng: number };
/** Result plus the follow-up chat fields (plan-types.ts stays unchanged): `reply` is one plain sentence about
 * what a refinement changed; `query` (already on PlanResult) is the accumulated ask to send back next turn. */
export type PlanResultRefined = PlanResultWithAgent & { reply?: string; /** "When do I leave?" follow-ups only (see leave-time.ts). */ leaveBy?: LeaveBy };
export type StepSink = (step: AgentStep) => void;

const MAX_CARDS = 3;
/** Options built as cards before the verification loop picks the final MAX_CARDS (verify.ts). */
const POOL = 6;
/** Leg plus the optional per-stretch `segments` the UI's journey.tsx reads (plan-types.ts stays unchanged). */
type LegWithSegments = Leg & { segments?: LegSegment[] };
const walkOn = (segs: LegSegment[], from: { name: string; location: LatLng }, to: { name: string; location: LatLng }, minutes: number): LegSegment[] =>
  segs.length ? [...segs, { mode: "walking", from: from.name, to: to.name, minutes, path: [from.location, to.location], est: true }] : segs;
const ME_SUGGESTIONS = ["Old Street", "King's Cross", "London Bridge"];
const THEM_SUGGESTIONS = ["Clapham", "Brixton", "Stratford"];

const fact = (label: string, value: string, verdict: Verdict, source: string, asOf?: string): Fact => ({ label, value, verdict, source, ...(asOf ? { asOf } : {}) });
const validLatLng = (p: unknown): p is LatLng =>
  !!p && typeof p === "object" && Number.isFinite((p as LatLng).lat) && Number.isFinite((p as LatLng).lng) && Math.abs((p as LatLng).lat) <= 90 && Math.abs((p as LatLng).lng) <= 180;

const RUN_STARTED = new WeakMap<AgentStep[], number>(); // steps array → run start, for plan_runs latency

function stepper(emit?: StepSink) {
  const steps: AgentStep[] = [];
  RUN_STARTED.set(steps, Date.now());
  const begin = (id: string, label: string, source?: string) => {
    const s: AgentStep = { id, label, status: "running", ...(source ? { source } : {}) };
    steps.push(s);
    emit?.({ ...s });
    const t0 = Date.now();
    return (status: AgentStep["status"], detail?: string, source?: string) => {
      s.status = status;
      if (detail) s.detail = detail;
      if (source) s.source = source;
      s.ms = Date.now() - t0;
      emit?.({ ...s });
    };
  };
  return { steps, begin };
}

type Resolved = { place: Place | null; readAs: string | null; suggestions: string[]; confidence: "high" | "medium" | "low" };

/** Typed place → station. Local gazetteer first (instant, typo-tolerant); TfL search only when it has no
 *  idea; a middle-band guess is never used silently: the caller asks with the closest real stations. */
async function resolveTyped(typed: string): Promise<Resolved> {
  const g = matchPlace(typed);
  const suggestions = g.top.map((m) => m.entry.name);
  if (g.confidence === "high" && g.best) {
    const e = g.best.entry;
    const place: Place = { query: typed, name: e.name, id: e.id, location: e.location, modes: e.modes, source: GAZETTEER_SOURCE, asOf: GAZETTEER_AS_OF };
    return { place, readAs: normPlace(typed) === normPlace(e.name) ? null : e.name, suggestions, confidence: "high" };
  }
  if (g.confidence === "medium") return { place: null, readAs: null, suggestions, confidence: "medium" };
  const t = await searchPlace(typed);
  return { place: t.place, readAs: null, suggestions, confidence: "low" };
}

/** "Get me to <venue> …": the rest of the ask (day, time, who / where) parsed as a near-me or halfway plan. */
function destModeAsk(dest: Destination, today: string): PlanAsk {
  // "… from Old Street tomorrow" → your start.
  const rest = (dest.rest || "").replace(/^\s*from\s+(.+?)(?=\s+(?:on|at|by|for|around|tomorrow|tonight|today|this|next)\b|\s*[,;.!?]|$)/i, "i'm at $1");
  const d = parsePlanAsk(rest, today);
  const halfway = dest.withThem || !!d.themPlace;
  return { ...d, intent: halfway ? "meet_halfway" : "near_me", category: dest.title ? "event" : d.category, free: d.free || dest.free, signals: [`fixed destination (${dest.title ? "event" : "place"})`, ...d.signals] };
}

/** Which slot the next clarify answer fills: mirrors the clarify order in runPlan. */
async function pendingSlot(base: PlanAsk, reqYou: LatLng | undefined): Promise<"them" | "you" | null> {
  const unresolved = async (p: string | null) => !!p && !(await resolveTyped(p)).place;
  if (base.intent === "meet_halfway") {
    if (!base.themPlace || (await unresolved(base.themPlace))) return "them";
    if (await unresolved(base.youPlace)) return "you";
    return !base.youPlace && !reqYou ? "you" : null;
  }
  if (base.youPlace) return !reqYou && (await unresolved(base.youPlace)) ? "you" : null;
  return reqYou ? null : "you";
}

/** Merge a clarify answer cumulatively: `prevQuery` already carries every earlier answer as "; them: X" /
 *  "; you: Y" tokens, and this answer is appended for the slot still missing. The merged text is returned
 *  as the result's `query`, so resending it with the next answer never loses an earlier one. */
async function mergeAnswer(prevQuery: string, answer: string, today: string, reqYou: LatLng | undefined): Promise<{ ask: PlanAsk; text: string }> {
  const a = answer.replace(/[;]/g, ",").trim().replace(/[.!?]+$/, "");
  // A fixed-destination ask ("Get me to X at Y …") has no intent of its own: its answer is still your start
  // (or theirs), so read it the same way runPlan does.
  const pd = parseDestination(splitRefine(prevQuery).base);
  const base = pd ? destModeAsk(pd, today) : parsePlanAsk(prevQuery, today);
  const slot = base.intent ? await pendingSlot(base, reqYou) : null;
  if (!slot) {
    const text = `${prevQuery}. ${a}`;
    return { ask: parsePlanAsk(text, today), text };
  }
  if (slot === "them" && SOLO_RE.test(a)) {
    // "i'm solo" / "just me" answers the who-else question: no other person, so it becomes a solo plan.
    const text = `${prevQuery}; just me`;
    const ask = parsePlanAsk(text, today);
    ask.signals.push("answer merged");
    return { ask, text };
  }
  const fromAnswer = parsePlanAsk(a, today);
  const value = slot === "them" ? (fromAnswer.themPlace ?? fromAnswer.youPlace ?? a) : (fromAnswer.youPlace ?? a);
  const text = `${prevQuery}; ${slot}: ${value}`;
  const ask = parsePlanAsk(text, today);
  ask.signals.push("answer merged");
  ask.date ??= fromAnswer.date;
  ask.time ??= fromAnswer.time;
  ask.category ??= fromAnswer.category;
  return { ask, text };
}

/** "is he" / "is she" / "is Priya" / "are they" for clarify questions. */
const nearestPhrase = (who: string) => (who === "them" ? "are they" : who === "her" ? "is she" : who === "him" ? "is he" : `is ${who}`);

/** Next sensible start: now + 15 min, rounded up to the quarter hour (21:58 → 22:15, 23:20 → 23:45). */
export const nextSlot = (now: Date) => new Date(Math.ceil((now.getTime() + 15 * 60_000) / 900_000) * 900_000);

function planTime(ask: PlanAsk, reqWhen: string | undefined, now: Date, unknowns: string[]) {
  const today = londonToday(now);
  const given = reqWhen && Number.isFinite(Date.parse(reqWhen)) ? new Date(reqWhen) : null;
  const gp = given ? londonParts(given) : null;
  const date = ask.date ?? gp?.date ?? today;
  const time = ask.time ?? (gp && !ask.date ? `${String(gp.hh).padStart(2, "0")}:${String(gp.mm).padStart(2, "0")}` : null);
  const slot = nextSlot(now);
  const slotClock = clock12(londonParts(slot).hh, londonParts(slot).mm);
  if (!time) {
    if (date === today) {
      unknowns.push(`No time given, so this is planned for about now (${slotClock}).`);
      return slot;
    }
    unknowns.push("No time given, so this is planned for midday.");
    return londonToUtc(date, 12, 0);
  }
  const [hh, mm] = time.split(":").map(Number);
  const at = londonToUtc(date, hh, mm);
  // Already past today (London): never plan in the past.
  if (date !== today || at.getTime() >= now.getTime()) return at;
  const asked = clock12(hh, mm);
  const clock = !!ask.time && ask.timeKind !== "word"; // the user typed a clock time (or Gemini filled one)
  // "at 7" with no day, typed at 22:00 → tomorrow at 7; a day word ("tonight", "today", "Friday") or a time
  // just gone (≤ 1 h) means they still want today, so take the next slot.
  if (clock && !ask.date && now.getTime() - at.getTime() > 3600_000) {
    const tomorrow = londonToday(new Date(at.getTime() + 26 * 3600_000));
    unknowns.push(`${asked} has already gone today, so this is planned for tomorrow at ${asked}.`);
    return londonToUtc(tomorrow, hh, mm);
  }
  // "Saturday 3pm" typed late on Saturday → next Saturday (a weekday name, not "today"/"tonight").
  if (clock && ask.dayPhrase?.startsWith("on ") && now.getTime() - at.getTime() > 3600_000) {
    const next = londonToday(new Date(at.getTime() + (7 * 24 + 2) * 3600_000));
    unknowns.push(`${asked} today has already gone, so this is planned for next ${londonDayShort(at)} at ${asked}.`);
    return londonToUtc(next, hh, mm);
  }
  unknowns.push(clock ? `${asked} has already passed, so this is planned for ${slotClock}, the next slot.` : `It's already past ${asked}, so this is planned for about now (${slotClock}).`);
  return slot;
}

type Sources = Map<string, string>;
const addSource = (s: Sources, name: string, asOf?: string) => {
  if (!asOf) return;
  const prev = s.get(name);
  if (!prev || prev < asOf) s.set(name, asOf);
};

function lineFacts(ids: string[], ls: Awaited<ReturnType<typeof lineStatus>> | null): Fact[] {
  if (!ids.length) return [];
  if (!ls || "error" in ls) return [fact("Lines", "Line status unavailable right now", "unknown", "TfL")];
  const used = ls.lines.filter((l) => ids.includes(l.id));
  if (!used.length) return [];
  const text = used.map((l: LineStatus) => `${l.name}: ${l.status}${l.reason && l.severity < 10 ? ` (${l.reason.slice(0, 80)})` : ""}`).join(" · ");
  return [fact("Lines", `${text} · now, as of ${londonClock(ls.fetchedAt)}`, "confirmed", "TfL", ls.fetchedAt)];
}

function weatherFact(w: Forecast | { error: string } | null, at: Date): Fact {
  if (!w || "error" in w) return fact("Weather", `No forecast for ${londonLabel(at)} (${w && "error" in w ? w.error : "not checked"})`, "unknown", "Open-Meteo");
  return fact("Weather", `${londonLabel(at)}: ${w.value}`, "forecast", "Open-Meteo", w.fetchedAt);
}

/** Open at the plan time but shut within the hour (OSM): dropped unless nothing else is open, then flagged and ranked last. */
type Hrs = ReturnType<typeof hoursAt> & { soon?: boolean };
function closingSoon(h: ReturnType<typeof hoursAt>): Hrs {
  if (h.state !== "open" || h.closesInMin == null) return h;
  return h.closesInMin < 60 ? { ...h, value: `${h.value} · closes within the hour`, soon: true } : h;
}
const soon = (h: Hrs) => (h.soon ? 1 : 0);
/** Per-card opening-hours fields for the UI (intersection type: plan-types.ts is unchanged). */
export type CardHours = { openAtPlan: boolean | null; closesAt: string | null; closingSoon: boolean; hoursKnown: boolean };
/** `area`: the venue's own neighbourhood / nearest station ("South Bank · near Waterloo").
 *  `blurb`: a short description from Wikipedia / Wikidata / OSM / the venue's site (see blurb.ts), when ready. */
export type PlanCardWithHours = PlanCard & CardHours & { area?: string; blurb?: Blurb };
const cardHours = (h: Hrs): CardHours => ({ openAtPlan: h.state === "unknown" ? null : h.state === "open", closesAt: h.closesAt ?? null, closingSoon: !!h.soon, hoursKnown: h.state !== "unknown" });
/** Open places, minus the ones shutting within the hour (kept only when nothing else is open). */
function openEnough<T extends { h: Hrs }>(rows: T[]): { keep: T[]; soonDropped: number } {
  const open = rows.filter((r) => r.h.state !== "closed");
  const solid = open.filter((r) => !r.h.soon);
  return solid.length ? { keep: solid, soonDropped: open.length - solid.length } : { keep: open, soonDropped: 0 };
}
/** Events: "open" means not yet over; closesAt is the listed end. */
const eventHours = (e: { start: string; end?: string | null }, at: Date): CardHours => {
  const end = e.end ? Date.parse(e.end) : NaN;
  if (Number.isNaN(end)) return { openAtPlan: null, closesAt: null, closingSoon: false, hoursKnown: false };
  return { openAtPlan: end > at.getTime(), closesAt: londonClock(e.end!), closingSoon: end - at.getTime() < 60 * 60_000, hoursKnown: true };
};
/** "Cuisine" fact when a cuisine was asked for: tagged, name-only, or no match (OSM). */
function cuisineFact(tags: Record<string, string>, key: string | undefined, r: OsmResult) {
  if (!key) return [];
  const m = cuisineMatch(tags, key);
  const lbl = cuisineLabel(key);
  return [fact("Cuisine", m === "tag" ? `${lbl} (OSM cuisine${tags.cuisine ? `=${tags.cuisine}` : ` / diet:${key}`})` : m === "name" ? `${lbl}, going by the name (no cuisine tag)` : tags.cuisine ? `Not ${lbl} (OSM cuisine=${tags.cuisine})` : `Not tagged ${lbl} in OSM`, m === "tag" ? "confirmed" : m === "name" ? "likely" : "unknown", r.source, r.asOf)];
}
const untilWhy = (h: Hrs) => (h.closesAt ? `, open until ${h.closesAt}` : h.state === "open" ? ", open at that time" : ", hours not listed");

/** Coffee late at night: few cafés are open, so when none is known to be open for the next hour,
 *  bars / pubs that are open late join the pool (and the caller says so). */
async function findOpenVenues(kind: OsmKind, centerIn: LatLng, radiusM: number, at: Date, ra?: RefinedAsk): Promise<OsmResult & { lateBars?: boolean }> {
  const cuisine = ra?.cuisine;
  const focus = ra?.focus;
  const center = focus ? { lat: focus.lat, lng: focus.lng } : centerIn;
  // "Other … in the area": around the selected place, without it.
  const notFocus = (p: OsmPlace) => !focus || !((focus.id && (focus.id === `osm-${p.type}-${p.id}` || focus.id === `${p.type}/${p.id}` || focus.id === String(p.id))) || (focus.name && same(p.tags.name, focus.name)));
  const raw = await findVenues(kind, center, radiusM);
  let r = { ...raw, places: raw.places.filter(notFocus) };
  // "Any Italian one?" for a café / pub with none tagged nearby: matching restaurants join the pool.
  if (cuisine && kind !== "restaurant" && !r.places.some((p) => cuisineMatch(p.tags, cuisine))) {
    const more = (await findVenues("restaurant", center, radiusM)).places.filter((p) => notFocus(p) && cuisineMatch(p.tags, cuisine));
    if (more.length) r = { ...r, places: [...r.places, ...more] };
  }
  if (kind !== "cafe") return r;
  const ok = r.places.some((p) => { const h = hoursAt(p.tags, at, p.location); return h.state === "open" && (h.closesInMin == null || h.closesInMin >= 60); });
  if (ok) return r;
  const bars = await findVenues("pub", center, radiusM);
  const seen = new Set(r.places.map((p) => `${p.type}${p.id}`));
  const extra = bars.places.filter((p) => notFocus(p) && !seen.has(`${p.type}${p.id}`) && hoursAt(p.tags, at, p.location).state === "open");
  return extra.length ? { ...r, places: [...r.places, ...extra], lateBars: true } : r;
}

function venuePick(res: OsmResult, at: Date, wm?: WeatherMode, prefs?: Pref[], cuisine?: string) {
  const rank = { confirmed: 0, likely: 1, forecast: 2, unknown: 3 } as const;
  const rows = res.places.map((p) => ({ p, h: closingSoon(hoursAt(p.tags, at, p.location)) }));
  const closed = rows.filter((r) => r.h.state === "closed").length;
  const { keep: open, soonDropped } = openEnough(rows);
  // Weather fit first (indoor when wet, terrace when warm; OSM seating tags), then hours confidence, then distance.
  const wr = (p: OsmPlace) => (wm ? weatherRank(p.tags, wm) : 0);
  // Follow-up wishes (cheaper / quieter / terrace / indoor) come first when the user asked for them.
  const pr = (p: OsmPlace) => prefRank(p.tags, prefs);
  // A cuisine wish ("any Italian?") puts tagged matches first, then name matches.
  const cu = (p: OsmPlace) => (cuisine ? { tag: 0, name: 1, none: 2 }[cuisineMatch(p.tags, cuisine) ?? "none"] : 0);
  const keep = open.sort((a, b) => cu(a.p) - cu(b.p) || pr(a.p) - pr(b.p) || wr(a.p) - wr(b.p) || soon(a.h) - soon(b.h) || rank[a.h.verdict] - rank[b.h.verdict] || a.p.distanceM - b.p.distanceM);
  // With ≥1 cuisine match, cards are only the matches; non-matches fill in only when there are none (the reply says so).
  const hits = cuisine ? keep.filter((x) => cuisineMatch(x.p.tags, cuisine)) : [];
  return { picks: (hits.length ? hits : keep).slice(0, MAX_CARDS), pool: (hits.length ? hits : keep).slice(0, POOL), total: rows.length, closed, soonDropped };
}

/** Weather-fit fact for a venue card (empty when the forecast doesn't change the choice). */
function fitFact(tags: Record<string, string>, wm: WeatherMode, osm: OsmResult, wx: Forecast | { error: string }): Fact[] {
  const f = weatherFitFact(tags, wm, osm.source, osm.asOf, "error" in wx ? "" : wx.fetchedAt);
  return f ? [f] : [];
}

function stepFree(tags: Record<string, string>, asOf: string, src: string): Fact {
  const w = tags.wheelchair;
  if (w === "yes") return fact("Step-free", "Wheelchair access: yes (OSM tag)", "likely", src, asOf);
  if (w === "limited") return fact("Step-free", "Wheelchair access: limited (OSM tag)", "likely", src, asOf);
  if (w === "no") return fact("Step-free", "Wheelchair access: no (OSM tag)", "likely", src, asOf);
  return fact("Step-free", "Not tagged in OSM", "unknown", src);
}

/** Seating fact when the user asked for a terrace / indoors in a follow-up. */
function seatFact(tags: Record<string, string>, prefs: Pref[] | undefined, osm: OsmResult): Fact[] {
  const w = seatingWish(tags, prefs);
  return w ? [fact(w.label, w.value, w.ok || /^No\b/.test(w.value) ? "likely" : "unknown", osm.source, osm.asOf)] : [];
}

function emptyResult(query: string, when: Date, you: LatLng | undefined, steps: AgentStep[], unknowns: string[]): PlanResultWithAgent {
  return {
    intent: "near_me",
    query,
    headline: "",
    when: when.toISOString(),
    you: you ?? { lat: LONDON_CENTER.lat, lng: LONDON_CENTER.lng },
    filters: {},
    cards: [],
    unknowns,
    sources: [],
    draftMessage: "",
    steps,
  };
}

const FOCUS_RE = /\b(?:in|around) (?:the|this|that) area\b|\bnearby\b|\bnear (?:it|there|that|here|this)\b|\baround (?:there|here)\b|\bclose to (?:it|that|there)\b|\bother\b|\belse\b|\bsimilar\b|\banother\b/i;
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase().trim() === b.toLowerCase().trim();
type RefineRun = { refinement: Refinement; prefs: Pref[]; hubWhy?: string; hubName?: string; cuisine?: string; focusName?: string };
const hoursOfCard = (c: PlanCard) => { const h = c as Partial<CardHours>; return { closesAt: h.closesAt ?? null, hoursKnown: h.hoursKnown, openAtPlan: h.openAtPlan ?? null }; };
const REFINE_RUNS = new WeakMap<AgentStep[], RefineRun>(); // steps array → refinement info for the reply

/** runPlan + follow-up `reply` when the ask carries refinements (mode "refine", or an accumulated query). */
/** Evals only: pin "now" (London clock) so past-time rules can be tested. Never set in the app. */
let CLOCK: (() => Date) | null = null;
export function setClockOverride(f: (() => Date) | null) {
  CLOCK = f;
}

/** "Is it open? / when does it close?" with nothing else to change: answered from the selected card's hours. */
function openQuestionOnly(req: PlanRequest, today: string): boolean {
  if (req.refine === undefined || !req.previous?.query) return false;
  const base = splitRefine(req.previous.query).base;
  const { refinement } = applyRefinements(parsePlanAsk(base, today), [req.refine], today);
  return refinement.latest.asks.includes("open") && !refinement.latest.changes.length && !refinement.latest.prefs.length;
}
/** Hours of a card: the CardHours fields, else read back from its "Open <Day>" fact. */
function cardOpen(c: PlanCard): { known: boolean; open: boolean | null; until: string | null } {
  const h = c as Partial<CardHours>;
  if (h.hoursKnown !== undefined) return { known: h.hoursKnown, open: h.openAtPlan ?? null, until: h.closesAt ?? null };
  const f = c.facts.find((x) => /^open\b/i.test(x.label))?.value ?? "";
  if (/^Open 24 hours/.test(f)) return { known: true, open: true, until: null };
  const u = /^Open until (\d\d:\d\d)/.exec(f);
  if (u) return { known: true, open: true, until: u[1] };
  if (/^Closed/.test(f)) return { known: true, open: false, until: null };
  return { known: false, open: null, until: null };
}

export async function runPlan(req: PlanRequest, emit?: StepSink, now = CLOCK ? CLOCK() : new Date()): Promise<PlanResultRefined> {
  if (req.refine && req.previous && isLeaveQuestion(req.refine)) {
    // "What time do I need to leave?": same plan (replanned from the base ask if the UI didn't echo it), plus leave times.
    const base: PlanResultRefined = req.previous.result?.cards?.length ? req.previous.result : await runPlanCore({ query: req.previous.query, you: req.you, when: req.when }, emit, now);
    const card = base.cards.length ? (req.focus && base.cards.find((c) => c.id === req.focus!.id || c.name === req.focus!.name)) || base.cards[0] : null;
    const t0 = Date.now();
    const a = card ? await leaveTimes(base, card, req.refine, now, {}, req.you) : { reply: base.clarify?.question ?? "There's no place on the plan yet, so ask for one first and I'll work out when to leave.", detail: "No card" };
    const step: AgentStep = { id: "refine", label: "Working out when to leave", status: "done", detail: `${a.detail} · plan unchanged`, source: "TfL", ms: Date.now() - t0 };
    emit?.(step);
    return { ...base, query: joinRefine(req.previous.query, req.refine), steps: [...(base.steps ?? []), step], reply: a.reply, ...("leaveBy" in a && a.leaveBy ? { leaveBy: a.leaveBy } : {}) };
  }
  const prev = req.previous?.result;
  const askOpen = !!prev?.cards?.length && openQuestionOnly(req, londonToday(now));
  if (askOpen && prev) {
    const card = (req.focus && prev.cards.find((c) => c.id === req.focus!.id || c.name === req.focus!.name)) || prev.cards[0];
    const o = cardOpen(card);
    const p = londonParts(new Date(prev.when));
    const clock = clock12(p.hh, p.mm);
    if (o.open !== false) {
      // Same plan, same cards: no replanning, no new middle.
      const step: AgentStep = { id: "refine", label: "Checking opening hours", status: "done", detail: `Answered from ${card.name}'s OSM opening_hours · plan unchanged`, source: "OSM", ms: 0 };
      emit?.(step);
      const reply = !o.known ? `No hours listed for ${card.name}.` : o.until ? `${card.name} is open until ${o.until}.` : `${card.name} is open at ${clock}.`;
      return { ...prev, query: joinRefine(req.previous!.query, req.refine!), steps: [...(prev.steps ?? []), step], reply };
    }
    // Closed then: replan (closed venues are dropped) and say so.
    const r: PlanResultRefined = await runPlanCore(req, emit, now);
    r.reply = r.cards.length ? `${card.name} looks closed at ${clock}, so here are open options: ${r.cards.map((c) => c.name).join(", ")}.` : `${card.name} looks closed at ${clock} and nothing else open came up.`;
    return r;
  }
  const r: PlanResultRefined = await runPlanCore(req, emit, now);
  const rr = REFINE_RUNS.get(r.steps);
  const goRefine = !rr && req.refine ? parseDestination(req.refine) : null;
  if (goRefine && !r.clarify) {
    // "Meet at <place>" / "get me to <place>" as a follow-up: the plan now goes there (splitRefine made it the base).
    const c = r.cards[0];
    const mins = (w: "you" | "them") => c?.legs.find((l) => l.who === w)?.minutes;
    r.reply = c ? `Switched the plan to ${c.name}${mins("you") !== undefined ? `: ${mins("you")} min for you${mins("them") !== undefined ? `, ${mins("them")} for them` : ""}` : ""}.` : `Couldn't find ${goRefine.venue}, so try its full name or street.`;
  }
  if (!rr) return r;
  const p = londonParts(new Date(r.when));
  const top = r.cards[0];
  const seat = top?.facts.find((f) => f.label === "Outdoor seating" || f.label === "Indoor seating");
  let reply = refineReply({
    refinement: rr.refinement,
    prefs: rr.prefs,
    whenLabel: { day: londonDayShort(new Date(r.when)), clock: clock12(p.hh, p.mm), dateChanged: false },
    category: r.filters.category,
    who: r.headline.match(/, (her|him|them|[A-Z][a-z]+) \d+\.$/)?.[1] ?? "them",
    top: top ? { name: top.name, seating: seat ? { ok: seat.verdict !== "unknown" && !/^No\b|Not tagged/.test(seat.value) } : null, ...hoursOfCard(top) } : undefined,
    ...(rr.focusName ? { near: rr.focusName } : {}),
    cuisine: rr.cuisine ? { key: rr.cuisine, matches: r.cards.filter((c) => c.facts.some((f) => f.label === "Cuisine" && f.verdict !== "unknown")).map((c) => c.name) } : undefined,
    hubName: rr.hubName,
    hubWhy: rr.hubWhy,
    clarify: r.clarify?.question,
    maxMinutes: r.filters.maxMinutes,
    intent: r.intent,
  });
  if (r.them && reply.toLowerCase().includes(r.them.area.toLowerCase())) reply = reply.split(r.them.area).join("their side");
  r.reply = reply;
  // Headline follows a cuisine refine: "2 Italian cafés near The Roasting Plant: …".
  const hits = rr.cuisine ? r.cards.filter((c) => c.facts.some((f) => f.label === "Cuisine" && f.verdict !== "unknown")).length : 0;
  if (hits) {
    const cat = r.filters.category;
    const kinds = cat === "cafe" ? "cafés" : cat === "pub" ? "pubs and bars" : cat === "restaurant" ? "restaurants" : "places";
    const one = cat === "cafe" ? "café" : cat === "pub" ? "pub or bar" : cat === "restaurant" ? "restaurant" : "place";
    const near = rr.focusName ?? (r.intent === "meet_halfway" ? r.middle?.name : undefined);
    const lead = `${hits} ${cuisineLabel(rr.cuisine!)} ${hits > 1 ? kinds : one}`;
    r.headline = r.intent === "meet_halfway"
      ? r.headline.replace(/^[^:]+:/, `${lead} near ${near}:`)
      : r.headline.replace(/^\d+ [\w-]+ within (\d+ min) of ([^,]+)/, (_m, mins: string, of: string) => (near ? `${lead} near ${near}, within ${mins} of ${of}` : `${lead} within ${mins} of ${of}`));
  }
  return r;
}

async function runPlanCore(req: PlanRequest, emit?: StepSink, now = new Date()): Promise<PlanResultWithAgent> {
  const { steps, begin } = stepper(emit);
  const today = londonToday(now);
  const unknowns: string[] = [];
  const sources: Sources = new Map();
  const reqYou = validLatLng(req.you) ? req.you : undefined;

  // 1. Parse
  const endParse = begin("parse", "Reading your ask", "rules");
  // Follow-up chat: {mode:"refine", query: <refinement>, previous:{query}} → "<previous>; refine: <refinement>".
  const refineText = req.refine !== undefined && req.previous?.query ? joinRefine(req.previous.query, req.refine) : null;
  const merged = !refineText && req.previous?.query ? await mergeAnswer(req.previous.query, req.previous.answer || req.query, today, reqYou) : null;
  const text = (refineText ?? merged?.text ?? String(req.query ?? "")).slice(0, 1500);
  const split = splitRefine(text);
  let ask = split.refinements.length ? parsePlanAsk(split.base, today) : (merged?.ask ?? parsePlanAsk(text, today));
  let parseSource = "rules";
  // "Get me to <title> at <venue>, <address> on Sat 31 Oct at 19:00": the destination is fixed (no hub search).
  const dest = parseDestination(split.base);
  if (dest) {
    ask = destModeAsk(dest, today);
    // The event's own day(s): past → plan the trip for now and say it's over; multi-day and on → today.
    const ev = eventDates(dest.rest || "", today, londonClock(now.toISOString()), dest.endTime);
    if (ev) {
      dest.dates = { ...ev, startTime: ask.time };
      if (ev.status === "past") Object.assign(ask, { date: null, time: null });
      else if (ev.status === "ongoing") Object.assign(ask, { date: today, time: ask.time && ask.time > londonClock(now.toISOString()) ? ask.time : null });
      else ask.date = ev.start;
      ask.signals.push(`event ${ev.status}${ev.end ? ` (${ev.start}→${ev.end})` : ` (${ev.start})`}`);
    }
  }
  if (!dest && process.env.GEMINI_API_KEY && (!ask.intent || (ask.intent === "meet_halfway" && (!ask.themPlace || !ask.youPlace)) || !ask.category)) {
    const g = await geminiFill(split.base, ask, today);
    if (g.used && g.filled.length) {
      ask = g.ask;
      parseSource = "rules + Gemini";
    }
  }
  const baseCuisine = cuisineOf(split.base);
  if (baseCuisine) {
    (ask as RefinedAsk).cuisine = baseCuisine;
    ask.category ??= "restaurant";
  }
  const rf = split.refinements.length ? applyRefinements(ask, split.refinements, today) : null;
  if (rf) {
    ask = rf.ask;
    // A selected place + "other / in the area / nearby" (or a cuisine ask): search around that place, excluding it,
    // instead of moving to another middle.
    const f = req.focus;
    if (f && validLatLng(f) && (FOCUS_RE.test(req.refine ?? "") || rf.refinement.latest.changes.includes("cuisine"))) {
      (ask as RefinedAsk).focus = f;
      (ask as RefinedAsk).prefs = (ask as RefinedAsk).prefs?.filter((p) => p !== "different");
    }
    REFINE_RUNS.set(steps, { refinement: rf.refinement, prefs: rf.refinement.prefs, cuisine: rf.ask.cuisine, focusName: (ask as RefinedAsk).focus?.name });

  }
  endParse("done", `${ask.intent ?? "no intent"} · ${ask.signals.join(" · ") || "nothing recognised"} (${parseSource})`);

  const planned = planTime(ask, req.when, now, unknowns);
  const when = rf?.refinement.shiftMin ? new Date(planned.getTime() + rf.refinement.shiftMin * 60_000) : planned;
  const base = emptyResult(text, when, reqYou, steps, unknowns);
  base.filters = {
    ...(ask.walkIn ? { walkIn: true } : {}),
    ...(ask.free ? { free: true } : {}),
    ...(ask.budgetGBP ? { budgetGBP: ask.budgetGBP } : {}),
    ...(ask.category ? { category: ask.category } : {}),
    maxMinutes: ask.maxMinutes ?? 30,
  };

  const clarify = (c: Clarify, intent = ask.intent ?? "near_me"): PlanResultWithAgent => {
    const v = begin("verify", "Verifying claims");
    v("skipped", "Nothing to verify: waiting for your answer");
    return { ...base, intent, headline: c.question, clarify: c, unknowns: [] };
  };

  if (!ask.intent) {
    return clarify({
      question: "What are you planning: meeting someone halfway, or something to do near you?",
      missing: "category",
      suggestions: ["Meet a friend halfway", "What's on near me", "Coffee near me"],
    });
  }

  // 2. Resolve places
  const endResolve = begin("resolve", "Finding the places you named", "TfL station list + StopPoint");
  const named = [ask.youPlace, ask.intent === "meet_halfway" ? ask.themPlace : null];
  const [youR, themR] = await Promise.all(named.map((n) => (n ? resolveTyped(n) : Promise.resolve(null))));
  const readAs = [youR, themR].flatMap((r, i) => (r?.readAs ? [`Read "${named[i]}" as ${r.readAs}`] : []));
  const youPlace: Place | null = youR?.place ?? null;
  const themPlace: Place | null = themR?.place ?? null;
  for (const p of [youPlace, themPlace]) if (p) addSource(sources, p.source, p.asOf);
  const resolvedCount = [youPlace, themPlace].filter(Boolean).length;
  const namedCount = named.filter(Boolean).length;
  endResolve(namedCount ? "done" : "skipped", namedCount ? `${resolvedCount} of ${namedCount} place${namedCount > 1 ? "s" : ""} found${readAs.length ? ` · ${readAs.join(" · ")}` : ""}${youPlace ? ` · you: ${youPlace.name}` : ""}${themPlace ? " · their area rounded to ~500 m" : ""}` : "No places named; using your location");

  const who = ask.themWho;
  if (ask.intent === "meet_halfway") {
    if (ask.themPlace && !themPlace)
      return clarify({ question: `${themR?.confidence === "medium" ? `Not sure which "${ask.themPlace}" you mean.` : `I couldn't find "${ask.themPlace}" on TfL.`} Which station ${nearestPhrase(who)} nearest?`, missing: "them_location", suggestions: themR?.suggestions.length ? themR.suggestions : THEM_SUGGESTIONS });
    if (!ask.themPlace) return clarify({ question: `Where's ${who === "them" ? "the other person" : who === "her" ? "she" : who === "him" ? "he" : who} coming from?`, missing: "them_location", suggestions: THEM_SUGGESTIONS });
    if (ask.youPlace && !youPlace) return clarify({ question: `${youR?.confidence === "medium" ? `Not sure which "${ask.youPlace}" you mean.` : `I couldn't find "${ask.youPlace}" on TfL.`} Which station are you nearest?`, missing: "my_location", suggestions: youR?.suggestions.length ? youR.suggestions : ME_SUGGESTIONS });
    if (!youPlace && !reqYou) return clarify({ question: "Where are you starting from?", missing: "my_location", suggestions: ME_SUGGESTIONS });
    if (dest) return goTo({ ask, text, when, base, begin, unknowns, sources, dest, you: youPlace ? { ...youPlace.location, id: youPlace.id ?? undefined } : reqYou!, youName: youPlace?.name ?? "your location", them: themPlace!, themTyped: ask.themApprox ? `${ask.themApprox} (approx.)` : ask.themPlace!, now });
    return meetHalfway({ ask, text, when, base, begin, unknowns, sources, you: youPlace ? { ...youPlace.location, id: youPlace.id ?? undefined } : reqYou!, youName: youPlace?.name ?? "your location", them: themPlace!, themTyped: ask.themApprox ? `${ask.themApprox} (approx.)` : ask.themPlace!, now });
  }
  if (ask.youPlace && !youPlace && !reqYou) return clarify({ question: `${youR?.confidence === "medium" ? `Not sure which "${ask.youPlace}" you mean.` : `I couldn't find "${ask.youPlace}" on TfL.`} Which station are you nearest?`, missing: "my_location", suggestions: youR?.suggestions.length ? youR.suggestions : ME_SUGGESTIONS });
  const origin = youPlace?.location ?? reqYou;
  if (!origin) return clarify({ question: "Where are you? Share your location or name a station.", missing: "my_location", suggestions: ME_SUGGESTIONS });
  if (dest) return goTo({ ask, text, when, base, begin, unknowns, sources, dest, you: youPlace ? { ...youPlace.location, id: youPlace.id ?? undefined } : origin, youName: youPlace?.name ?? "your location", them: null, themTyped: null, now });
  return nearMe({ ask, text, when, base, begin, unknowns, sources, you: origin, youName: youPlace?.name, now });
}

/** The venue's own area for the card ("South Bank · near Waterloo"); from OSM tags + nearest station only. */
const areaOf = (tags: Record<string, string>, p: LatLng): { area?: string } => {
  const a = venueArea(tags, p);
  return a ? { area: a } : {};
};

type Ctx = {
  ask: PlanAsk;
  text: string;
  when: Date;
  base: PlanResultWithAgent;
  begin: ReturnType<typeof stepper>["begin"];
  unknowns: string[];
  sources: Sources;
  now?: Date;
};

async function finish(ctx: Ctx, r: PlanResultWithAgent): Promise<PlanResultWithAgent> {
  // Grounding check: every fact must name a source; drop the rest and say how many.
  const v = ctx.begin("verify", "Verifying claims");
  let checked = 0;
  let dropped = 0;
  for (const c of r.cards) {
    const before = c.facts.length;
    c.facts = c.facts.filter((f) => typeof f.source === "string" && f.source.trim().length > 0 && f.source !== "—");
    checked += before;
    dropped += before - c.facts.length;
  }
  // Their area never goes in the message, and no placeholder ever reaches the screen.
  if (r.them && mentionsArea(r.draftMessage, r.them.area)) {
    r.draftMessage = scrubArea(r.draftMessage, r.them.area);
    dropped++;
  }
  await verifyStage(ctx, r);
  r.cards = r.cards.slice(0, MAX_CARDS);
  r.sources = [...ctx.sources.entries()].map(([name, asOf]) => ({ name, asOf })).sort((a, b) => a.name.localeCompare(b.name));
  r.unknowns = [...new Set(ctx.unknowns)];
  v("done", `${checked} facts checked · ${dropped} dropped without a source · ${r.sources.length} sources with as-of times`);
  // Agent memory: anonymised run record in MongoDB plan_runs (no coordinates, typed places or query text).
  // Started here but not awaited, so the answer isn't held up; the route awaits planRunWrite(r) after
  // sending the result and before ending the response, so serverless doesn't freeze the insert mid-flight.
  PLAN_RUN_WRITES.set(r, recordPlanRun(r, Date.now() - (RUN_STARTED.get(r.steps) ?? Date.now())));
  return r;
}

/** Verification loop (verify.ts): Argon proposes, deterministic checks dispose; ≤ MAX_CARDS of the pool stay.
 *  Then the draft follows the final top pick, and per-card unknowns only cover cards still shown. */
const REDRAFT = new WeakMap<PlanResultWithAgent, (cards: PlanCard[]) => string>();
const FIXED = new WeakSet<PlanResultWithAgent>();
async function verifyStage(ctx: Ctx, r: PlanResultWithAgent) {
  const before = r.cards.map((c) => c.id).join();
  const pool = r.cards;
  const query = r.them ? scrubArea(ctx.text, r.them.area) : ctx.text;
  const v = await verifyPicks(pool, { begin: ctx.begin, query, when: ctx.when, whenLabel: londonLabel(ctx.when), fixed: FIXED.has(r), max: MAX_CARDS, stepFree: STEP_FREE_ASK.test(ctx.text), maxMinutes: r.intent === "near_me" && !FIXED.has(r) ? ctx.ask.maxMinutes ?? 30 : undefined });
  r.cards = v.cards;
  (r as PlanResultVerified).verify = v.verify;
  const redo = REDRAFT.get(r);
  if (redo && r.cards.map((c) => c.id).join() !== pool.slice(0, MAX_CARDS).map((c) => c.id).join()) r.draftMessage = redo(r.cards);
  if (before === r.cards.map((c) => c.id).join()) return;
  const shown = new Set(r.cards.map((c) => c.name));
  const dropped = new Set(pool.filter((c) => !r.cards.includes(c)).map((c) => c.name));
  ctx.unknowns.splice(0, ctx.unknowns.length, ...ctx.unknowns.filter((u) => {
    const m = u.match(/^(.+): opening hours not in OSM\.$/);
    if (m) return shown.has(m[1]) || !dropped.has(m[1]);
    if (/^Event prices and whether you can walk in/.test(u)) return r.cards.some((c) => c.kind === "event");
    return true;
  }));
}

/** OSM tags behind each card (for blurbs: wikipedia / wikidata / description …); request memory only. */
const CARD_TAGS = new WeakMap<PlanCard, Record<string, string>>();
export const cardTags = (c: PlanCard): Record<string, string> => CARD_TAGS.get(c) ?? {};

/** A plan that failed outright, as a normal result with a friendly headline (the stream never ends empty). */
export function failedResult(query: string, now = new Date()): PlanResultWithAgent {
  const r = emptyResult(String(query ?? "").slice(0, 1500), now, undefined, [], ["Something went wrong on our side, not with your ask."]);
  r.headline = "Sorry, I couldn't plan that just now. Try again in a moment, or rephrase it.";
  return r;
}

const PLAN_RUN_WRITES = new WeakMap<PlanResultWithAgent, Promise<boolean>>();
/** The pending plan_runs insert for a finished plan (false when there was none / it failed). Never rejects. */
export const planRunWrite = (r: PlanResultWithAgent): Promise<boolean> => (PLAN_RUN_WRITES.get(r) ?? Promise.resolve(false)).catch(() => false);

async function meetHalfway(ctx: Ctx & { you: LatLng & { id?: string }; youName: string; them: Place; themTyped: string }): Promise<PlanResultWithAgent> {
  const { ask, when, begin, unknowns, sources } = ctx;
  const area = roundToArea(ctx.them.location);
  const themArea = { area: ctx.themTyped.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\(Approx\.\)/, "(approx.)"), center: area.center, radiusM: area.radiusM };
  if (ctx.ask.themApprox) ctx.unknowns.push("Their side is a broad area, not a station, so their journey time is approximate.");
  if (ctx.ask.youApprox) ctx.unknowns.push("Your side is a broad area, not a station, so your journey time is approximate.");
  const who = ask.themWho;

  const endCompare = begin("compare", "Comparing central hubs by TfL journey time", "TfL Journey Planner");
  const fp = await fairPoint(ctx.you, { ...ctx.them.location, id: ctx.them.id ?? undefined }, when);
  const history = await tieBreakByHistory(fp.ranked);
  const prefs = (ask as RefinedAsk).prefs;
  const hp = pickHub(fp.ranked, prefs);
  const best = hp.hub;
  const rr = REFINE_RUNS.get(ctx.base.steps);
  if (rr && best) Object.assign(rr, { hubWhy: hp.why, hubName: best.hub.name });
  if (best) addSource(sources, "TfL Journey Planner", best.a.fetchedAt);
  endCompare(best ? "done" : "failed", best
    ? `${fp.compared} hubs compared (${fp.calls} journeys${fp.failed ? `; no TfL time for ${fp.failedHubs.join(", ")}` : ""}) · ${best.hub.name} fairest: you ${best.a.minutes} min, ${who} ${best.b.minutes} min${fp.ranked[1] ? ` · next ${fp.ranked[1].hub.name} (${fp.ranked[1].a.minutes}/${fp.ranked[1].b.minutes})` : ""}${history ? ` · ${history}` : ""}`
    : `${fp.compared} hubs tried, no TfL journey times came back`);
  const result: PlanResultWithAgent = { ...ctx.base, intent: "meet_halfway", you: { lat: ctx.you.lat, lng: ctx.you.lng }, them: themArea };
  if (best && fp.failed) unknowns.push(`TfL didn't return times for ${fp.failedHubs.join(", ")}, so ${fp.failed > 1 ? "those hubs weren't" : "that hub wasn't"} compared.`);
  if (!best) {
    unknowns.push("TfL journey times didn't come back, so I couldn't pick a fair middle. Try again in a minute.");
    for (const [id, label] of [["venues", "Finding places near the middle"], ["lines", "Checking line status"], ["weather", "Checking the forecast"]]) begin(id, label)("skipped", "Needs a middle point first");
    result.headline = "Couldn't get TfL journey times right now.";
    return finish(ctx, result);
  }
  result.middle = { name: best.hub.name, location: { lat: best.hub.lat, lng: best.hub.lng } };
  const kind: OsmKind = ask.category === "cafe" ? "cafe" : ask.category === "restaurant" ? "restaurant" : "pub";
  if (!ask.category) unknowns.push(`You didn't say what kind of place, so these are ${kind === "pub" ? "pubs and bars" : kind}s.`);
  const lineIds = [...new Set([...best.a.lines, ...best.b.lines].map((l) => l.id))];

  const endVenues = begin("venues", `Finding ${kind === "pub" ? "pubs and bars" : kind + "s"} near ${best.hub.name}`, "OSM Overpass");
  const endLines = begin("lines", "Checking line status", "TfL");
  const endWeather = begin("weather", "Checking the forecast", "Open-Meteo");
  const [osmR, ls, wx] = await Promise.all([
    findOpenVenues(kind, result.middle.location, 500, when, ask as RefinedAsk),
    lineStatus(lineIds).then((r) => {
      endLines("error" in r ? "failed" : "done", "error" in r ? `TfL line status ${r.error}` : `${r.lines.length} line${r.lines.length === 1 ? "" : "s"}: ${r.lines.map((l) => `${l.name} ${l.status}`).join(", ") || "none used"}`);
      return r;
    }),
    forecastAt(result.middle.location, when).then((r) => {
      endWeather("error" in r ? "failed" : "done", "error" in r ? r.error : `${londonLabel(when)}: ${r.value}`);
      return r;
    }),
  ]);
  // Venues are ranked once the forecast is in, so the weather can decide indoor vs terrace.
  const wm = weatherMode(wx, londonClock(when.toISOString()));
  const osm = { r: osmR, pk: venuePick(osmR, when, wm, prefs, (ask as RefinedAsk).cuisine) };
  // An in-between station (not a central hub) can be quiet: look a little wider before giving up.
  if (!osm.pk.picks.length && !HUBS.some((h) => h.id === best.hub.id)) {
    const wide = await findOpenVenues(kind, result.middle.location, 900, when, ask as RefinedAsk);
    Object.assign(osm, { r: wide, pk: venuePick(wide, when, wm, prefs, (ask as RefinedAsk).cuisine) });
  }
  endVenues(osm.pk.picks.length ? "done" : "failed", `${osmR.via ? `${osmR.via} · ${osmR.places.length} within 500 m` : `${osmR.places.length} found within 500 m (${osmR.source}${osmR.live ? "" : ", live call " + (osmR.note?.match(/Overpass (\w+)/)?.[1] ?? "failed")})`} · ${osm.pk.closed} closed at ${londonClock(when.toISOString())}${osm.pk.soonDropped ? ` · ${osm.pk.soonDropped} closing within the hour dropped` : ""} · ${osm.pk.picks.length} kept · ${weatherDecision(wm, osm.pk.picks.map((x) => x.p))}`, osmR.stepSource);
  addSource(sources, osm.r.source, osm.r.asOf);
  if ((osmR as { lateBars?: boolean }).lateBars) unknowns.push(`Few cafés near ${best.hub.name} are open at ${londonClock(when.toISOString())}, so bars open late are included.`);
  if (!osm.r.live && osm.r.note) unknowns.push(osm.r.note + ".");
  if (!("error" in ls)) addSource(sources, "TfL Line Status", ls.fetchedAt);
  else unknowns.push("Live line status didn't load.");
  if (!("error" in wx)) addSource(sources, "Open-Meteo", wx.fetchedAt);
  else unknowns.push(`Weather: ${wx.error}.`);
  unknowns.push("Line status is as of now, not for the time of the plan.");
  unknowns.push("Prices: none of our sources lists them" + (ask.budgetGBP ? `, so I can't check £${ask.budgetGBP}.` : "."));
  unknowns.push("How busy or noisy it'll be: no source has this.");

  const day = londonDayShort(when);
  const tflFact = fact("Travel", `TfL planner: you ${best.a.minutes} min, ${who} ${best.b.minutes} min to ${best.hub.name}, arriving by ${londonClock(when.toISOString())}`, "confirmed", "TfL", best.a.fetchedAt);
  const lf = lineFacts(lineIds, ls);
  const wf = weatherFact(wx, when);
  const themPath = trimPathStart(best.b.path, 500, metresBetween);
  const themSegs = trimSegmentsStart(best.b.segments, 500, metresBetween);
  const hubEnd = { name: best.hub.name, location: result.middle.location };
  result.cards = osm.pk.pool.map(({ p, h }): PlanCardWithHours => {
    const walk = walkMinutes(metresBetween(result.middle!.location, p.location));
    const addr = addressOf(p.tags);
    const venueEnd = { name: p.tags.name, location: p.location };
    const legs: LegWithSegments[] = [
      { who: "you", minutes: best.a.minutes, summary: `${best.a.summary} · then ~${walk} min walk (estimate)`, path: best.a.path, segments: tidySegments(walkOn(best.a.segments, hubEnd, venueEnd, walk), ctx.youName) },
      { who: "them", minutes: best.b.minutes, summary: `${best.b.summary} · then ~${walk} min walk (estimate)`, path: themPath, segments: tidySegments(walkOn(themSegs, hubEnd, venueEnd, walk)) },
    ];
    if (h.state === "unknown") unknowns.push(`${p.tags.name}: opening hours not in OSM.`);
    return {
      id: `osm-${p.type}-${p.id}`,
      kind: "venue",
      name: p.tags.name,
      subtitle: [kindLabel(p.tags), addr].filter(Boolean).join(" · "),
      ...areaOf(p.tags, p.location),
      location: p.location,
      legs,
      facts: [
        fact(`Open ${day}`, h.value, h.verdict, osm.r.source, osm.r.asOf),
        tflFact,
        ...lf,
        wf,
        ...fitFact(p.tags, wm, osm.r, wx),
        ...seatFact(p.tags, prefs, osm.r),
        ...cuisineFact(p.tags, (ask as RefinedAsk).cuisine, osm.r),
        fact("Price", ask.budgetGBP ? `Not listed, can't check £${ask.budgetGBP}` : "Not listed", "unknown", "OSM (no price tag)"),
        stepFree(p.tags, osm.r.asOf, osm.r.source),
      ],
      why: `${Math.round(p.distanceM)} m from ${best.hub.name}, the fairest hub (${best.a.minutes} vs ${best.b.minutes} min)${untilWhy(h)}${h.verdict === "confirmed" ? "; hours recently checked in OSM" : ""}.`,
      url: p.tags.website ?? p.tags["contact:website"] ?? osmUrl(p),
      ...cardHours(h),
    };
  });
  result.cards.forEach((c, i) => CARD_TAGS.set(c, osm.pk.pool[i].p.tags));
  if (!result.cards.length) unknowns.push(`No open ${kind}s found within 500 m of ${best.hub.name} in OSM.`);
  const hubWhy = hp.why === "closer_you" ? "is closer to you" : hp.why === "closer_them" ? `is closer to ${who}` : hp.why === "different" ? "is the next fairest middle" : "is the fair middle";
  result.headline = `${best.hub.name} ${hubWhy}: you ${best.a.minutes} min, ${who} ${best.b.minutes}.`;
  // Short, friendly, paste-ready: no line status or forecast; their journey time only, never their area.
  // The hub's name only when it isn't their own area (the message goes to them; their area is never in it).
  // Drafted from the top card; redrafted after the verification loop picks the final top.
  const draft = (cards: PlanCard[]) => {
    const top = cards[0];
    return meetDraft({ venue: top?.name, address: (top && addressOf(cardTags(top))) || undefined, hub: sameArea(best.hub.name, themArea.area) ? undefined : best.hub.name, when, category: ask.category, themMinutes: best.b.minutes, url: top?.url, now: ctx.now });
  };
  result.draftMessage = draft(result.cards);
  REDRAFT.set(result, draft);
  return finish(ctx, result);
}

async function nearMe(ctx: Ctx & { you: LatLng; youName?: string }): Promise<PlanResultWithAgent> {
  const { ask, when, begin, unknowns, sources } = ctx;
  const maxMin = ask.maxMinutes ?? 30;
  const result: PlanResultWithAgent = { ...ctx.base, intent: "near_me", you: ctx.you };
  const lp = londonParts(when);
  const venueKind: OsmKind | null = ask.category === "pub" || ask.category === "cafe" || ask.category === "restaurant" ? ask.category : null;
  const t = londonClock(when.toISOString());
  const endWeather = begin("weather", "Checking the forecast", "Open-Meteo");
  const wxP = forecastAt(ctx.you, when).then((r) => {
    endWeather("error" in r ? "failed" : "done", "error" in r ? r.error : `${londonLabel(when)}: ${r.value}`);
    return r;
  });

  type Cand = { kind: "event"; e: SeedEvent } | { kind: "place"; p: OsmPlace; h: Hrs; osm: OsmResult };
  const cands: Cand[] = [];
  let osm: OsmResult | null = null;
  let wm: WeatherMode = { mode: "neutral", label: "" }; // weather only re-ranks pubs / cafés / restaurants
  const endFind = begin("venues", venueKind ? `Finding ${venueKind}s near you` : "Finding events and free-entry places near you", venueKind ? "OSM Overpass" : "Luma seed + OSM Overpass");
  if (venueKind) {
    osm = await findOpenVenues(venueKind, ctx.you, (ask as RefinedAsk).focus ? 800 : 1200, when, ask as RefinedAsk);
    wm = weatherMode(await wxP, t);
    const pk = venuePick(osm, when, wm, (ask as RefinedAsk).prefs, (ask as RefinedAsk).cuisine);
    for (const x of pk.picks.concat()) cands.push({ kind: "place", p: x.p, h: x.h, osm });
    endFind(cands.length ? "done" : "failed", `${osm.via ? `${osm.via} · ` : ""}${osm.places.length} ${venueKind}s within 1.2 km (${osm.source}) · ${pk.closed} closed at ${t}${pk.soonDropped ? ` · ${pk.soonDropped} closing within the hour dropped` : ""} · ${weatherDecision(wm, pk.picks.map((x) => x.p))}`, osm.stepSource);
  } else {
    const all = seedEventsOn(lp.date, when, (d) => londonParts(d).date);
    const mev = await mongoEventsNear(ctx.you, 8000, when, lp.date, new Date(londonToUtc(lp.date, 23, 59).getTime() + 60_000), (d) => londonParts(d).date);
    if (mev) addSource(sources, mev.source, mev.asOf);
    const near = mev ? mev.events : all.filter((e) => metresBetween(ctx.you, e) < 8000);
    const blocked = ask.walkIn ? near.filter((e) => e.walkIn.rsvpRequired) : [];
    const evs = near.filter((e) => !blocked.includes(e)).sort((a, b) => metresBetween(ctx.you, a) - metresBetween(ctx.you, b)).slice(0, 6);
    for (const e of all) addSource(sources, e.source, e.asOf);
    for (const e of evs) cands.push({ kind: "event", e });
    osm = await findVenues("free", ctx.you, 2500);
    // Prefer places that list opening hours or a website (a real venue), then nearest.
    const info = (p: OsmPlace) => (p.tags.opening_hours || p.tags.website || p.tags["contact:website"] ? 0 : 1);
    const rows = osm.places.map((p) => ({ p, h: closingSoon(hoursAt(p.tags, when, p.location)) }));
    const open = openEnough(rows).keep.sort((a, b) => soon(a.h) - soon(b.h) || info(a.p) - info(b.p) || (a.h.state === "unknown" ? 1 : 0) - (b.h.state === "unknown" ? 1 : 0));
    const closed = rows.filter((x) => x.h.state === "closed").length;
    for (const x of open.slice(0, 6)) cands.push({ kind: "place", p: x.p, h: x.h, osm });
    endFind("done", `${mev ? `${mev.via} · ` : ""}${all.length} seed events that day · ${near.length} within 8 km${ask.walkIn ? ` · ${blocked.length} dropped as RSVP-only` : ""} · ${osm.places.length} free-entry places within 2.5 km (${osm.source}), ${closed} closed at ${t}`, mev?.stepSource ?? osm.stepSource);
  }
  if (osm) {
    addSource(sources, osm.source, osm.asOf);
    if (!osm.live && osm.note) unknowns.push(osm.note + ".");
    if ((osm as { lateBars?: boolean }).lateBars) unknowns.push(`Few cafés nearby are open at ${t}, so bars open late are included.`);
  }

  const endTravel = begin("travel", `Checking TfL times to ${cands.length} options`, "TfL Journey Planner");
  const trips = await Promise.all(cands.map((c) => journey(ctx.you, c.kind === "event" ? { lat: c.e.lat, lng: c.e.lng } : c.p.location, when)));
  const scored = cands
    .map((c, i) => ({ c, j: trips[i] }))
    .filter((x): x is { c: Cand; j: Journey } => !("error" in x.j));
  const failedTrips = cands.length - scored.length;
  const within = scored.filter((x) => x.j.minutes <= maxMin);
  endTravel(cands.length ? "done" : "skipped", `${scored.length} journeys back${failedTrips ? ` (${failedTrips} failed)` : ""} · ${within.length} within ${maxMin} min`);
  if (scored[0]) addSource(sources, "TfL Journey Planner", scored[0].j.fetchedAt);
  if (failedTrips) unknowns.push(`${failedTrips} option${failedTrips > 1 ? "s" : ""} skipped: TfL journey time didn't come back.`);

  const wrC = (c: Cand) => (c.kind === "place" ? weatherRank(c.p.tags, wm) : 0);
  const walkScore = (c: Cand) => (c.kind === "place" ? (c.osm && c.p.tags.fee === "no" ? 0 : 1) : c.e.walkIn.verdict === "unknown" ? 1 : 2);
  const prefs = (ask as RefinedAsk).prefs;
  const prC = (c: Cand) => (c.kind === "place" ? prefRank(c.p.tags, prefs) : 0);
  within.sort((a, b) =>
    prefs?.includes("closer_you") ? a.j.minutes - b.j.minutes :
    ask.walkIn || ask.free ? walkScore(a.c) - walkScore(b.c) || prC(a.c) - prC(b.c) || a.j.minutes - b.j.minutes : (a.c.kind === "event" ? 0 : 1) - (b.c.kind === "event" ? 0 : 1) || prC(a.c) - prC(b.c) || wrC(a.c) - wrC(b.c) || a.j.minutes - b.j.minutes,
  );
  const chosen = prefs?.includes("different") && within.length > MAX_CARDS ? within.slice(MAX_CARDS, MAX_CARDS + POOL) : within.slice(0, POOL);
  const lineIds = [...new Set(chosen.flatMap((x) => x.j.lines.map((l) => l.id)))];
  const endLines = begin("lines", "Checking line status", "TfL");
  const ls = lineIds.length ? await lineStatus(lineIds) : null;
  endLines(!lineIds.length ? "skipped" : ls && !("error" in ls) ? "done" : "failed", !lineIds.length ? "No TfL lines on these routes (walking or bus only)" : ls && !("error" in ls) ? ls.lines.map((l) => `${l.name} ${l.status}`).join(", ") : "Line status didn't load");
  if (ls && !("error" in ls)) addSource(sources, "TfL Line Status", ls.fetchedAt);
  const wx = await wxP;
  if (!("error" in wx)) addSource(sources, "Open-Meteo", wx.fetchedAt);
  const wf = weatherFact(wx, when);
  const day = londonDayShort(when);

  result.cards = chosen.map(({ c, j }): PlanCardWithHours => {
    const leg: LegWithSegments = { who: "you", minutes: j.minutes, summary: j.summary, path: j.path, segments: tidySegments(j.segments, ctx.youName) };
    const travel = fact("Travel", `TfL planner: ${j.minutes} min (${j.summary})`, "confirmed", "TfL", j.fetchedAt);
    const lf = lineFacts(j.lines.map((l) => l.id), ls);
    if (c.kind === "event") {
      const e = c.e;
      const s = londonClock(e.start);
      const en = e.end ? londonClock(e.end) : null;
      return {
        id: `evt-${e.id}`,
        kind: "event",
        name: e.title,
        subtitle: [`Event · ${s}${en ? `–${en}` : ""}`, e.place, e.organiser].filter(Boolean).join(" · "),
        location: { lat: e.lat, lng: e.lng },
        legs: [leg],
        facts: [
          fact("When", `${londonLabel(new Date(e.start))}${en ? `–${en}` : ""}`, "confirmed", e.source, e.asOf),
          fact("Sign-up", e.walkIn.value, e.walkIn.verdict, e.source, e.asOf),
          fact("Price", "Not in the listing", "unknown", e.source),
          travel,
          ...lf,
          wf,
        ],
        why: `${j.minutes} min away by TfL; on ${day} in the ${e.source}${e.walkIn.verdict === "unknown" ? ", sign-up not stated" : ""}.`,
        url: e.url,
        ...eventHours(e, when),
      };
    }
    const p = c.p;
    const free = p.tags.fee === "no";
    const addr = addressOf(p.tags);
    return {
      id: `osm-${p.type}-${p.id}`,
      kind: "venue",
      name: p.tags.name ?? kindLabel(p.tags),
      subtitle: [kindLabel(p.tags), addr].filter(Boolean).join(" · "),
      ...areaOf(p.tags, p.location),
      location: p.location,
      legs: [leg],
      facts: [
        fact(`Open ${day}`, c.h.value, c.h.verdict, c.osm.source, c.osm.asOf),
        ...(free
          ? [fact("Entry", "Free (OSM fee=no)", "confirmed", c.osm.source, c.osm.asOf), fact("Sign-up", "Likely none: free entry, no ticket tag in OSM", "likely", c.osm.source, c.osm.asOf)]
          : [fact("Price", "Not listed", "unknown", "OSM (no price tag)")]),
        travel,
        ...lf,
        wf,
        ...fitFact(p.tags, wm, c.osm, wx),
        ...seatFact(p.tags, prefs, c.osm),
        ...cuisineFact(p.tags, (ask as RefinedAsk).cuisine, c.osm),
        stepFree(p.tags, c.osm.asOf, c.osm.source),
      ],
      why: `${j.minutes} min away by TfL${free ? ", free entry" : ""}${untilWhy(c.h)}.`,
      url: p.tags.website ?? p.tags["contact:website"] ?? osmUrl(p),
      ...cardHours(c.h),
    };
  });
  result.cards.forEach((card, i) => {
    const c = chosen[i].c;
    if (c.kind === "place") CARD_TAGS.set(card, c.p.tags);
  });
  for (const x of chosen) if (x.c.kind === "place" && x.c.h.state === "unknown") unknowns.push(`${x.c.p.tags.name ?? "A place"}: opening hours not in OSM.`);
  if (chosen.some((x) => x.c.kind === "event")) unknowns.push("Event prices and whether you can walk in: the seed listings don't say.");
  if (lineIds.length) unknowns.push("Line status is as of now, not for the time of the plan.");
  unknowns.push("How busy it'll be: no source has this.");
  const n = Math.min(result.cards.length, MAX_CARDS); // the verification loop shows ≤ MAX_CARDS of the pool
  const what = ask.walkIn ? "walk-in option" : venueKind ? venueKind === "pub" ? "pub" : venueKind : "option";
  result.headline = n
    ? `${n} ${what}${n > 1 ? "s" : ""} within ${maxMin} min of ${ctx.youName ?? "you"}, ${londonLabel(when)}.`
    : `Nothing open in our data within ${maxMin} min of ${ctx.youName ?? "you"} at ${londonLabel(when)}.`;
  const draft = (cards: PlanCard[]) => nearDraft({ picks: cards.slice(0, MAX_CARDS).map((c) => ({ name: c.name, event: c.kind === "event", free: c.kind !== "event" && cardTags(c).fee === "no", url: c.url })), when, now: ctx.now });
  result.draftMessage = draft(result.cards);
  REDRAFT.set(result, draft);
  return finish(ctx, result);
}

/** A fixed destination (a named venue / address, e.g. from a snapped poster): no hub or venue search.
 *  One card for that place, TfL from you (and them), the forecast there at that time.
 *  result.middle stays unset, so plan_runs never records the place typed. */
async function goTo(ctx: Ctx & { dest: Destination; you: LatLng & { id?: string }; youName: string; them: Place | null; themTyped: string | null }): Promise<PlanResultWithAgent> {
  const { ask, when, begin, unknowns, sources, dest } = ctx;
  const who = ask.themWho;
  const result: PlanResultWithAgent = { ...ctx.base, intent: ctx.them ? "meet_halfway" : "near_me", you: { lat: ctx.you.lat, lng: ctx.you.lng } };
  FIXED.add(result);
  if (ctx.them && ctx.themTyped) {
    const area = roundToArea(ctx.them.location);
    result.them = { area: ctx.themTyped.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\(Approx\.\)/, "(approx.)"), center: area.center, radiusM: area.radiusM };
    if (ask.themApprox) unknowns.push("Their side is a broad area, not a station, so their journey time is approximate.");
  }
  if (ask.youApprox) unknowns.push("Your side is a broad area, not a station, so your journey time is approximate.");

  const endPlace = begin("place", "Finding the place you named", "Atlas Search · OSM · postcodes.io");
  const found = await resolveDestination(dest, ctx.you);
  if (!found) {
    endPlace("failed", "No match in the OSM venues, Nominatim or a postcode");
    addSource(sources, "OSM Nominatim", new Date().toISOString());
    for (const [id, label] of [["travel", "Checking TfL journeys"], ["lines", "Checking line status"], ["weather", "Checking the forecast"]]) begin(id, label)("skipped", "Needs the place first");
    unknowns.push(`Couldn't place "${dest.venue}": add the street or postcode and try again.`);
    result.headline = `Couldn't find ${dest.venue} on the map. Add the street or postcode and I'll route you there.`;
    return finish(ctx, result);
  }
  addSource(sources, found.source, found.asOf);
  endPlace("done", `${found.name} · ${found.how}${found.address ? ` · ${found.address}` : ""} · destination fixed, no middle search`, found.source);
  if (found.pinned === false) unknowns.push(`Couldn't pin ${dest.venue} exactly, so this goes to ${found.how}.`);
  else if (found.verdict !== "confirmed") unknowns.push(`${found.name}: placed at ${found.how}, not an exact map pin.`);
  const ev = dest.dates;
  const span = ev ? (ev.end ? `${shortDay(ev.start)} – ${shortDay(ev.end)}` : shortDay(ev.start)) : null;
  if (ev?.status === "ongoing" && ev.end) unknowns.push(`${dest.title ?? found.name} runs until ${shortDay(ev.end)}${dest.endTime ? ` ${dest.endTime}` : ""}, so this is planned for today.`);
  if (ev?.status === "past") unknowns.push(`${dest.title ?? found.name} was ${span}, so it's already over; the trip is planned for now in case you still want to go.`);

  const t = londonClock(when.toISOString());
  const endTravel = begin("travel", ctx.them ? "Checking TfL journeys for both of you" : "Checking your TfL journey", "TfL Journey Planner");
  const endWeather = begin("weather", "Checking the forecast", "Open-Meteo");
  const [ja, jb, wx] = await Promise.all([
    journey(ctx.you, found.location, when),
    ctx.them ? journey({ ...ctx.them.location, id: ctx.them.id ?? undefined }, found.location, when) : Promise.resolve(null),
    forecastAt(found.location, when).then((r) => {
      endWeather("error" in r ? "failed" : "done", "error" in r ? r.error : `${londonLabel(when)}: ${r.value}`);
      return r;
    }),
  ]);
  const a = "error" in ja ? null : ja;
  const b = jb && !("error" in jb) ? jb : null;
  endTravel(a || b ? "done" : "failed", `you ${a ? `${a.minutes} min` : "no TfL time"}${ctx.them ? ` · ${who} ${b ? `${b.minutes} min` : "no TfL time"}` : ""} · arriving by ${t}`);
  if (a) addSource(sources, "TfL Journey Planner", a.fetchedAt);
  else unknowns.push("TfL didn't return your journey time; try again in a minute.");
  if (ctx.them && !b) unknowns.push(`TfL didn't return ${who === "them" ? "their" : `${who}'s`} journey time.`);
  const lineIds = [...new Set([...(a?.lines ?? []), ...(b?.lines ?? [])].map((l) => l.id))];
  const endLines = begin("lines", "Checking line status", "TfL");
  const ls = await lineStatus(lineIds);
  endLines("error" in ls ? "failed" : "done", "error" in ls ? `TfL line status ${ls.error}` : `${ls.lines.length} line${ls.lines.length === 1 ? "" : "s"}: ${ls.lines.map((l) => `${l.name} ${l.status}`).join(", ") || "none used"}`);
  if (!("error" in ls)) addSource(sources, "TfL Line Status", ls.fetchedAt);
  if (!("error" in wx)) addSource(sources, "Open-Meteo", wx.fetchedAt);
  else unknowns.push(`Weather: ${wx.error}.`);
  if (lineIds.length) unknowns.push("Line status is as of now, not for the time of the plan.");

  const isEvent = !!dest.title;
  const tags = found.tags;
  const h = tags.opening_hours ? closingSoon(hoursAt(tags, when, found.location)) : null;
  const facts: Fact[] = [];
  if (isEvent) {
    // The event's own times ("Fri 23 Oct 12:00 – Sun 25 Oct 16:30"), never the trip's now-slot as its start.
    facts.push(fact("When", ev?.end ? `${shortDay(ev.start)}${ev.startTime ? ` ${ev.startTime}` : ""} – ${shortDay(ev.end)}${dest.endTime ? ` ${dest.endTime}` : ""}${ev.status === "past" ? " (over)" : ev.status === "ongoing" ? " (on now)" : ""}` : ev?.status === "past" ? `${span}${ev.startTime ? ` ${ev.startTime}` : ""}${dest.endTime ? `${ev.startTime ? "–" : ", until "}${dest.endTime}` : ""} (over)` : `${londonLabel(when)}${dest.endTime && (ev?.startTime || !ev) ? `–${dest.endTime}` : ""}`, "likely", "Your ask"));
    unknowns.push(`${dest.title}: date, time and entry are as given (e.g. on the poster), not checked against a listing.`);
  } else if (h) facts.push(fact(`Open ${londonDayShort(when)}`, h.value, h.verdict, found.source, found.asOf));
  else unknowns.push(`${found.name}: opening hours not listed.`);
  facts.push(
    a || b
      ? fact("Travel", `TfL planner: you ${a ? `${a.minutes} min` : "no time"}${ctx.them ? `, ${who} ${b ? `${b.minutes} min` : "no time"}` : ""} to ${found.name}, arriving by ${t}`, "confirmed", "TfL", (a ?? b)!.fetchedAt)
      : fact("Travel", "TfL journey time didn't come back", "unknown", "TfL"),
  );
  facts.push(...lineFacts(lineIds, ls), weatherFact(wx, when));
  if (dest.free) facts.push(fact("Entry", "Free (as given)", "likely", "Your ask"));
  else if (dest.priceText) facts.push(fact("Price", `${dest.priceText} (as given)`, "likely", "Your ask"));
  else facts.push(fact("Price", "Not listed", "unknown", isEvent ? "Your ask (no price)" : "OSM (no price tag)"));
  if (dest.signUp !== null) facts.push(fact("Sign-up", dest.signUp ? "Needed (as given)" : "Not needed (as given)", "likely", "Your ask"));
  else if (isEvent) facts.push(fact("Sign-up", "Not stated", "unknown", "Your ask"));
  facts.push(stepFree(tags, found.asOf, found.source === "postcodes.io" ? "OSM" : found.source));

  const legs: LegWithSegments[] = [];
  if (a) legs.push({ who: "you", minutes: a.minutes, summary: a.summary, path: a.path, segments: tidySegments(a.segments, ctx.youName) });
  if (b) legs.push({ who: "them", minutes: b.minutes, summary: b.summary, path: trimPathStart(b.path, 500, metresBetween), segments: tidySegments(trimSegmentsStart(b.segments, 500, metresBetween)) });
  const addr = found.address ?? dest.address ?? addressOf(tags);
  const slug = (isEvent ? `${dest.title}-${found.name}` : found.name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  const url = tags.website ?? tags["contact:website"] ?? (found.id?.startsWith("osm-") ? `https://www.openstreetmap.org/${found.id.split("-")[1]}/${found.id.split("-")[2]}` : undefined);
  const card: PlanCardWithHours = {
    id: isEvent ? `dest-${slug}` : (found.id ?? `dest-${slug}`),
    kind: isEvent ? "event" : "venue",
    name: isEvent ? dest.title! : found.name,
    subtitle: (isEvent ? [`${londonDayShort(when)} ${t}${dest.endTime ? `–${dest.endTime}` : ""}`, found.name, addr] : [kindLabel(tags), addr]).filter(Boolean).join(" · "),
    ...areaOf(tags, found.location),
    location: found.location,
    legs,
    facts,
    why: `The place you named, so no middle search${a ? `: ${a.minutes} min for you` : ""}${b ? `, ${b.minutes} for ${who}` : ""}${!isEvent && h ? untilWhy(h) : ""}.`,
    ...(url ? { url } : {}),
    ...(isEvent
      ? { openAtPlan: ev?.status !== "past", closesAt: dest.endTime, closingSoon: false, hoursKnown: !!dest.endTime }
      : h ? cardHours(h) : { openAtPlan: null, closesAt: null, closingSoon: false, hoursKnown: false }),
  };
  result.cards = [card];
  CARD_TAGS.set(card, tags);
  const label = isEvent ? `${dest.title} at ${found.name}` : found.name;
  const trip = `${a ? `you ${a.minutes} min` : "no TfL time for you"}${ctx.them ? `, ${who} ${b ? b.minutes : "?"}` : ""}`;
  result.headline = ev?.status === "past" ? `${label} was ${span}, so it's already over. Getting there now: ${trip}.` : `${label}, ${londonLabel(when)}${ev?.status === "ongoing" ? " (on now)" : ""}: ${trip}.`;
  result.draftMessage = goDraft({ title: dest.title ?? undefined, venue: found.name, address: addr ?? undefined, when, themMinutes: ctx.them ? b?.minutes : undefined, url, now: ctx.now });
  return finish(ctx, result);
}
