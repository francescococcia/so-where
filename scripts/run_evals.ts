// npm run eval — runs evals/plan-evals.json through the real plan handler (live network), prints
// per-case pass/fail and the overall rate, writes evals/last-run.json. Checks are fixed; don't tune them.
import { readFileSync, writeFileSync } from "node:fs";
import { POST } from "@/app/api/plan/route";
import type { PlanResultWithAgent } from "@/lib/plan-types";
import { londonClock, londonDayShort } from "@/lib/london-time";
import { setForecastOverride } from "@/lib/weather";
import { setClockOverride } from "@/lib/plan";
import { londonToday } from "@/lib/dates";
import { londonToUtc } from "@/lib/london-time";
import { gridBbox, hoursAt, OVERPASS_MIRRORS, resetOverpassForTests } from "@/lib/osm";
import { findVenues } from "@/lib/mongo-venues";
import { backtrackPenalty, tidySegments, type LegSegment } from "@/lib/tfl";
import { parsePlanAsk } from "@/lib/ask-local";
import { parseDestination } from "@/lib/destination";
import { buildSuggestedQuery, cleanExtract, type PosterExtract } from "@/lib/poster";
import { eventDates } from "@/lib/destination";
import { allStrings, scrubArea } from "@/lib/venue-area";
import { meetDraft } from "@/lib/draft-message";
import { fairScore, midpointStations } from "@/lib/tfl";
import { STATIONS } from "@/lib/gazetteer";
import { acceptRewrite, buildBlurb, fallbackBlurb, wikiFits, type BlurbInput } from "@/lib/blurb";
import { arrivalClock, isLeaveQuestion, statedOrigin } from "@/lib/leave-time";
import { splitRefine } from "@/lib/refine";
import { metresBetween } from "@/lib/geo";
import { POST as SNAP_POST } from "@/app/api/place-snap/route";
import { cleanSnap, cleanVibe, roundYou, setSnapExtractorForTests, type PlaceSnapResponse, type SnapExtract } from "@/lib/place-snap";
import { resolveLandmark, setLandmarkResolverForTests, type Landmark } from "@/lib/landmark";
import { resetVisionModelForTests, visionGenerate, VISION_FALLBACK } from "@/lib/vision";
import { PLAN_FALLBACK, planGenerate, resetPlanModelForTests } from "@/lib/plan-model";
import { checkCard, setPlanPickerForTests, verifyPicks, type Picker, type VCard } from "@/lib/verify";

// Blurbs (Wikipedia / website / Gemini) are checked by the "server4" unit with mocks; the plan cases skip them.
process.env.BLURBS ??= "off";
// The planner model (Argon) is checked by the "server7" unit with a fixture picker; plan cases use our own
// ranking unless EVAL_ARGON=1 (then the verify loop calls the real PLAN_MODEL; see the timings in the report).
process.env.PLAN_ARGON ??= process.env.EVAL_ARGON ? "on" : "off";

function pinnedNow(hhmm: string): Date {
  const [hh, mm] = hhmm.split(":").map(Number);
  const today = londonToday();
  const t = londonToUtc(today, hh, mm);
  return t.getTime() > Date.now() ? t : londonToUtc(londonToday(new Date(Date.now() + 86_400_000)), hh, mm);
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);

type Expect = { intent?: string; clarify: boolean; missing?: string; middleIn?: string[]; weekday?: string; time?: string; budgetGBP?: number; category?: string; walkIn?: boolean; minCards?: number; themArea?: string; weather?: "wet" | "warm"; clarifySteps?: number; segments?: boolean; noObjects?: boolean; replyMatch?: string[]; seating?: "Outdoor seating" | "Indoor seating"; youCloser?: boolean; dayOffset?: number; openAtPlan?: boolean; hours?: boolean; youStop?: string; replyNot?: string[]; approx?: boolean; cuisine?: string; sameAsBase?: boolean; onlyCuisine?: boolean; headlineMatch?: string; fairBoth?: boolean; /** server13: a compound follow-up, answered in several sentences. */ multiPart?: boolean; /** server13: both journeys at most this many minutes. */ maxLegMin?: number; leaveBy?: { you?: boolean; them?: boolean; arriveBy?: string }; destination?: { kind?: "event" | "venue"; facts?: string[]; legs?: number; /** server8: card within maxM of this point, no such facts, never swapped by verify. */ near?: { lat: number; lng: number; maxM: number }; noFacts?: string[]; landmark?: boolean }; daysAhead?: number; /** server9: venues step detail/source matches; every card within maxM of a point. */ venuesFrom?: string; cardsNear?: { lat: number; lng: number; maxM: number } };
// `answers`: a clarify sequence; each reply is sent as {query: reply, answer: reply, previous: {query: <result.query>, answer: reply}}
// exactly like the UI, and the same clarify must never come back twice. `refines`: follow-up chat turns, each sent as
// {mode:"refine", query: r, previous: {query: <result.query>}} (the accumulated ask from the previous turn). `weather`: injected forecast (no Open-Meteo call).
type Wx = { tempC: number; rainPct: number; rainMm?: number; sunny?: boolean };
// `unit`: in-process checks of a helper (no HTTP): "hours" parses OSM opening_hours, "segments" tidies stretches.
type HoursUnit = { oh: string; date: string; at: string; state: "open" | "closed" | "unknown"; closesAt?: string };
type Case = { id: string; query: string; unit?: "hours" | "segments" | "coarse" | "poster" | "server4" | "server5" | "server6" | "server7" | "server8" | "server9";
  // server6 "snap a place": a fixture extract stands in for Gemini (test hook); the route runs for real (fixture image bytes).
  snap?: { extract: SnapExtract; landmark?: boolean; nearbyQuery?: string; kind?: string; at?: { lat: number; lng: number; maxM: number }; you?: { lat: number; lng: number }; area?: string; place?: string; suggestedQuery?: string; minCandidates?: number; message?: string; firstCandidate?: string; noCandidates?: boolean }; hours?: HoursUnit[]; you?: { lat: number; lng: number }; answer?: string; previous?: { query: string; answer: string }; answers?: string[]; refines?: string[]; focusTop?: boolean; weather?: Wx; clock?: string; expect: Expect };
// `clock`: pin "now" to HH:MM London (today if still ahead, else tomorrow, so live TfL/forecast calls stay in the
// future); `dayOffset` is then the plan's London date minus the pinned date.
type Refined = PlanResultWithAgent & { reply?: string; leaveBy?: { you?: string; them?: string; arriveBy: string; date: string } };
const youMin = (r: PlanResultWithAgent) => r.cards[0]?.legs.find((l) => l.who === "you")?.minutes ?? null;

const all = (JSON.parse(readFileSync("evals/plan-evals.json", "utf8")) as { cases: Case[] }).cases;
// EVAL_ONLY=prefix[,prefix…] runs a subset (last-run.json is then not written).
const only = process.env.EVAL_ONLY;
const cases = only ? all.filter((c) => only.split(",").some((p) => c.id.startsWith(p))) : all;

async function post(body: Record<string, unknown>) {
  const res = await POST(new Request("http://local/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Refined };
}

async function call(c: Case) {
  const t0 = Date.now();
  setForecastOverride(
    c.weather
      ? async () => ({ value: `${c.weather!.tempC}°C, ${c.weather!.rainPct}% chance of rain (eval-injected)`, tempC: c.weather!.tempC, rainPct: c.weather!.rainPct, rainMm: c.weather!.rainMm ?? 0, sunny: c.weather!.sunny ?? false, fetchedAt: new Date().toISOString(), ms: 0 })
      : null,
  );
  const pinned = c.clock ? pinnedNow(c.clock) : null;
  setClockOverride(pinned ? () => pinned : null);
  try {
    let r = await post({ query: c.query, you: c.you, answer: c.answer, previous: c.previous });
    const asked: string[] = [];
    for (const a of c.answers ?? []) {
      if (r.status !== 200 || !r.body.clarify) break;
      asked.push(`${r.body.clarify.missing}: ${r.body.clarify.question}`);
      r = await post({ query: a, you: c.you, answer: a, previous: { query: r.body.query, answer: a } });
    }
    if (r.status === 200 && r.body.clarify && c.answers) asked.push(`${r.body.clarify.missing}: ${r.body.clarify.question}`);
    let focus: { id: string; name: string; lat: number; lng: number } | undefined;
    const base = c.refines ? { youMin: youMin(r.body), query: r.body.query, cards: (r.body.cards ?? []).map((x) => x.id), middle: r.body.middle?.name ?? null } : undefined;
    for (const q of c.refines ?? []) {
      if (r.status !== 200) break;
      const top = c.focusTop ? r.body.cards?.[0] : undefined;
      if (top) focus = { id: top.id, name: top.name, lat: top.location.lat, lng: top.location.lng };
      r = await post({ query: q, mode: "refine", previous: { query: r.body.query, result: r.body }, you: c.you, ...(top ? { focus } : {}) });
    }
    return { ...r, asked, base, pinned, focus, ms: Date.now() - t0 };
  } finally {
    setForecastOverride(null);
    setClockOverride(null);
  }
}

type Chk = { name: string; pass: boolean; got?: unknown };
// server8: landmark resolver fixtures (no Wikidata / Nominatim calls in evals).
const lmFix = (name: string, lat: number, lng: number, tags: Record<string, string> = {}): Landmark => ({ name, location: { lat, lng }, address: null, tags: { name, ...tags }, id: tags.wikidata ? `wd-${tags.wikidata}` : null, source: "Wikidata", asOf: new Date().toISOString(), how: "Wikidata coordinates", verdict: "confirmed", landmark: true });
const LANDMARK_FIXTURES: Record<string, Landmark> = {
  "university of greenwich": lmFix("University of Greenwich", 51.483, -0.006, { wikidata: "Q1896148", wikipedia: "en:University of Greenwich" }),
  "greenwich fixture hall": lmFix("Greenwich Fixture Hall", 51.483, -0.006),
};
async function unitChecks(c: Case): Promise<Chk[]> {
  const out: Chk[] = [];
  const add = (name: string, pass: boolean, got?: unknown) => out.push({ name, pass, ...(got !== undefined ? { got } : {}) });
  if (c.unit === "hours") {
    for (const u of c.hours ?? []) {
      const [hh, mm] = u.at.split(":").map(Number);
      const h = hoursAt({ opening_hours: u.oh }, londonToUtc(u.date, hh, mm), { lat: 51.5, lng: -0.12 });
      add(`"${u.oh}" on ${u.date} ${u.at} → ${u.state}${u.closesAt ? ` until ${u.closesAt}` : ""}`, h.state === u.state && (u.closesAt === undefined || h.closesAt === u.closesAt) && (h.state !== "open" || !h.closesAt || h.value.startsWith(`Open until ${h.closesAt}`)), { state: h.state, closesAt: h.closesAt, value: h.value });
    }
  }
  if (c.unit === "segments") {
    const P = (lat: number, lng: number) => ({ lat, lng });
    const lb = P(51.5049, -0.0863), ls = P(51.5178, -0.0817), bw = P(51.5225, -0.0827);
    const segs: LegSegment[] = [
      { mode: "walking", to: "London Bridge", minutes: 3, path: [P(51.5045, -0.087), lb] },
      { mode: "bus", line: "Bus 388", from: "London Bridge", to: "Liverpool Street", minutes: 8, path: [lb, ls] },
      { mode: "walking", minutes: 3, path: [ls, P(51.519, -0.082)] },
      { mode: "walking", from: "Liverpool Street", to: "Beechwood", minutes: 8, path: [P(51.519, -0.082), bw], est: true },
    ];
    const t = tidySegments(segs, "London Bridge");
    add("back-to-back walks merge into one", t.length === 3 && t[2].mode === "walking" && t[2].minutes === 11 && t[2].to === "Beechwood" && !!t[2].est, t.map((x) => `${x.mode} ${x.minutes}${x.to ? ` → ${x.to}` : ""}`));
    add("no 'walk to <origin stop>' when you're already there", t[0].mode === "walking" && !t[0].to, t[0]);
    add("no walk follows a walk", t.every((x, i) => i === 0 || !(x.mode === "walking" && t[i - 1].mode === "walking")));
    add("a different first stop keeps its name", tidySegments(segs, "Borough")[0].to === "London Bridge");
    const straight = backtrackPenalty([{ mode: "bus", path: [lb, ls] }], lb, bw);
    const loop = backtrackPenalty([{ mode: "walking", path: [lb, P(51.5135, -0.0889)] }, { mode: "bus", path: [P(51.5135, -0.0889), P(51.5052, -0.0866), P(51.4985, -0.0905)] }], lb, bw);
    add("sane route has no backtrack penalty", straight === 0, straight);
    add("bus heading back past the origin is penalised", loop >= 10, loop);
    // Greenwich live case: "3 min walk to Greenwich, Southeastern to London Bridge, 9 min walk to London Bridge, Bus 43 to Moorgate, 8 min walk, 4 min walk"
    const g = P(51.4781, -0.0149), mg = P(51.5186, -0.0886);
    const gw = tidySegments([
      { mode: "walking", to: "Greenwich", minutes: 3, path: [P(51.479, -0.016), g] },
      { mode: "national-rail", line: "Southeastern", from: "Greenwich", to: "London Bridge", minutes: 10, path: [g, lb] },
      { mode: "walking", from: "London Bridge", to: "London Bridge", minutes: 9, path: [lb, P(51.5055, -0.0875)] },
      { mode: "bus", line: "Bus 43", from: "London Bridge", to: "Moorgate", minutes: 12, path: [P(51.5055, -0.0875), mg] },
      { mode: "walking", minutes: 8, path: [mg, P(51.52, -0.09)] },
      { mode: "walking", to: "Polo Bar", minutes: 4, path: [P(51.52, -0.09), P(51.5185, -0.0815)] },
    ], "Greenwich");
    const txt = gw.map((x) => `${x.mode} ${x.minutes}${x.to ? ` → ${x.to}` : ""}`);
    add("intra-station walk between two rides is dropped", !gw.some((x, i) => x.mode === "walking" && i > 0 && i < gw.length - 1), txt);
    add("Greenwich route reads: walk, Southeastern, Bus 43, one final walk", gw.length === 4 && !gw[0].to && gw[3].minutes === 12 && gw[3].to === "Polo Bar", txt);
  }
  if (c.unit === "coarse") {
    const t = (q: string) => parsePlanAsk(q, "2026-10-24");
    const live = t("i wanna meet a friend for a coffe, i'm in greenwich and he lives in ne i dont know the precise position");
    add("'lives in ne' → approximate NE centroid", live.themPlace === "Walthamstow Central" && live.themApprox === "north-east London" && live.category === "cafe", { them: live.themPlace, approx: live.themApprox });
    add("signals don't name their area", !live.signals.some((x) => /walthamstow|north|\bne\b/i.test(x)), live.signals);
    for (const [q, st] of [["coffee with Ana, I'm in Camden, she's in south london", "Brixton"], ["meet Jo, I'm at Bank and she lives in north east london", "Walthamstow Central"], ["meet Al, I'm at Angel, he's in the east somewhere", "Stratford"]] as const)
      add(`"${q}" → ${st} (approx.)`, t(q).themPlace === st && !!t(q).themApprox, t(q).themPlace);
    for (const [q, st] of [["drinks with Sam, I'm at Bank, he's in East Ham", "East Ham"], ["Lunch with Mo, I'm in Soho, he's in West Hampstead", "West Hampstead"]] as const)
      add(`"${st}" stays a real place`, t(q).themPlace === st && !t(q).themApprox, t(q).themPlace);
  }
  if (c.unit === "poster") {
    // A synthetic extracted poster → suggestedQuery → the same fields back out of the plan parser.
    const today = "2026-10-24";
    const base: PosterExtract = { kind: "event", title: "Jazz Night", venueName: "The Vortex Jazz Club", address: "11 Gillett Square, London N16 8AZ", area: "Dalston", date: "2026-10-31", startTime: "19:00", endTime: "23:00", price: "£12", free: false, needsRegistration: true, url: "https://vortexjazz.co.uk", confidence: 0.95, notes: null, endDate: null };
    const q = buildSuggestedQuery(base);
    add("event poster → 'Get me to <title> at <venue>, <address> on Sat 31 Oct at 19:00'", q === "Get me to Jazz Night at The Vortex Jazz Club, 11 Gillett Square, London N16 8AZ on Sat 31 Oct at 19:00–23:00 (£12, sign-up needed)", q);
    const d = q ? parseDestination(q) : null;
    const a = parsePlanAsk(d?.rest ?? "", today);
    add("round-trip: title, venue, address, end time, price, sign-up", d?.title === "Jazz Night" && d.venue === "The Vortex Jazz Club" && /N16 8AZ/.test(d.address ?? "") && d.endTime === "23:00" && d.priceText === "£12" && d.signUp === true, d);
    add("round-trip: date 2026-10-31, time 19:00", a.date === "2026-10-31" && a.time === "19:00", { date: a.date, time: a.time });
    const h = buildSuggestedQuery(base, { query: "I'm at Old Street and Sam's in Clapham" });
    const hd = h ? parseDestination(h) : null;
    const ha = parsePlanAsk(hd?.rest ?? "", today);
    add("with halfway context → 'Meet halfway for …' + both places", !!h?.startsWith("Meet halfway for Jazz Night at The Vortex Jazz Club") && hd?.withThem === true && !!ha.youPlace && !!ha.themPlace, { h, you: ha.youPlace, them: ha.themPlace });
    const free = buildSuggestedQuery({ ...base, title: "Live on Sunday", venueName: "Borough Market", address: "8 Southwark St, SE1 1TL", date: "2026-11-06", startTime: "17:00", endTime: null, price: null, free: true, needsRegistration: false });
    const fd = free ? parseDestination(free) : null;
    add("title with 'on Sunday' doesn't cut the place; free + no sign-up kept", /^Live on\u2060? Sunday$/.test(fd?.title ?? "") && fd?.venue === "Borough Market" && fd?.free === true && fd?.signUp === false, { free, fd });
    const venue = buildSuggestedQuery({ ...base, kind: "venue", title: null, date: null, startTime: null, endTime: null, price: null, needsRegistration: null });
    add("venue sign → 'Get me to <venue>, <address>'", venue === "Get me to The Vortex Jazz Club, 11 Gillett Square, London N16 8AZ", venue);
    add("nothing to route to → null", buildSuggestedQuery({ ...base, kind: "other", venueName: null, address: null, area: null }) === null);
    const generic = ["meet halfway for coffee, i'm at bank and she's in camden", "get me to a pub near Angel", "directions to the nearest pub", "meet halfway for a drink at 7pm with Sam", "how do i get to the middle"].filter((q) => parseDestination(q));
    add("category / search asks are not fixed destinations", generic.length === 0, generic);
    const dd = parseDestination("meet halfway for dinner at Dishoom tonight, I'm at Bank, she's in Camden");
    add("'dinner at Dishoom, I'm at …' → venue Dishoom, no title, people stay in rest", dd?.venue === "Dishoom" && dd.title === null && dd.address === null && /bank/i.test(dd.rest), dd);
    const ce = cleanExtract({ kind: "event", title: "X", date: "2025-10-31", startTime: "7.30", confidence: 3, url: "vortexjazz.co.uk" }, today);
    add("cleanExtract: past-year date rolls forward, 7.30 → 07:30, confidence clamped, url gets https", ce.date === "2026-10-31" && ce.startTime === "07:30" && ce.confidence === 1 && ce.url === "https://vortexjazz.co.uk", ce);
  }
  if ((c.unit === "server6" || c.unit === "server7" || c.unit === "server8") && c.snap) {
    const sn = c.snap;
    setSnapExtractorForTests(async () => sn.extract);
    if (c.unit === "server8") setLandmarkResolverForTests(async (n) => LANDMARK_FIXTURES[n.toLowerCase()] ?? null);
    try {
      const img = `data:image/jpeg;base64,${Buffer.from("fixture shopfront photo ".repeat(12)).toString("base64")}`;
      const res = await SNAP_POST(new Request("http://local/api/place-snap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ image: img, ...(sn.you ? { you: sn.you } : {}), ...(sn.area ? { area: sn.area } : {}) }) }));
      const b = (await res.json()) as PlaceSnapResponse;
      add("HTTP 200", res.status === 200, res.status);
      add("extracted echoed", b.extracted?.name === sn.extract.name, b.extracted);
      add("model reported", b.model === "test-fixture", b.model);
      const json = JSON.stringify(b);
      if (sn.you) add("your coordinates are not echoed", !json.includes(String(sn.you.lat)) && !json.includes(String(sn.you.lng)), null);
      if (sn.place) {
        const p = b.place;
        add(`place = ${sn.place}`, p?.name === sn.place, p?.name ?? b.message);
        add("card shape: id, lat/lng, address, area, hours fields, photoQuery", !!p && !!p.id && typeof p.lat === "number" && typeof p.lng === "number" && "address" in p && "openAtPlan" in p && "closesAt" in p && "closingSoon" in p && "hoursKnown" in p && "opensAt" in p && (p.openAtPlan !== false || !!p.opensAt) && p.photoQuery.startsWith("/api/photo?"), p && { openAtPlan: p.openAtPlan, closesAt: p.closesAt, opensAt: p.opensAt, hoursKnown: p.hoursKnown });
        add("blurb doesn't restate the address", !p?.blurb || !/located at|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b|\d+\s+\w+\s+(?:Street|St|Road|Rd)\b/.test(p.blurb.text), p?.blurb?.text);
        if (sn.extract.vibe) add("vibe kept; blurb using it is labelled 'your photo', no ratings", JSON.stringify(b.extracted.vibe) === JSON.stringify(sn.extract.vibe) && (!p?.blurb?.fromPhoto || /your photo/i.test(p.blurb.source.name)) && !/rated|stars?\b|reviews?/i.test(p?.blurb?.text ?? ""), p?.blurb);
      } else add("no place when unsure", !b.place, b.place?.name);
      if (sn.suggestedQuery) add(`suggestedQuery = "${sn.suggestedQuery}"`, b.suggestedQuery === sn.suggestedQuery, b.suggestedQuery);
      if (sn.minCandidates) add(`${sn.minCandidates}–3 candidates, each with a 'Meet at' query`, (b.candidates?.length ?? 0) >= sn.minCandidates && (b.candidates?.length ?? 0) <= 3 && b.candidates!.every((x) => x.suggestedQuery.startsWith(`Meet at ${x.name}`)), b.candidates?.map((x) => x.suggestedQuery));
      if (sn.message) add(`message matches /${sn.message}/`, new RegExp(sn.message).test(b.message ?? ""), b.message);
      if (c.unit === "server7") {
        add("vibe kept in the response", JSON.stringify(b.extracted.vibe ?? null) === JSON.stringify(sn.extract.vibe ?? null), b.extracted.vibe);
        if (sn.firstCandidate) add(`first candidate = ${sn.firstCandidate}`, b.candidates?.[0]?.name === sn.firstCandidate, b.candidates?.map((x) => x.name));
        if (sn.noCandidates) add("no candidates without a location", !b.candidates?.length, b.candidates?.length);
        const at = sn.you ?? null;
        if (at && b.candidates?.length) add("every candidate within ~250 m (+100 m rounding)", b.candidates.every((x) => metresBetween(at, x) <= 350), b.candidates.map((x) => Math.round(metresBetween(at, x))));
      }
      if (c.unit === "server8") {
        const p = b.place;
        add("landmark echoed in extracted", JSON.stringify(b.extracted.landmark ?? null) === JSON.stringify(sn.extract.landmark ?? null), b.extracted.landmark);
        if (sn.kind) add(`place.kind = ${sn.kind}`, p?.kind === sn.kind, p?.kind);
        if (sn.at) add(`place within ${sn.at.maxM} m of ${sn.at.lat}, ${sn.at.lng}`, !!p && metresBetween(p, sn.at) <= sn.at.maxM, p && { lat: p.lat, lng: p.lng });
        if (sn.landmark) {
          add("landmark: no hours (hoursKnown false, no open/closed, no Open fact)", !!p && p.hoursKnown === false && p.openAtPlan === null && p.closesAt === null && p.opensAt === null && !p.facts.some((f) => /^Open\b/.test(f.label)), p && { hoursKnown: p.hoursKnown, openAtPlan: p.openAtPlan, facts: p.facts.map((f) => f.label) });
          add("landmark: area set, no candidates", !!p?.area && !b.candidates?.length, { area: p?.area, candidates: b.candidates?.length });
          add("landmark blurb (if any) is sourced, no address restated", !p?.blurb || (!!p.blurb.source?.name && !/located at|\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/.test(p.blurb.text)), p?.blurb);
        }
        if (sn.nearbyQuery) add(`nearbyQuery = "${sn.nearbyQuery}"`, b.nearbyQuery === sn.nearbyQuery, b.nearbyQuery);
        else add("no nearbyQuery", b.nearbyQuery === undefined, b.nearbyQuery);
      }
    } finally {
      setSnapExtractorForTests(null);
      setLandmarkResolverForTests(null);
    }
  }
  if (c.unit === "server6" && !c.snap) {
    setSnapExtractorForTests(async () => ({ name: "X", kind: "pub", signText: null, cuisine: null, confidence: 0.9 }));
    try {
      const post = (body: unknown) => SNAP_POST(new Request("http://local/api/place-snap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      const gif = await post({ image: `data:image/gif;base64,${"R0lGOD".repeat(40)}` });
      const tiny = await post({ image: "data:image/png;base64,iVBORw0KGgo=" });
      const none = await post({ you: { lat: 51.5, lng: -0.1 } });
      add("validation: gif → 415, tiny → 400, no image → 400", gif.status === 415 && tiny.status === 400 && none.status === 400, [gif.status, tiny.status, none.status]);
    } finally {
      setSnapExtractorForTests(null);
    }
    // Vision model: gemini-4-argon first; 404/permission → gemini-3-flash-preview, cached; a bad-image 400 doesn't switch.
    resetVisionModelForTests();
    const saved = process.env.VISION_MODEL;
    delete process.env.VISION_MODEL;
    const seen: string[] = [];
    const fake = (async (u: string | URL | Request) => {
      const m = /models\/([^:]+):/.exec(String(u))?.[1] ?? "";
      seen.push(m);
      return m === "gemini-4-argon" ? new Response('{"error":{"status":"NOT_FOUND","message":"models/gemini-4-argon is not found"}}', { status: 404 }) : new Response("{}", { status: 200 });
    }) as typeof fetch;
    const v1 = await visionGenerate({}, "k", 2000, { fetch: fake });
    const v2 = await visionGenerate({}, "k", 2000, { fetch: fake });
    add("vision: argon 404 → falls back to flash, decision cached", v1.model === VISION_FALLBACK && v2.model === VISION_FALLBACK && JSON.stringify(seen) === JSON.stringify(["gemini-4-argon", VISION_FALLBACK, VISION_FALLBACK]), seen);
    resetVisionModelForTests();
    const bad = (async () => new Response('{"error":{"message":"Unable to process input image"}}', { status: 400 })) as unknown as typeof fetch;
    const v3 = await visionGenerate({}, "k", 2000, { fetch: bad });
    add("vision: a bad-image 400 keeps argon (no fallback)", v3.model === "gemini-4-argon" && v3.res.status === 400, v3.model);
    resetVisionModelForTests();
    if (saved !== undefined) process.env.VISION_MODEL = saved;
    // Photo vibe: only visible things, no ratings; the blurb uses it labelled "Your photo".
    const vb = cleanVibe({ tags: ["Cosy", "hanging baskets", "5 stars", "top-rated", "cosy"], line: "Rated 4.5 stars by locals" });
    add("vibe: ratings dropped from tags and line, duplicates merged", JSON.stringify(vb) === JSON.stringify({ tags: ["cosy", "hanging baskets"], line: "" }), vb);
    const vl = cleanVibe({ tags: [], line: "Corner pub with hanging baskets and a few tables outside, under a striped awning in the sun." });
    add("vibe: line ≤90 chars", !!vl && vl.line.length <= 90 && vl.line.startsWith("Corner pub with hanging baskets"), vl);
    const nofetch = (async () => new Response("{}", { status: 404 })) as unknown as typeof fetch;
    const photo = { tags: ["hanging baskets", "outdoor seating"], line: "Corner pub with hanging baskets and a few tables outside" };
    const pin = { id: "osm-node-9", name: "The Test Arms", kind: "Pub", tags: {}, location: { lat: 51.5, lng: -0.11 }, photo };
    const pb = await buildBlurb(pin, "friends", { llm: null, fetch: nofetch });
    add("photo-only blurb: the photo's line, source 'Your photo'", pb.text === "Corner pub with hanging baskets and a few tables outside." && pb.source.name === "Your photo" && pb.fromPhoto === true, pb);
    const rated = await buildBlurb({ ...pin, id: "osm-node-10" }, "friends", { llm: async () => ({ text: "Top-rated corner pub with 5 stars and hanging baskets." }), fetch: nofetch });
    add("a rewrite with ratings is rejected (falls back to the photo line)", !/rated|stars/i.test(rated.text) && rated.source.name === "Your photo", rated.text);
    const used = await buildBlurb({ ...pin, id: "osm-node-11", tags: { cuisine: "thai" } }, "friends", { llm: async () => ({ text: "Friendly corner pub with hanging baskets out front and Thai food inside." }), fetch: nofetch });
    add("a rewrite using the photo is labelled '<source> + your photo'", used.fromPhoto === true && / \+ your photo$/.test(used.source.name), used.source);
    const ry = roundYou({ lat: 51.504412, lng: -0.109104 });
    add("you rounded to ~100 m; outside London / junk → null", ry?.lat === 51.504 && ry.lng === -0.109 && roundYou({ lat: 48.85, lng: 2.35 }) === null && roundYou("51.5,-0.1") === null, ry);
    const yes = ["Meet at The Kings Arms", "let's meet at The George Inn tomorrow at 7pm", "Get me to The Kings Arms, 25 Roupell Street, SE1 8TB"].filter((q) => !parseDestination(q));
    add("'meet at <name>' / 'get me to <name>' are fixed destinations", yes.length === 0, yes);
    const no = ["meet at 7pm with Sam", "meet at a pub near angel", "meet at mine", "meet at the station"].filter((q) => parseDestination(q));
    add("'meet at 7pm / a pub near … / mine' are not", no.length === 0, no);
    const sr = splitRefine("pubs near bank tonight; refine: cheaper; refine: meet at The Kings Arms; refine: at 8pm");
    add("refine 'meet at <place>' becomes the new base (day kept); later refinements still apply", sr.base === "meet at The Kings Arms tonight" && JSON.stringify(sr.refinements) === JSON.stringify(["at 8pm"]), sr);
    const hw = splitRefine("Drinks with Priya on Friday at 7, I'm at Old Street, she's at Clapham; refine: cheaper; refine: meet at The Kings Arms");
    add("…and keeps who's where + day/time, so it stays a two-person trip", hw.base === "meet at The Kings Arms on Friday at 7, I'm at Old Street, she's at Clapham" && parseDestination(hw.base)?.withThem === true, hw.base);
  }
  if (c.unit === "server7" && !c.snap) {
    // Planner model: Argon first; 404 → flash (cached); over the latency guard → flash for that call only.
    resetPlanModelForTests();
    const saved = process.env.PLAN_MODEL;
    delete process.env.PLAN_MODEL;
    const seen: string[] = [];
    const nf = (async (u: string | URL | Request) => {
      const m = /models\/([^:]+):/.exec(String(u))?.[1] ?? "";
      seen.push(m);
      return m === "gemini-4-argon" ? new Response('{"error":{"status":"NOT_FOUND","message":"models/gemini-4-argon is not found"}}', { status: 404 }) : new Response("{}", { status: 200 });
    }) as typeof fetch;
    const p1 = await planGenerate({}, "k", 3000, { fetch: nf });
    const p2 = await planGenerate({}, "k", 3000, { fetch: nf });
    add("planner: argon 404 → flash, decision cached", p1.model === PLAN_FALLBACK && p2.model === PLAN_FALLBACK && JSON.stringify(seen) === JSON.stringify(["gemini-4-argon", PLAN_FALLBACK, PLAN_FALLBACK]), seen);
    resetPlanModelForTests();
    const slowSeen: string[] = [];
    const slow = (async (u: string | URL | Request, init?: RequestInit) => {
      const m = /models\/([^:]+):/.exec(String(u))?.[1] ?? "";
      slowSeen.push(m);
      if (m !== "gemini-4-argon") return new Response("{}", { status: 200 });
      const hold = setTimeout(() => {}, 10_000); // AbortSignal.timeout's timer is unref'd; keep the loop alive like a socket would
      return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => (clearTimeout(hold), rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })))));
    }) as typeof fetch;
    const g1 = await planGenerate({}, "k", 5000, { fetch: slow, guardMs: 300 });
    const g2 = await planGenerate({}, "k", 5000, { fetch: slow, guardMs: 300 });
    add("planner: argon over the guard → flash for that call, argon tried again next call", g1.guarded && g1.model === PLAN_FALLBACK && g2.guarded && JSON.stringify(slowSeen) === JSON.stringify(["gemini-4-argon", PLAN_FALLBACK, "gemini-4-argon", PLAN_FALLBACK]), { slowSeen, ms: g1.ms });
    resetPlanModelForTests();
    if (saved !== undefined) process.env.PLAN_MODEL = saved;

    // Verification loop on synthetic cards.
    const card = (id: string, name: string, h: Partial<VCard>, facts: { label: string; value: string; verdict?: string }[] = []): VCard => ({
      id, kind: "venue", name, subtitle: "Pub", location: { lat: 51.5, lng: -0.1 }, why: "test",
      legs: [{ who: "you", minutes: 12, summary: "test" }],
      facts: [{ label: "Travel", value: "TfL planner: 12 min", verdict: "confirmed", source: "TfL" }, ...facts.map((f) => ({ verdict: "confirmed", source: "OSM", ...f }))] as VCard["facts"],
      openAtPlan: true, closesAt: "23:00", closingSoon: false, hoursKnown: true, ...h,
    } as VCard);
    const pool = () => [
      card("osm-node-1", "The Early Bird", { closesAt: "19:30", closingSoon: true }),
      card("osm-node-2", "The Crown", {}),
      card("osm-node-3", "The Swan", {}),
      card("osm-node-4", "The Lamb", {}),
      card("osm-node-5", "The Ship", {}, [{ label: "Weather fit", value: "Rain likely at 19:00 (80%) - outdoor only per OSM" }]),
    ];
    const steps: { id: string; label: string; detail?: string }[] = [];
    const begin = (id: string, label: string) => { const s: { id: string; label: string; detail?: string } = { id, label }; steps.push(s); return (_st: string, d?: string) => { if (d) s.detail = d; }; };
    const at = new Date();
    const opts = { begin, query: "pub near me at 7pm", when: at, whenLabel: "Sun 19:00", max: 3 };
    const calls: { failures?: string[]; allowed?: string[]; ids: string[] }[] = [];
    const fixture = (answers: string[][]): Picker => async (x) => {
      const ids = answers[calls.length] ?? [];
      calls.push({ failures: x.failures, allowed: x.allowed, ids });
      return { ids, reasons: ids.map(() => "fits"), model: "gemini-4-argon", ms: 5 };
    };
    add("checks: closes 19:30 is a hard failure; outdoor-only in rain too", JSON.stringify(checkCard(pool()[0]).hard) === JSON.stringify(["closes 19:30"]) && checkCard(pool()[4]).hard[0] === "outdoor only, rain likely", [checkCard(pool()[0]), checkCard(pool()[4])]);
    setPlanPickerForTests(fixture([["osm-node-1", "osm-node-2", "osm-node-3"], ["osm-node-4"]]));
    try {
      const v = await verifyPicks(pool(), opts);
      const st = steps.find((s) => s.id === "recheck");
      add("argon's top closes 19:30 → failures sent back once → re-picked from passing options", calls.length === 2 && !!calls[1].failures?.[0]?.includes("closes 19:30") && !calls[1].allowed!.includes("osm-node-1") && !calls[1].allowed!.includes("osm-node-5"), calls);
      add("step: 'Argon re-checked: swapped The Early Bird (closes 19:30) for The Lamb'", st?.label === "Argon re-checked: swapped The Early Bird (closes 19:30) for The Lamb", st);
      add("verify field: rounds 2, swapped [{from,to,reason}], model", JSON.stringify(v.verify) === JSON.stringify({ rounds: 2, swapped: [{ from: "The Early Bird", to: "The Lamb", reason: "closes 19:30" }], model: "gemini-4-argon" }), v.verify);
      add("final cards: the re-pick first, then argon's passing picks", JSON.stringify(v.cards.map((c) => c.name)) === JSON.stringify(["The Lamb", "The Crown", "The Swan"]), v.cards.map((c) => c.name));
      // Never fabricate: an id that isn't in the pool is never a card; a re-pick naming a failing option is overruled.
      calls.length = 0; steps.length = 0;
      setPlanPickerForTests(fixture([["osm-node-999", "osm-node-3"], ["osm-node-5"]]));
      const f = await verifyPicks(pool(), opts);
      add("invented id → re-pick; a failing re-pick is overruled by the best passing option", f.cards.every((c) => /^osm-node-[1-5]$/.test(c.id)) && f.cards[0].id === "osm-node-2" && f.verify.swapped[0]?.from === "an option not in our data" && f.verify.model === "gemini-4-argon", { cards: f.cards.map((c) => c.id), verify: f.verify });
      // No Argon (off / failed): our own order; only hard failures swap; model "rules".
      setPlanPickerForTests(async () => null);
      steps.length = 0;
      const r = await verifyPicks(pool(), opts);
      add("without argon: closing-soon top swapped by rules, model 'rules', one round", JSON.stringify(r.cards.map((c) => c.id)) === JSON.stringify(["osm-node-4", "osm-node-2", "osm-node-3"]) && r.verify.model === "rules" && r.verify.rounds === 1 && r.verify.swapped[0]?.reason === "closes 19:30", { cards: r.cards.map((c) => c.id), verify: r.verify });
      // Step-free asked: a card tagged wheelchair=no fails.
      add("step-free asked: wheelchair=no fails; untagged is only soft", checkCard(card("a", "A", {}, [{ label: "Step-free", value: "Wheelchair access: no (OSM tag)", verdict: "likely" }]), { stepFree: true }).hard[0] === "not step-free (OSM)" && checkCard(card("b", "B", {}, [{ label: "Step-free", value: "Not tagged in OSM", verdict: "unknown" }]), { stepFree: true }).hard.length === 0, null);
      // End to end through the route: the fixture picker invents an id; the plan still only shows real options.
      steps.length = 0;
      setPlanPickerForTests(async (x) => ({ ids: ["osm-node-424242", ...x.candidates.slice(1, 3).map((c) => c.id)], reasons: [], model: "gemini-4-argon", ms: 1 }));
      const e = await post({ query: "Pubs near me tonight", you: { lat: 51.5256, lng: -0.0875 } });
      const b = e.body as Refined & { verify?: { rounds: number; swapped: { from: string; to: string; reason: string }[]; model: string } };
      const sw = b.steps?.find((s) => s.id === "recheck");
      add("route: verify field present, invented id swapped for a real option, streamed step label", e.status === 200 && b.cards.length > 0 && b.cards.length <= 3 && !b.cards.some((c) => c.id.includes("424242")) && b.verify?.rounds === 2 && b.verify.swapped[0]?.from === "an option not in our data" && /^Argon re-checked: swapped an option not in our data \(not in the checked options\) for /.test(sw?.label ?? ""), { cards: b.cards?.map((c) => c.name), verify: b.verify, step: sw?.label });
      add("route: the draft follows the final top pick", !b.cards[0] || b.draftMessage.includes(b.cards[0].name), b.draftMessage);
    } finally {
      setPlanPickerForTests(null);
    }
  }
  if (c.unit === "server8" && !c.snap) {
    const cs = cleanSnap({ name: null, kind: "other", signText: "UNIVERSITY OF GREENWICH", confidence: 0, landmark: { name: "  University of   Greenwich ", confidence: 1.7 } });
    add("cleanSnap: landmark name tidied, confidence clamped", cs.landmark?.name === "University of Greenwich" && cs.landmark.confidence === 1, cs.landmark);
    add("cleanSnap: missing / junk landmark → null", cleanSnap({ kind: "pub", confidence: 0.9 }).landmark === null && cleanSnap({ kind: "pub", confidence: 0.9, landmark: { name: "", confidence: 0.9 } }).landmark === null && cleanSnap({ kind: "pub", confidence: 0.9, landmark: "x" }).landmark === null, null);
    // Resolver with a fake network: Wikidata's first hit is outside London (skipped), the second is in London.
    const urls: string[] = [];
    const fake = (async (u: string | URL | Request) => {
      const url = String(u);
      urls.push(url);
      const j = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("wbsearchentities")) return j({ search: /greenwich/i.test(decodeURIComponent(url)) ? [{ id: "Q1", label: "University of Greenwich" }, { id: "Q2", label: "University of Greenwich" }] : [] });
      if (url.includes("wbgetentities")) return j({ entities: { Q1: { claims: { P625: [{ mainsnak: { datavalue: { value: { latitude: 51.3, longitude: 0.5 } } } }] } }, Q2: { labels: { en: { value: "University of Greenwich" } }, sitelinks: { enwiki: { title: "University of Greenwich" } }, claims: { P625: [{ mainsnak: { datavalue: { value: { latitude: 51.4831, longitude: -0.0061 } } } }] } } } });
      if (url.includes("nominatim")) return j(/natural/i.test(decodeURIComponent(url)) ? [{ lat: "51.4967", lon: "-0.1764", name: "Natural History Museum", osm_type: "way", osm_id: 1, address: { house_number: "Cromwell Road", postcode: "SW7 5BD" } }] : []);
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    const g = await resolveLandmark("University of Greenwich", { fetch: fake, skipTfl: true });
    add("resolveLandmark: Wikidata P625 inside London (outside-London hit skipped), wikipedia tag kept", !!g && g.source === "Wikidata" && Math.abs(g.location.lat - 51.483) < 0.002 && Math.abs(g.location.lng + 0.006) < 0.002 && g.tags.wikipedia === "en:University of Greenwich" && g.landmark === true, g);
    const nh = await resolveLandmark("Natural History Museum", { fetch: fake, skipTfl: true });
    add("resolveLandmark: Nominatim fallback, London viewbox bounded, a real User-Agent, address", !!nh && nh.source === "OSM Nominatim" && !!nh.address && urls.some((u) => u.includes("nominatim") && u.includes("bounded=1") && u.includes("viewbox=-0.52,51.70,0.34,51.28")), { nh, urls: urls.filter((u) => u.includes("nominatim")) });
    add("resolveLandmark: nothing → null", (await resolveLandmark("Blorptastic Hall", { fetch: fake, skipTfl: true })) === null, null);
    // "Meet at <landmark>" through the plan route: Atlas / Nominatim miss, the landmark resolver places it.
    setLandmarkResolverForTests(async (n) => LANDMARK_FIXTURES[n.toLowerCase()] ?? null);
    try {
      const e = await post({ query: "Meet at Greenwich Fixture Hall from Old Street tomorrow at 2pm" });
      const r = e.body as Refined & { verify?: { swapped: unknown[] } };
      const k = r.cards?.[0];
      add("plan: one fixed card at the landmark (≤150 m), no middle search", e.status === 200 && !r.clarify && r.cards.length === 1 && !!k && metresBetween(k.location, { lat: 51.483, lng: -0.006 }) <= 150 && !r.middle && !r.steps.some((s) => s.id === "compare" || s.id === "venues"), { status: e.status, cards: r.cards?.map((x) => [x.name, x.location]), headline: r.headline });
      add("plan: no hours checks (no Open fact, no 'opening hours' unknown, hoursKnown false), Landmark subtitle", !!k && !k.facts.some((f) => /^Open\b/.test(f.label)) && !r.unknowns.some((u) => /opening hours/i.test(u)) && (k as { hoursKnown?: boolean }).hoursKnown === false && /^Landmark/.test(k.subtitle), k && { facts: k.facts.map((f) => f.label), unknowns: r.unknowns, subtitle: k.subtitle });
      add("plan: never swapped by verify", !r.verify || r.verify.swapped.length === 0, r.verify);
      add("plan: place step names Wikidata", /Wikidata/.test(r.steps.find((s) => s.id === "place")?.detail ?? ""), r.steps.find((s) => s.id === "place")?.detail);
    } finally {
      setLandmarkResolverForTests(null);
    }
  }
  if (c.unit === "server9") {
    // Thin Atlas result (Atlas only holds the central hubs): the bundled snapshot, then live Overpass, top it up.
    const thin = (n = 0) => ({ places: [], source: "MongoDB Atlas (OSM snapshot 24 Oct)", asOf: "2026-10-24T19:44:45.780Z", live: false, ms: 1, note: "Venues come from the OSM snapshot of 24 Oct stored in MongoDB Atlas, not a live Overpass call", via: `Searched ${n} venues in MongoDB Atlas (2dsphere $geoNear)`, stepSource: "MongoDB Atlas $geoNear" });
    const calls: string[] = [];
    let mode: "ok" | "hang" = "ok";
    const fake = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      calls.push(`${new URL(url).host} ${decodeURIComponent(String(init?.body ?? ""))}`);
      if (mode === "hang") return new Promise<Response>((_, rej) => init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
      if (url.includes("overpass-api.de")) throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      if (url.includes("kumi")) return new Response("busy", { status: 429 });
      const el = (id: number, lat: number, lng: number, name: string, oh?: string) => ({ type: "node", id, lat, lon: lng, tags: { amenity: "cafe", name, cuisine: "coffee_shop", ...(oh ? { opening_hours: oh } : {}) } });
      return new Response(JSON.stringify({ elements: [el(9001, 51.6501, -0.2001, "Fixture Beans", "Mo-Su 08:00-18:00"), el(9002, 51.6505, -0.2010, "Fixture Brew", "Mo-Su 07:00-17:00"), el(9003, 51.6490, -0.1995, "Fixture Cup"), { type: "way", id: 9004, center: { lat: 51.6503, lon: -0.2003 }, tags: { amenity: "pub", name: "Not A Cafe" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const deps = { fetch: fake, mirrors: OVERPASS_MIRRORS };
    resetOverpassForTests();
    add("mirrors in order: overpass-api.de, overpass.kumi.systems, overpass.private.coffee", OVERPASS_MIRRORS.map((u) => new URL(u).host).join(",") === "overpass-api.de,overpass.kumi.systems,overpass.private.coffee" || !!process.env.OVERPASS_URLS || !!process.env.OVERPASS_URL, OVERPASS_MIRRORS);
    // Greenwich: Atlas empty → the bundled snapshot (outer-hub extract) has enough, so no live call.
    const GREENWICH = { lat: 51.4831, lng: -0.0061 };
    const g = await findVenues("cafe", GREENWICH, 1200, { mongo: thin(2765), overpass: deps });
    add("Greenwich: Atlas empty → ≥3 cafés from the bundled snapshot, no live call", g.places.length >= 3 && calls.length === 0 && /bundled OSM snapshot/.test(g.via ?? "") && !!g.more?.some((m) => m.source === "OSM snapshot"), { n: g.places.length, via: g.via, calls: calls.length });
    // Nowhere in Atlas or the snapshot: live Overpass, first two mirrors fail, the third answers.
    const FAR = { lat: 51.65, lng: -0.2 };
    const f = await findVenues("cafe", FAR, 600, { mongo: thin(2765), overpass: deps });
    add("live fallback: mirrors tried in order until one answers", calls.map((x) => x.split(" ")[0]).join(",") === "overpass-api.de,overpass.kumi.systems,overpass.private.coffee", calls.map((x) => x.split(" ")[0]));
    const bb = gridBbox(FAR, 600);
    add("live query: cafe filter inside the grid-snapped bbox, timeout 6", /\[timeout:6\]/.test(calls[0] ?? "") && calls[0].includes('nwr["amenity"="cafe"]["name"]') && calls[0].includes(`(${bb.join(",")})`), calls[0]);
    add("gridBbox covers the circle", metresBetween(FAR, { lat: bb[0], lng: FAR.lng }) >= 600 && metresBetween(FAR, { lat: bb[2], lng: FAR.lng }) >= 600 && metresBetween(FAR, { lat: FAR.lat, lng: bb[1] }) >= 600 && metresBetween(FAR, { lat: FAR.lat, lng: bb[3] }) >= 600, bb);
    add("live venues mapped into the venue shape (cafés only, sorted, distances)", f.places.length === 3 && f.places.every((p) => p.tags.amenity === "cafe" && p.type === "node" && typeof p.distanceM === "number") && f.places[0].distanceM <= f.places[2].distanceM, f.places.map((p) => [p.tags.name, Math.round(p.distanceM)]));
    const beans = f.places.find((p) => p.tags.name === "Fixture Beans");
    const at11 = londonToUtc("2026-10-26", 11, 0);
    add("hours from live OSM parsed by osm.ts (open at 11:00, until 18:00)", !!beans && hoursAt(beans.tags, at11, beans.location).state === "open" && hoursAt(beans.tags, at11, beans.location).closesAt === "18:00", beans && hoursAt(beans.tags, at11, beans.location));
    add("step detail says 'OSM live (Overpass, <mirror>)'; sources list it; live, no snapshot-only note", /OSM live \(Overpass, overpass\.private\.coffee\)/.test(f.via ?? "") && /OSM live \(Overpass\)/.test(f.stepSource ?? "") && !!f.more?.some((m) => m.source === "OSM live (Overpass)") && f.live && !f.note, { via: f.via, stepSource: f.stepSource, more: f.more, note: f.note });
    const before = calls.length;
    const f2 = await findVenues("cafe", { lat: 51.6502, lng: -0.2001 }, 600, { mongo: thin(2765), overpass: deps });
    add("10-min in-process cache keyed by grid bbox + category (nearby repeat: no new call)", calls.length === before && f2.places.length === 3 && /cached/.test(f2.via ?? ""), { calls: calls.length - before, via: f2.via });
    await findVenues("restaurant", FAR, 600, { mongo: thin(2765), overpass: deps });
    add("a different category is a different cache key", calls.length > before, calls.length - before);
    // Budget: every mirror hangs → per-mirror timeout and the total budget stop it.
    resetOverpassForTests();
    mode = "hang";
    const t0 = Date.now();
    const h = await findVenues("cafe", FAR, 600, { mongo: thin(2765), overpass: { ...deps, perMirrorMs: 250, budgetMs: 600 } });
    const took = Date.now() - t0;
    add("budget: hung mirrors stop within the total budget; Atlas result kept with the failure in the detail", took < 1500 && h.places.length === 0 && /live Overpass failed/.test(h.via ?? "") && !h.live, { took, via: h.via });
    resetOverpassForTests();
    add("snapshot file under 8 MB", readFileSync("src/data/osm-snapshot.json").length < 8_000_000, readFileSync("src/data/osm-snapshot.json").length);
  }
  if (c.unit === "server5") {
    const today = "2026-10-25";
    // "When do I leave?" follow-ups (typos included) vs real refinements.
    for (const q of ["a what time i need to leave form my hose?", "how early should I set off?", "what time do we need to leave to get there on time?", "arrive by 11:30", "and if I want to arrive at 11:30?", "wat tim shoud i leve tomorow", "when should i head out"]) add(`leave question: "${q}"`, isLeaveQuestion(q), q);
    for (const q of ["closer to me", "is it open?", "a pub instead", "make it 8pm somewhere quieter", "cheaper", "other options?", "any italian coffee nearby?"]) add(`not a leave question: "${q}"`, !isLeaveQuestion(q), q);
    add("arrive at 11:30 near a noon plan → 11:30; near a 19:00 plan '7:30' → 19:30; '9am' → 09:00", arrivalClock("and if I want to arrive at 11:30?", "12:00") === "11:30" && arrivalClock("arrive by 7:30", "19:00") === "19:30" && arrivalClock("to get there by 9am", "19:00") === "09:00", [arrivalClock("and if I want to arrive at 11:30?", "12:00"), arrivalClock("arrive by 7:30", "19:00")]);
    add("stated origin: 'from greenwich' → Greenwich; 'from my house' → none", statedOrigin("what time should i leave from greenwich?")?.name === "Greenwich" && statedOrigin("a what time i need to leave form my hose?") === null, statedOrigin("what time should i leave from greenwich?"));
    const sr = splitRefine("pubs near me tonight; refine: cheaper; refine: what time do I need to leave");
    add("leave questions are not refinements (plan unchanged on replan)", JSON.stringify(sr.refinements) === JSON.stringify(["cheaper"]), sr);
    // Multi-day events: Luma's month-first line, day ranges, and the end date kept.
    const lu = eventDates("Friday, October 23, 12:00 PM – Oct 25, 4:30 PM", today, "01:15", "16:30");
    add("Luma 'October 23, 12:00 PM – Oct 25, 4:30 PM' → ongoing until 25 Oct", lu?.start === "2026-10-23" && lu.end === "2026-10-25" && lu.status === "ongoing", lu);
    const dr = eventDates("on 23–25 Oct", today);
    add("'23–25 Oct' → 23rd to 25th", dr?.start === "2026-10-23" && dr.end === "2026-10-25", dr);
    const so = eventDates("on Sat 23 Oct at 12:00-16:30", today, "01:15", "16:30");
    add("start date only and past → over", so?.status === "past" && so.end === null, so);
    const dl = parseDestination("Get me to Encode London Hackathon at Encode Hub on Friday, October 23, 12:00 PM – Oct 25, 4:30 PM");
    add("Luma time range → endTime 16:30", dl?.endTime === "16:30", dl?.endTime);
    const cl = cleanExtract({ kind: "event", title: "Encode London Hackathon", date: "2026-10-23", endDate: null, dateText: "Friday, October 23, 12:00 PM – Oct 25, 4:30 PM", startTime: "12:00", endTime: "16:30", confidence: 0.9 }, today);
    add("poster: endDate recovered from the printed date line", cl.endDate === "2026-10-25", cl.endDate);
    // Blurbs: same entity only, no address, no raw name+address fallback.
    add("wiki: a Thai restaurant article doesn't fit a pub of another name", !wikiFits({ name: "The Kings Arms", kind: "Pub" }, "Thai Square", "Thai Square is a chain of Thai restaurants"), null);
    add("wiki: a footballer / station article doesn't fit a pub", !wikiFits({ name: "The George", kind: "Pub" }, "George (footballer)", "English footballer born 1990") && !wikiFits({ name: "Bank", kind: "Bar" }, "Bank station", "Bank is a London Underground station"), null);
    add("wiki: the pub's own article fits", wikiFits({ name: "The King's Arms", kind: "Pub" }, "The King's Arms, Waterloo", "The King's Arms is a pub on Roupell Street in Waterloo"), null);
    add("rewrite with an address or 'located at' is rejected; postcodes in facts don't block a clean one", !acceptRewrite("The King's Arms is a pub located at 25 Roupell Street, SE1 8TB.", ["Wikipedia: The King's Arms is a pub located at 25 Roupell Street, Waterloo, London SE1 8TB."]) && acceptRewrite("Classic Victorian corner pub on a pretty terraced street, with Thai food in the back.", ["Wikipedia: The King's Arms is a pub located at 25 Roupell Street, Waterloo, London SE1 8TB. It serves Thai cuisine."]), null);
    const fb = fallbackBlurb({ id: "osm-node-1", name: "The King's Arms", kind: "Pub", tags: { cuisine: "thai" }, location: { lat: 51.5, lng: -0.11 }, area: "near Waterloo" }, { facts: ["Wikipedia: The King's Arms is a pub located at 25 Roupell Street, Waterloo, London SE1 8TB.", "Cuisine: thai"], source: { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/X" }, rich: true });
    add("fallback never restates the address: name+address → template with OSM facts", !/Roupell|SE1|located at/.test(fb.text) && /thai/i.test(fb.text), fb.text);
  }
  if (c.unit === "server4") {
    const today = "2026-10-25";
    // Event dates: multi-day ongoing → today; wholly past → say so; upcoming keeps its own year.
    const on = eventDates("on Fri 23 Oct until Sun 25 Oct at 12:00–16:30", today, "10:30", "16:30");
    add("Fri 23 Oct until Sun 25 Oct, today 25 Oct 10:30 → ongoing", on?.status === "ongoing" && on.start === "2026-10-23" && on.end === "2026-10-25", on);
    const done = eventDates("on Sat 23 Oct at 12:00", today, "10:30");
    add("Sat 23 Oct (single day), today 25 Oct → past, same year (not 2027)", done?.status === "past" && done.start === "2026-10-23", done);
    const late = eventDates("on Sun 25 Oct until Sun 25 Oct", today, "17:00", "16:30");
    add("ends today 16:30, now 17:00 → past", late?.status === "past", late);
    const up = eventDates("on Sat 31 Oct", today, "10:30");
    add("Sat 31 Oct → upcoming 2026-10-31", up?.status === "upcoming" && up.start === "2026-10-31", up);
    const pe: PosterExtract = { kind: "event", title: "Encode London Hackathon", venueName: "Encode Hub", address: null, area: "London", date: "2026-10-23", endDate: "2026-10-25", startTime: "12:00", endTime: "16:30", price: "Student ticket", free: false, needsRegistration: true, url: null, confidence: 0.9, notes: null };
    const pq = buildSuggestedQuery(pe) ?? "";
    add("multi-day poster → query says 'until Sun 25 Oct'", /on Fri 23 Oct until Sun 25 Oct/.test(pq), pq);
    const kept = cleanExtract({ kind: "event", title: "X", date: "2026-10-23", endDate: "2026-10-25", confidence: 0.9 }, today);
    add("cleanExtract keeps a just-passed date (no roll to next year) + endDate", kept.date === "2026-10-23" && kept.endDate === "2026-10-25", kept);
    // Privacy copy: no placeholders, their area removed cleanly.
    const scrubbed = scrubArea("How about Waterloo Tap, Sutton Walk (near Waterloo station)? 2 min from Waterloo", "Waterloo");
    add("scrubArea: area gone, no '[' placeholder", !/waterloo/i.test(scrubbed) && !/[[\]]/.test(scrubbed), scrubbed);
    const md = meetDraft({ venue: "Waterloo Tap", when: new Date("2026-10-29T19:00:00Z"), themMinutes: 0, category: "pub" });
    add("meetDraft without a hub: no station clause, no '['", !/near .* station|\[/.test(md), md);
    // Fairness: stations between the two starts are candidates, and a 0-minute "middle" loses to a balanced one.
    const st = (n: string) => STATIONS.find((s) => s.name === n)!;
    const mids = midpointStations(st("Elephant & Castle"), st("Waterloo")).map((h) => h.name);
    add("midpointStations(E&C, Waterloo): stations in between, neither person's own", mids.length > 0 && !mids.includes("Waterloo") && !mids.includes("Elephant & Castle"), mids);
    add("fairScore: 11 vs 14 beats 10 vs 0", fairScore({ worst: 14, gap: 3 }) < fairScore({ worst: 10, gap: 10 }), [fairScore({ worst: 14, gap: 3 }), fairScore({ worst: 10, gap: 10 })]);
    add("allStrings finds nested strings", allStrings({ a: ["x", { b: "[their area]" }] }).some((x) => x.includes("[")));
    // Blurbs: facts only, mocked network + Gemini.
    const fake = (routes: Record<string, unknown>) => (async (u: string | URL | Request) => {
      const url = String(u);
      const hit = Object.entries(routes).find(([k]) => url.includes(k));
      if (!hit) return new Response("nope", { status: 404 });
      return typeof hit[1] === "string" ? new Response(hit[1], { headers: { "content-type": "text/html" } }) : Response.json(hit[1]);
    }) as typeof fetch;
    const inn: BlurbInput = { id: "osm-way-1", name: "George Inn", kind: "Pub", tags: { wikipedia: "en:George Inn, Southwark", outdoor_seating: "yes" }, location: { lat: 51.5045, lng: -0.0894 }, area: "near London Bridge", closesAt: "23:00" };
    const wiki = { "rest_v1/page/summary/George_Inn": { type: "standard", extract: "The George Inn is a public house established in the medieval period on Borough High Street. It is the only surviving galleried coaching inn in London.", content_urls: { desktop: { page: "https://en.wikipedia.org/wiki/George_Inn,_Southwark" } } } };
    let prompt = "";
    const b1 = await buildBlurb(inn, "date", { fetch: fake(wiki), llm: async (p) => ((prompt = p), { text: "London's only surviving galleried coaching inn, with outdoor seating in its old courtyard.", bestFor: "a cosy date" }) });
    add("blurb: Gemini rewrite + 'Best for' + Wikipedia pill", /galleried/.test(b1.text) && b1.bestFor === "Best for a cosy date" && b1.source.name === "Wikipedia" && /George_Inn/.test(b1.source.url), b1);
    add("blurb prompt: facts only, forbids adding, no people/query", /ONLY/.test(prompt) && /do not add/i.test(prompt) && /galleried coaching inn/.test(prompt) && !/i'm at|she's|you:|them:/i.test(prompt), prompt.slice(0, 200));
    const b2 = await buildBlurb({ ...inn, id: "osm-way-2" }, "date", { fetch: fake(wiki), llm: async () => ({ text: "Open since 1676, famous for its 12 ales.", bestFor: null }) });
    add("blurb: rewrite with invented numbers rejected → Wikipedia sentence", !/1676|12 ales/.test(b2.text) && /^The George Inn is a public house/.test(b2.text) && !b2.bestFor, b2);
    let calls = 0;
    const b3 = await buildBlurb({ id: "osm-node-9", name: "The Kings Head", kind: "Pub", tags: {}, location: { lat: 51.5, lng: -0.11 }, area: "near Waterloo", closesAt: "23:00" }, "date", { fetch: fake({}), llm: async () => (calls++, { text: "x" }) });
    add("blurb: no facts → template, no Gemini call, OSM pill", b3.text === "A local pub near Waterloo, open till 23:00." && calls === 0 && b3.source.name === "OpenStreetMap" && /node\/9$/.test(b3.source.url), { b3, calls });
    const b4 = await buildBlurb({ id: "osm-node-10", name: "Bar Ten", kind: "Bar", tags: { website: "https://barten.example" }, location: { lat: 51.5, lng: -0.11 } }, "friends", { fetch: fake({ "barten.example": '<html><head><meta name="description" content="A tiny wine bar under the railway arches with candlelit tables."></head></html>' }), llm: null });
    add("blurb: website meta description used, site pill", /railway arches/.test(b4.text) && b4.source.name === "barten.example", b4);
    add("acceptRewrite rejects brackets and unknown numbers", !acceptRewrite("A pub [their area]", ["x"]) && !acceptRewrite("Serving since 1890 in style.", ["pub"]) && acceptRewrite("A friendly pub with a beer garden.", ["Has a beer garden"]));
  }
  return out;
}

function check(c: Case, r: Refined, asked: string[], base?: { youMin: number | null; query: string; cards?: string[]; middle?: string | null }, pinned?: Date | null, focus?: { id: string; name: string; lat: number; lng: number }) {
  const e = c.expect;
  const out: { name: string; pass: boolean; got?: unknown }[] = [];
  const add = (name: string, pass: boolean, got?: unknown) => out.push({ name, pass, ...(got !== undefined ? { got } : {}) });
  if (e.intent) add(`intent = ${e.intent}`, r.intent === e.intent, r.intent);
  add(e.clarify ? "asks to clarify" : "no clarify", !!r.clarify === e.clarify, r.clarify?.question ?? null);
  if (c.answers) {
    add("clarify never repeats", new Set(asked).size === asked.length, asked);
    if (e.clarifySteps !== undefined) add(`${e.clarifySteps} clarify step(s)`, asked.length === e.clarifySteps, asked.length);
  }
  if (e.clarify) {
    if (e.missing) add(`missing = ${e.missing}`, r.clarify?.missing === e.missing, r.clarify?.missing);
    add("2–3 suggestions", !!r.clarify && (r.clarify.suggestions?.length ?? 0) >= 2 && (r.clarify.suggestions?.length ?? 0) <= 3);
    add("no cards while clarifying", r.cards.length === 0, r.cards.length);
    return out;
  }
  const placeholders = allStrings(r).filter((x) => /[[\]]/.test(x) && !/^https?:\/\//.test(x));
  add("no '[…]' placeholder in any output string", placeholders.length === 0, placeholders.slice(0, 3));
  add("≤3 cards", r.cards.length <= 3, r.cards.length);
  if (e.minCards) add(`≥${e.minCards} card`, r.cards.length >= e.minCards, r.cards.length);
  if (e.venuesFrom) {
    const st = r.steps.find((x) => x.id === "venues");
    add(`venues step says where from (/${e.venuesFrom}/)`, !!st && new RegExp(e.venuesFrom).test(`${st.detail} [${st.source}]`), st && `${st.detail} [${st.source}]`);
  }
  if (e.cardsNear) add(`every card within ${e.cardsNear.maxM} m of ${e.cardsNear.lat}, ${e.cardsNear.lng}`, r.cards.length > 0 && r.cards.every((k) => metresBetween(k.location, e.cardsNear!) <= e.cardsNear!.maxM), r.cards.map((k) => [k.name, Math.round(metresBetween(k.location, e.cardsNear!))]));
  const facts = r.cards.flatMap((x) => x.facts);
  add("every fact has a source", facts.every((f) => typeof f.source === "string" && f.source.trim().length > 0), facts.length);
  add("every source has asOf", r.sources.length > 0 && r.sources.every((s) => !!s.asOf), r.sources.map((s) => s.name));
  if (e.middleIn) add("middle in acceptable set", !!r.middle && e.middleIn.includes(r.middle.name), r.middle?.name ?? null);
  if (e.intent === "meet_halfway") {
    add("cards have legs for you and them", r.cards.length > 0 && r.cards.every((x) => x.legs.some((l) => l.who === "you") && x.legs.some((l) => l.who === "them")));
    add("≥1 card", r.cards.length >= 1, r.cards.length);
    const area = (e.themArea ?? r.them?.area ?? "").toLowerCase();
    add("draftMessage has no 'them' area", !!r.draftMessage && !!area && !r.draftMessage.toLowerCase().includes(area), r.draftMessage);
    // server13: a typed station/area is a public place, so it is shown as itself (~150 m ring, precision "typed"); only a
    // shared GPS fix (precision "shared") is rounded to a ≥500 m area.
    add("them is an area: typed place ≥150 m ring, shared GPS ≥500 m", !!r.them && (r.them.precision === "typed" ? r.them.radiusM >= 150 : r.them.radiusM >= 500), r.them && { radiusM: r.them.radiusM, precision: r.them.precision });
  }
  if (e.maxLegMin) add(`every card: both journeys ≤ ${e.maxLegMin} min`, r.cards.length > 0 && r.cards.every((k) => k.legs.length >= 2 && k.legs.every((l) => l.minutes <= e.maxLegMin!)), r.cards.map((k) => k.legs.map((l) => `${l.who} ${l.minutes}`).join("/")));
  if (e.fairBoth) {
    // A "middle" on one person's doorstep isn't fair: it must sit between them, nobody at ~0 min.
    add("middle is neither person's own station", !!r.middle && !["Waterloo", "Elephant & Castle"].includes(r.middle.name), r.middle?.name ?? null);
    add("headline doesn't say anyone travels 0 min", !/\b0 min\b|, (?:her|him|them) 0\b/.test(r.headline), r.headline);
  }
  if (e.leaveBy) {
    const lb = (r as Refined).leaveBy;
    const hhmm = (v?: string) => !!v && /^\d\d:\d\d$/.test(v);
    add("leaveBy: arriveBy + date set", !!lb && hhmm(lb.arriveBy) && /^\d{4}-\d\d-\d\d$/.test(lb.date), lb);
    if (e.leaveBy.arriveBy) add(`leaveBy.arriveBy = ${e.leaveBy.arriveBy}`, lb?.arriveBy === e.leaveBy.arriveBy, lb?.arriveBy);
    if (e.leaveBy.you) add("leaveBy.you is HH:MM before arriveBy", !!lb && hhmm(lb.you) && lb.you! < lb.arriveBy, lb?.you);
    if (e.leaveBy.them) add("leaveBy.them is HH:MM before arriveBy", !!lb && hhmm(lb.them) && lb.them! < lb.arriveBy, lb?.them);
  }
  if (e.weekday) add(`day = ${e.weekday}`, londonDayShort(new Date(r.when)) === e.weekday, londonDayShort(new Date(r.when)));
  // Clock-relative day ("tomorrow afternoon"): the plan's London date minus today's (pinned clock, else the real one).
  if (e.daysAhead !== undefined) {
    const d = dayDiff(londonToday(new Date(r.when)), londonToday(pinned ?? new Date()));
    add(`day = today + ${e.daysAhead}`, d === e.daysAhead, { when: r.when, today: londonToday(pinned ?? new Date()) });
  }
  if (e.time) add(`time = ${e.time}`, londonClock(r.when) === e.time, londonClock(r.when));
  if (e.budgetGBP) add(`budget £${e.budgetGBP}`, r.filters.budgetGBP === e.budgetGBP, r.filters.budgetGBP);
  if (e.category) add(`category ${e.category}`, r.filters.category === e.category, r.filters.category);
  if (e.segments) {
    type Seg = { mode: string; line?: string; from?: string; to?: string; minutes: number; path: { lat: number; lng: number }[] };
    const legs = r.cards.flatMap((x) => x.legs) as (PlanResultWithAgent["cards"][number]["legs"][number] & { segments?: Seg[] })[];
    const segs = legs.flatMap((l) => l.segments ?? []);
    const transit = segs.filter((s) => s.mode !== "walking");
    add("every leg has segments", legs.length > 0 && legs.every((l) => (l.segments?.length ?? 0) > 0), legs.map((l) => l.segments?.length ?? 0));
    add("transit segments name a line and from/to stops", transit.length > 0 && transit.every((s) => !!s.line && !!s.from && !!s.to), transit.map((s) => `${s.line}: ${s.from} → ${s.to}`));
    add("segment paths ≤ 80 points, ≥2 on transit", segs.every((s) => s.path.length <= 80) && transit.every((s) => s.path.length >= 2), segs.map((s) => s.path.length));
    add("summary says 'X line from A to B'", legs.some((l) => /\bfrom .+ to /.test(l.summary)), legs.map((l) => l.summary));
    const them = legs.find((l) => l.who === "them")?.segments?.[0];
    add("them: first segment has no start name", !!them && !them.from, them ?? null);
  }
  if (e.noObjects) {
    const bad = r.cards.filter((x) => /booth|kiosk|plaque|statue|bench|memorial|phone box|telephone/i.test(x.name));
    add("no phone boxes / plaques / statues as places", bad.length === 0, bad.map((x) => x.name));
  }
  if (e.weather) {
    const venues = r.steps?.find((s) => s.id === "venues")?.detail ?? "";
    const want = e.weather === "wet" ? /weather: Rain likely .*indoor\/covered first/ : /weather: Dry and .*terraces\/beer gardens first/;
    add(`venues step names the ${e.weather} decision`, want.test(venues), venues);
    const fits = r.cards.map((x) => x.facts.find((f) => f.label === "Weather fit"));
    add("every card has a Weather fit fact (OSM + Open-Meteo)", fits.length > 0 && fits.every((f) => !!f && f.source.endsWith("+ Open-Meteo") && (e.weather === "wet" ? /^Rain likely/ : /^Dry and/).test(f.value)), fits.map((f) => f?.value ?? null));
    const good = (v?: string) => (e.weather === "wet" ? /indoor seating \(OSM|covered seating/ : /beer garden \(OSM|terrace/).test(v ?? "");
    add("best weather fit ranked first", !fits.some((f) => good(f?.value)) || good(fits[0]?.value), fits[0]?.value ?? null);
  }
  if (c.refines) {
    const last = c.refines[c.refines.length - 1];
    if (!e.multiPart) add("reply is one sentence", !!r.reply && r.reply.length < 240 && !/[.!?]\s+\S/.test(r.reply.replace(/\b(?:St|Mr|Dr)\./g, "")), r.reply ?? null);
    for (const m of e.replyMatch ?? []) add(`reply matches /${m}/i`, new RegExp(m, "i").test(r.reply ?? ""), r.reply ?? null);
    for (const m of e.replyNot ?? []) add(`reply avoids /${m}/i`, !new RegExp(m, "i").test(r.reply ?? ""), r.reply ?? null);
    add("query accumulates every refinement", !!base && r.query.startsWith(base.query.replace(/\.$/, "")) && c.refines.map((q) => q.replace(/[?.!]+$/, "")).every((q) => r.query.includes(`refine: ${q}`)) && r.query.endsWith(last.replace(/[?.!]+$/, "")), r.query);
    const area = (e.themArea ?? r.them?.area ?? "").toLowerCase();
    if (area) add("reply has no 'them' area", !(r.reply ?? "").toLowerCase().includes(area), r.reply ?? null);
    add("draftMessage short, no TfL status", !!r.draftMessage && r.draftMessage.length <= 280 && !/good service|delay|disruption|closure|suspend|status/i.test(r.draftMessage), r.draftMessage);
  }
  if (e.seating) {
    const f = r.cards[0]?.facts.find((x) => x.label === e.seating);
    add(`top card has a sourced '${e.seating}' fact`, !!f && f.source.length > 0 && /yes|outdoor|indoor/i.test(f.value), f ?? null);
  }
  if (pinned) {
    add("plan is not in the past", Date.parse(r.when) >= pinned.getTime(), { now: pinned.toISOString(), when: r.when });
    if (e.dayOffset !== undefined) {
      const d = dayDiff(londonToday(new Date(r.when)), londonToday(pinned));
      add(`day = pinned day + ${e.dayOffset}`, d === e.dayOffset, d);
      add("unknowns say why the time moved", r.unknowns.some((u) => /already (?:passed|gone|past)|about now/.test(u)), r.unknowns.filter((u) => /time|now|passed|gone/i.test(u)));
    }
  }
  // Every journey: no "walk, then walk", and no first "walk to X" where X is where you already are.
  type Sg = { mode: string; to?: string };
  const sl = r.cards.flatMap((x) => x.legs as unknown as { who: string; segments?: Sg[] }[]).filter((l) => l.segments?.length);
  if (sl.length) {
    add("no back-to-back walk segments", sl.every((l) => l.segments!.every((s, i) => i === 0 || !(s.mode === "walking" && l.segments![i - 1].mode === "walking"))), sl.map((l) => l.segments!.map((s) => s.mode).join(">")));
    const youStart = e.youStop ?? "";
    const first = sl.filter((l) => l.who === "you").map((l) => l.segments![0]);
    if (youStart) add("no 'walk to <your own stop>'", first.every((s) => s.mode !== "walking" || !s.to || s.to.toLowerCase() !== youStart.toLowerCase()), first);
  }
  if (e.hours) {
    type H = { name: string; openAtPlan?: boolean | null; closesAt?: string | null; closingSoon?: boolean; hoursKnown?: boolean; facts: { label: string; value: string }[] };
    const cs = r.cards as unknown as H[];
    const mins = (hhmm: string) => {
      const [h, m] = hhmm.split(":").map(Number);
      let d = (h * 60 + m - (+londonClock(r.when).slice(0, 2) * 60 + +londonClock(r.when).slice(3))) % 1440;
      if (d < 0) d += 1440;
      return d;
    };
    add("every card has openAtPlan/closesAt/closingSoon/hoursKnown", cs.length > 0 && cs.every((x) => "openAtPlan" in x && "closesAt" in x && typeof x.closingSoon === "boolean" && typeof x.hoursKnown === "boolean"), cs.map((x) => ({ n: x.name, o: x.openAtPlan, c: x.closesAt, s: x.closingSoon, k: x.hoursKnown })));
    add("no known-hours card is closed at the plan time", cs.every((x) => !x.hoursKnown || x.openAtPlan === true), cs.map((x) => [x.name, x.openAtPlan]));
    const anySolid = cs.some((x) => x.hoursKnown && !x.closingSoon);
    add("open ≥1 h after the plan time (closing-soon only as a fallback)", cs.every((x) => !x.closesAt || mins(x.closesAt) >= 60 || (x.closingSoon && !anySolid)), cs.map((x) => [x.name, x.closesAt]));
    const until = cs.filter((x) => x.closesAt).map((x) => x.facts.find((f) => /^Open /.test(f.label))?.value ?? "");
    add("cards with a closing time say 'Open until HH:MM'", until.every((v, i) => v.startsWith(`Open until ${cs.filter((x) => x.closesAt)[i].closesAt}`)), until);
    const known = cs.map((x) => !!x.hoursKnown);
    add("unknown-hours cards flagged hoursKnown=false", cs.every((x) => x.hoursKnown || (x.openAtPlan === null && x.closesAt === null)), known);
  }
  if (e.openAtPlan) {
    const hrs = r.cards.map((x) => x.facts.find((f) => /^Open /.test(f.label))?.value ?? null);
    add("no card is closed at the plan time (OSM hours)", hrs.every((v) => !v || !/^Closed/.test(v)), hrs);
    const soon = hrs.map((v) => !!v && /closes within the hour/.test(v));
    add("closing-soon cards ranked last", soon.every((x, i) => !x || soon.slice(i).every(Boolean)), hrs);
  }
  if (c.focusTop) {
    add("focus sent (selected card)", !!focus, null);
    if (focus && !e.sameAsBase) {
      add("selected place excluded", !r.cards.some((x) => x.id === focus.id || x.name === focus.name), r.cards.map((x) => x.name));
      const far = r.cards.filter((x) => x.kind !== "event" && Math.hypot((x.location.lat - focus.lat) * 111_000, (x.location.lng - focus.lng) * 69_000) > 1000);
      add("cards are in the selected place's area (≤1 km)", far.length === 0, far.map((x) => x.name));
    }
  }
  if (c.focusTop && e.sameAsBase && focus) add("reply is about the selected place", r.reply?.includes(focus.name) === true, r.reply);
  if (e.sameAsBase) add("same plan: cards and middle unchanged", !!base && JSON.stringify(r.cards.map((x) => x.id)) === JSON.stringify(base.cards) && (r.middle?.name ?? null) === base.middle, { before: base?.cards, after: r.cards.map((x) => x.id) });
  if (e.onlyCuisine) {
    const hit = (x: Refined["cards"][number]) => x.facts.some((f) => f.label === "Cuisine" && f.verdict !== "unknown");
    add("with ≥1 cuisine match, every card matches", !r.cards.some(hit) || r.cards.every(hit), r.cards.map((x) => `${x.name}: ${x.facts.find((f) => f.label === "Cuisine")?.value}`));
  }
  if (e.destination) {
    const d = e.destination;
    add("fixed destination: no middle / hub search", !r.middle && !r.steps.some((s) => s.id === "compare" || s.id === "venues"), { middle: r.middle?.name, steps: r.steps.map((s) => s.id) });
    add("one card: the place named", r.cards.length === 1, r.cards.map((x) => x.name));
    if (d.kind) add(`card kind = ${d.kind}`, r.cards[0]?.kind === d.kind, r.cards[0]?.kind);
    for (const l of d.facts ?? []) add(`card has a '${l}' fact`, !!r.cards[0]?.facts.some((f) => f.label === l || f.label.startsWith(`${l} `)), r.cards[0]?.facts.map((f) => f.label));
    if (d.legs) add(`${d.legs} leg(s)`, r.cards[0]?.legs.length === d.legs, r.cards[0]?.legs.map((l) => l.who));
    if (d.near) add(`card within ${d.near.maxM} m of ${d.near.lat}, ${d.near.lng}`, !!r.cards[0] && metresBetween(r.cards[0].location, d.near) <= d.near.maxM, r.cards[0]?.location);
    for (const l of d.noFacts ?? []) add(`no '${l}' fact`, !r.cards[0]?.facts.some((f) => f.label === l || f.label.startsWith(`${l} `)), r.cards[0]?.facts.map((f) => f.label));
    if (d.near) add("never swapped by verify", !(r as { verify?: { swapped: unknown[] } }).verify?.swapped.length, (r as { verify?: unknown }).verify);
    if (r.them) add("their area not in reply/draft/unknowns/steps' parse signals", ![r.draftMessage, r.reply ?? "", ...r.unknowns, r.steps.find((s) => s.id === "parse")?.detail ?? ""].some((t) => t.toLowerCase().includes(r.them!.area.toLowerCase())), null);
  }
  if (e.headlineMatch) add(`headline matches /${e.headlineMatch}/i`, new RegExp(e.headlineMatch, "i").test(r.headline), r.headline);
  if (e.approx) {
    add("approximate area noted", r.unknowns.some((u) => /broad area/i.test(u)) && /approx/i.test(r.them?.area ?? ""), { area: r.them?.area, unknowns: r.unknowns.filter((u) => /broad/i.test(u)) });
    add("unknowns/draft don't name their area", ![...r.unknowns, r.draftMessage ?? ""].some((u) => /walthamstow|north-east/i.test(u)), null);
  }
  if (e.cuisine) add(`cards carry a Cuisine fact (${e.cuisine})`, r.cards.length > 0 && r.cards.every((x) => x.facts.some((f) => f.label === "Cuisine")), r.cards.map((x) => x.facts.find((f) => f.label === "Cuisine")?.value ?? null));
  if (e.youCloser) add("your trip is shorter than the fair plan", base?.youMin != null && youMin(r) != null && youMin(r)! < base.youMin, { before: base?.youMin, after: youMin(r) });
  if (e.walkIn) {
    add("walk-in filter on", r.filters.walkIn === true);
    const rsvp = r.cards.filter((x) => x.facts.some((f) => f.label === "Sign-up" && f.verdict !== "unknown" && /rsvp|registration|register/i.test(f.value)));
    add("no RSVP/registration-only cards", rsvp.length === 0, rsvp.map((x) => x.name));
  }
  return out;
}

(async () => {
  const startedAt = new Date().toISOString();
  const results = [];
  let passed = 0;
  for (const c of cases) {
    let row;
    try {
      if (c.unit) {
        const checks = await unitChecks(c);
        const pass = checks.length > 0 && checks.every((x) => x.pass);
        const row = { id: c.id, query: c.query, pass, ms: 0, checks };
        if (pass) passed++;
        console.log(`${pass ? "PASS" : "FAIL"}  ${c.id.padEnd(26)}      0 ms  ${pass ? `${checks.length} unit checks` : checks.filter((x) => !x.pass).map((x) => `${x.name} (got ${JSON.stringify(x.got)})`).join("; ")}`);
        results.push(row);
        continue;
      }
      const { status, body, ms, asked, base, pinned, focus } = await call(c);
      const checks = status === 200 ? check(c, body, asked, base, pinned, focus) : [{ name: "HTTP 200", pass: false, got: status }];
      const pass = checks.every((x) => x.pass);
      row = { id: c.id, query: c.query, pass, ms, checks, headline: body.headline, middle: body.middle?.name ?? null, cards: body.cards?.map((x) => x.name) ?? [], clarify: body.clarify ?? null, ...(c.answers ? { asked } : {}), ...(c.clock ? { clock: c.clock, unknownsTime: body.unknowns?.filter((u) => /already|about now/.test(u)) } : {}), ...(c.refines ? { refines: c.refines, reply: body.reply ?? null, accumulated: body.query } : {}), when: body.when, cardFacts: body.cards?.map((x) => ({ name: x.name, weather: x.facts.find((f) => f.label === "Weather fit") ?? null })), unknowns: body.unknowns, steps: body.steps?.map((s) => ({ id: s.id, status: s.status, ms: s.ms, detail: s.detail })) };
    } catch (err) {
      row = { id: c.id, query: c.query, pass: false, ms: 0, checks: [{ name: "handler ran", pass: false, got: String(err) }] };
    }
    if (row.pass) passed++;
    const failedChecks = row.checks.filter((x) => !x.pass).map((x) => `${x.name}${"got" in x ? ` (got ${JSON.stringify(x.got)})` : ""}`);
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(26)} ${String(row.ms).padStart(6)} ms  ${row.pass ? ("headline" in row ? row.headline : "") : failedChecks.join("; ")}`);
    if (process.env.EVAL_VERBOSE && "reply" in row && row.reply) console.log(`      reply: ${row.reply}`);
    results.push(row);
  }
  const rate = passed / cases.length;
  console.log(`\n${passed}/${cases.length} passed (${(rate * 100).toFixed(0)}%)`);
  if (!only) writeFileSync("evals/last-run.json", JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), passed, total: cases.length, rate, results }, null, 2) + "\n");
})();
