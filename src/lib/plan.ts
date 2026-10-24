// "So where?" plan pipeline: parse → resolve places → compare hubs → venues/events → line status → weather → verify.
// Every Fact carries a source; anything we couldn't check goes into `unknowns`. The other person's location
// is only ever kept as a ~500 m area, is never logged, and never appears in draftMessage.
import { parsePlanAsk, type PlanAsk } from "@/lib/ask-local";
import { LONDON_CENTER } from "@/lib/areas";
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
import { fairPoint, journey, lineStatus, searchPlace, trimPathStart, type Journey, type LineStatus, type Place } from "@/lib/tfl";
import { forecastAt, type Forecast } from "@/lib/weather";
import { weatherDecision, weatherFitFact, weatherMode, weatherRank, type WeatherMode } from "@/lib/venue-weather";

export type PlanRequest = { query: string; you?: LatLng; when?: string; previous?: { query: string; answer: string } };
export type StepSink = (step: AgentStep) => void;

const MAX_CARDS = 3;
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
  const base = parsePlanAsk(prevQuery, today);
  const slot = base.intent ? await pendingSlot(base, reqYou) : null;
  if (!slot) {
    const text = `${prevQuery}. ${a}`;
    return { ask: parsePlanAsk(text, today), text };
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

function planTime(ask: PlanAsk, reqWhen: string | undefined, now: Date, unknowns: string[]) {
  const today = londonToday(now);
  const given = reqWhen && Number.isFinite(Date.parse(reqWhen)) ? new Date(reqWhen) : null;
  const gp = given ? londonParts(given) : null;
  const date = ask.date ?? gp?.date ?? today;
  let time = ask.time ?? (gp && !ask.date ? `${String(gp.hh).padStart(2, "0")}:${String(gp.mm).padStart(2, "0")}` : null);
  if (!time) {
    if (date === today) {
      const n = londonParts(new Date(now.getTime() + 15 * 60_000));
      time = `${String(n.hh).padStart(2, "0")}:${String(Math.floor(n.mm / 15) * 15).padStart(2, "0")}`;
      unknowns.push("No time given, so this is planned for about now.");
    } else {
      time = "12:00";
      unknowns.push("No time given, so this is planned for midday.");
    }
  }
  const [hh, mm] = time.split(":").map(Number);
  return londonToUtc(date, hh, mm);
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

function venuePick(res: OsmResult, at: Date, wm?: WeatherMode) {
  const rank = { confirmed: 0, likely: 1, forecast: 2, unknown: 3 } as const;
  const rows = res.places.map((p) => ({ p, h: hoursAt(p.tags, at, p.location) }));
  const closed = rows.filter((r) => r.h.state === "closed").length;
  // Weather fit first (indoor when wet, terrace when warm; OSM seating tags), then hours confidence, then distance.
  const wr = (p: OsmPlace) => (wm ? weatherRank(p.tags, wm) : 0);
  const keep = rows.filter((r) => r.h.state !== "closed").sort((a, b) => wr(a.p) - wr(b.p) || rank[a.h.verdict] - rank[b.h.verdict] || a.p.distanceM - b.p.distanceM);
  return { picks: keep.slice(0, MAX_CARDS), total: rows.length, closed };
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

export async function runPlan(req: PlanRequest, emit?: StepSink, now = new Date()): Promise<PlanResultWithAgent> {
  const { steps, begin } = stepper(emit);
  const today = londonToday(now);
  const unknowns: string[] = [];
  const sources: Sources = new Map();
  const reqYou = validLatLng(req.you) ? req.you : undefined;

  // 1. Parse
  const endParse = begin("parse", "Reading your ask", "rules");
  const merged = req.previous?.query ? await mergeAnswer(req.previous.query, req.previous.answer || req.query, today, reqYou) : null;
  const text = merged?.text ?? String(req.query ?? "").slice(0, 500);
  let ask = merged?.ask ?? parsePlanAsk(text, today);
  let parseSource = "rules";
  if (process.env.GEMINI_API_KEY && (!ask.intent || (ask.intent === "meet_halfway" && (!ask.themPlace || !ask.youPlace)) || !ask.category)) {
    const g = await geminiFill(text, ask, today);
    if (g.used && g.filled.length) {
      ask = g.ask;
      parseSource = "rules + Gemini";
    }
  }
  endParse("done", `${ask.intent ?? "no intent"} · ${ask.signals.join(" · ") || "nothing recognised"} (${parseSource})`);

  const when = planTime(ask, req.when, now, unknowns);
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
    return meetHalfway({ ask, text, when, base, begin, unknowns, sources, you: youPlace ? { ...youPlace.location, id: youPlace.id ?? undefined } : reqYou!, youName: youPlace?.name ?? "your location", them: themPlace!, themTyped: ask.themPlace! });
  }
  if (ask.youPlace && !youPlace && !reqYou) return clarify({ question: `${youR?.confidence === "medium" ? `Not sure which "${ask.youPlace}" you mean.` : `I couldn't find "${ask.youPlace}" on TfL.`} Which station are you nearest?`, missing: "my_location", suggestions: youR?.suggestions.length ? youR.suggestions : ME_SUGGESTIONS });
  const origin = youPlace?.location ?? reqYou;
  if (!origin) return clarify({ question: "Where are you? Share your location or name a station.", missing: "my_location", suggestions: ME_SUGGESTIONS });
  return nearMe({ ask, text, when, base, begin, unknowns, sources, you: origin, youName: youPlace?.name });
}

type Ctx = {
  ask: PlanAsk;
  text: string;
  when: Date;
  base: PlanResultWithAgent;
  begin: ReturnType<typeof stepper>["begin"];
  unknowns: string[];
  sources: Sources;
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
  if (r.them && r.draftMessage.toLowerCase().includes(r.them.area.toLowerCase())) {
    r.draftMessage = r.draftMessage.split(r.them.area).join("[their area]");
    dropped++;
  }
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

const PLAN_RUN_WRITES = new WeakMap<PlanResultWithAgent, Promise<boolean>>();
/** The pending plan_runs insert for a finished plan (false when there was none / it failed). Never rejects. */
export const planRunWrite = (r: PlanResultWithAgent): Promise<boolean> => (PLAN_RUN_WRITES.get(r) ?? Promise.resolve(false)).catch(() => false);

async function meetHalfway(ctx: Ctx & { you: LatLng & { id?: string }; youName: string; them: Place; themTyped: string }): Promise<PlanResultWithAgent> {
  const { ask, when, begin, unknowns, sources } = ctx;
  const area = roundToArea(ctx.them.location);
  const themArea = { area: ctx.themTyped.replace(/\b\w/g, (c) => c.toUpperCase()), center: area.center, radiusM: area.radiusM };
  const who = ask.themWho;

  const endCompare = begin("compare", "Comparing central hubs by TfL journey time", "TfL Journey Planner");
  const fp = await fairPoint(ctx.you, { ...ctx.them.location, id: ctx.them.id ?? undefined }, when);
  const history = await tieBreakByHistory(fp.ranked);
  const best = fp.ranked[0];
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
    findVenues(kind, result.middle.location, 500),
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
  const osm = { r: osmR, pk: venuePick(osmR, when, wm) };
  endVenues(osm.pk.picks.length ? "done" : "failed", `${osmR.via ? `${osmR.via} · ${osmR.places.length} within 500 m` : `${osmR.places.length} found within 500 m (${osmR.source}${osmR.live ? "" : ", live call " + (osmR.note?.match(/Overpass (\w+)/)?.[1] ?? "failed")})`} · ${osm.pk.closed} closed at ${londonClock(when.toISOString())} · ${osm.pk.picks.length} kept · ${weatherDecision(wm, osm.pk.picks.map((x) => x.p))}`, osmR.stepSource);
  addSource(sources, osm.r.source, osm.r.asOf);
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
  result.cards = osm.pk.picks.map(({ p, h }): PlanCard => {
    const walk = walkMinutes(metresBetween(result.middle!.location, p.location));
    const addr = addressOf(p.tags);
    const legs: Leg[] = [
      { who: "you", minutes: best.a.minutes, summary: `${best.a.summary} · then ~${walk} min walk (estimate)`, path: best.a.path },
      { who: "them", minutes: best.b.minutes, summary: `${best.b.summary} · then ~${walk} min walk (estimate)`, path: themPath },
    ];
    if (h.state === "unknown") unknowns.push(`${p.tags.name}: opening hours not in OSM.`);
    return {
      id: `osm-${p.type}-${p.id}`,
      kind: "venue",
      name: p.tags.name,
      subtitle: [kindLabel(p.tags), addr].filter(Boolean).join(" · "),
      location: p.location,
      legs,
      facts: [
        fact(`Open ${day}`, h.value, h.verdict, osm.r.source, osm.r.asOf),
        tflFact,
        ...lf,
        wf,
        ...fitFact(p.tags, wm, osm.r, wx),
        fact("Price", ask.budgetGBP ? `Not listed, can't check £${ask.budgetGBP}` : "Not listed", "unknown", "OSM (no price tag)"),
        stepFree(p.tags, osm.r.asOf, osm.r.source),
      ],
      why: `${Math.round(p.distanceM)} m from ${best.hub.name}, the fairest hub (${best.a.minutes} vs ${best.b.minutes} min)${h.verdict === "confirmed" ? "; hours recently checked in OSM" : ""}.`,
      url: p.tags.website ?? p.tags["contact:website"] ?? osmUrl(p),
    };
  });
  if (!result.cards.length) unknowns.push(`No open ${kind}s found within 500 m of ${best.hub.name} in OSM.`);
  result.headline = `${best.hub.name} is the fair middle: you ${best.a.minutes} min, ${who} ${best.b.minutes}.`;
  const top = result.cards[0];
  const lineText = lf[0]?.value.replace(/ · now, as of .*/, "");
  result.draftMessage = top
    ? [
        `${londonLabel(when)} at ${top.name}${addressOf(osm.pk.picks[0].p.tags) ? `, ${addressOf(osm.pk.picks[0].p.tags)}` : ""} (near ${best.hub.name} station)?`,
        `TfL says about ${best.b.minutes} min for you and ${best.a.minutes} for me.`,
        lineText ? `${lineText} right now.` : "",
        !("error" in wx) ? `Forecast: ${wx.value}.` : "",
        osmUrl(osm.pk.picks[0].p),
      ].filter(Boolean).join(" ")
    : `Shall we meet near ${best.hub.name} station, ${londonLabel(when)}? TfL says about ${best.b.minutes} min for you and ${best.a.minutes} for me.`;
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

  type Cand = { kind: "event"; e: SeedEvent } | { kind: "place"; p: OsmPlace; h: ReturnType<typeof hoursAt>; osm: OsmResult };
  const cands: Cand[] = [];
  let osm: OsmResult | null = null;
  let wm: WeatherMode = { mode: "neutral", label: "" }; // weather only re-ranks pubs / cafés / restaurants
  const endFind = begin("venues", venueKind ? `Finding ${venueKind}s near you` : "Finding events and free-entry places near you", venueKind ? "OSM Overpass" : "Luma seed + OSM Overpass");
  if (venueKind) {
    osm = await findVenues(venueKind, ctx.you, 1200);
    wm = weatherMode(await wxP, t);
    const pk = venuePick(osm, when, wm);
    for (const x of pk.picks.concat()) cands.push({ kind: "place", p: x.p, h: x.h, osm });
    endFind(cands.length ? "done" : "failed", `${osm.via ? `${osm.via} · ` : ""}${osm.places.length} ${venueKind}s within 1.2 km (${osm.source}) · ${pk.closed} closed at ${t} · ${weatherDecision(wm, pk.picks.map((x) => x.p))}`, osm.stepSource);
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
    const open = osm.places.map((p) => ({ p, h: hoursAt(p.tags, when, p.location) })).filter((x) => x.h.state !== "closed");
    const closed = osm.places.length - open.length;
    for (const x of open.slice(0, 6)) cands.push({ kind: "place", p: x.p, h: x.h, osm });
    endFind("done", `${mev ? `${mev.via} · ` : ""}${all.length} seed events that day · ${near.length} within 8 km${ask.walkIn ? ` · ${blocked.length} dropped as RSVP-only` : ""} · ${osm.places.length} free-entry places within 2.5 km (${osm.source}), ${closed} closed at ${t}`, mev?.stepSource ?? osm.stepSource);
  }
  if (osm) {
    addSource(sources, osm.source, osm.asOf);
    if (!osm.live && osm.note) unknowns.push(osm.note + ".");
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
  within.sort((a, b) =>
    ask.walkIn || ask.free ? walkScore(a.c) - walkScore(b.c) || a.j.minutes - b.j.minutes : (a.c.kind === "event" ? 0 : 1) - (b.c.kind === "event" ? 0 : 1) || wrC(a.c) - wrC(b.c) || a.j.minutes - b.j.minutes,
  );
  const chosen = within.slice(0, MAX_CARDS);
  const lineIds = [...new Set(chosen.flatMap((x) => x.j.lines.map((l) => l.id)))];
  const endLines = begin("lines", "Checking line status", "TfL");
  const ls = lineIds.length ? await lineStatus(lineIds) : null;
  endLines(!lineIds.length ? "skipped" : ls && !("error" in ls) ? "done" : "failed", !lineIds.length ? "No TfL lines on these routes (walking or bus only)" : ls && !("error" in ls) ? ls.lines.map((l) => `${l.name} ${l.status}`).join(", ") : "Line status didn't load");
  if (ls && !("error" in ls)) addSource(sources, "TfL Line Status", ls.fetchedAt);
  const wx = await wxP;
  if (!("error" in wx)) addSource(sources, "Open-Meteo", wx.fetchedAt);
  const wf = weatherFact(wx, when);
  const day = londonDayShort(when);

  result.cards = chosen.map(({ c, j }): PlanCard => {
    const leg: Leg = { who: "you", minutes: j.minutes, summary: j.summary, path: j.path };
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
        stepFree(p.tags, c.osm.asOf, c.osm.source),
      ],
      why: `${j.minutes} min away by TfL${free ? ", free entry" : ""}${c.h.state === "open" ? `, open at ${t}` : ", hours not listed"}.`,
      url: p.tags.website ?? p.tags["contact:website"] ?? osmUrl(p),
    };
  });
  for (const x of chosen) if (x.c.kind === "place" && x.c.h.state === "unknown") unknowns.push(`${x.c.p.tags.name ?? "A place"}: opening hours not in OSM.`);
  if (chosen.some((x) => x.c.kind === "event")) unknowns.push("Event prices and whether you can walk in: the seed listings don't say.");
  if (lineIds.length) unknowns.push("Line status is as of now, not for the time of the plan.");
  unknowns.push("How busy it'll be: no source has this.");
  const n = result.cards.length;
  const what = ask.walkIn ? "walk-in option" : venueKind ? venueKind === "pub" ? "pub" : venueKind : "option";
  result.headline = n
    ? `${n} ${what}${n > 1 ? "s" : ""} within ${maxMin} min of ${ctx.youName ?? "you"}, ${londonLabel(when)}.`
    : `Nothing open in our data within ${maxMin} min of ${ctx.youName ?? "you"} at ${londonLabel(when)}.`;
  result.draftMessage = n
    ? `${londonLabel(when)}: ` + result.cards.map((c) => `${c.name} (${c.legs[0].minutes} min by TfL)${c.url ? ` ${c.url}` : ""}`).join("; ")
    : "";
  return finish(ctx, result);
}
