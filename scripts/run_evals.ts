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
import { hoursAt } from "@/lib/osm";
import { backtrackPenalty, tidySegments, type LegSegment } from "@/lib/tfl";
import { parsePlanAsk } from "@/lib/ask-local";

function pinnedNow(hhmm: string): Date {
  const [hh, mm] = hhmm.split(":").map(Number);
  const today = londonToday();
  const t = londonToUtc(today, hh, mm);
  return t.getTime() > Date.now() ? t : londonToUtc(londonToday(new Date(Date.now() + 86_400_000)), hh, mm);
}
const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000);

type Expect = { intent?: string; clarify: boolean; missing?: string; middleIn?: string[]; weekday?: string; time?: string; budgetGBP?: number; category?: string; walkIn?: boolean; minCards?: number; themArea?: string; weather?: "wet" | "warm"; clarifySteps?: number; segments?: boolean; noObjects?: boolean; replyMatch?: string[]; seating?: "Outdoor seating" | "Indoor seating"; youCloser?: boolean; dayOffset?: number; openAtPlan?: boolean; hours?: boolean; youStop?: string; replyNot?: string[]; approx?: boolean; cuisine?: string };
// `answers`: a clarify sequence; each reply is sent as {query: reply, answer: reply, previous: {query: <result.query>, answer: reply}}
// exactly like the UI, and the same clarify must never come back twice. `refines`: follow-up chat turns, each sent as
// {mode:"refine", query: r, previous: {query: <result.query>}} (the accumulated ask from the previous turn). `weather`: injected forecast (no Open-Meteo call).
type Wx = { tempC: number; rainPct: number; rainMm?: number; sunny?: boolean };
// `unit`: in-process checks of a helper (no HTTP): "hours" parses OSM opening_hours, "segments" tidies stretches.
type HoursUnit = { oh: string; date: string; at: string; state: "open" | "closed" | "unknown"; closesAt?: string };
type Case = { id: string; query: string; unit?: "hours" | "segments" | "coarse"; hours?: HoursUnit[]; you?: { lat: number; lng: number }; answer?: string; previous?: { query: string; answer: string }; answers?: string[]; refines?: string[]; focusTop?: boolean; weather?: Wx; clock?: string; expect: Expect };
// `clock`: pin "now" to HH:MM London (today if still ahead, else tomorrow, so live TfL/forecast calls stay in the
// future); `dayOffset` is then the plan's London date minus the pinned date.
type Refined = PlanResultWithAgent & { reply?: string };
const youMin = (r: PlanResultWithAgent) => r.cards[0]?.legs.find((l) => l.who === "you")?.minutes ?? null;

const all = (JSON.parse(readFileSync("evals/plan-evals.json", "utf8")) as { cases: Case[] }).cases;
// EVAL_ONLY=prefix runs a subset (last-run.json is then not written).
const only = process.env.EVAL_ONLY;
const cases = only ? all.filter((c) => c.id.startsWith(only)) : all;

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
    const base = c.refines ? { youMin: youMin(r.body), query: r.body.query } : undefined;
    for (const q of c.refines ?? []) {
      if (r.status !== 200) break;
      const top = c.focusTop ? r.body.cards?.[0] : undefined;
      if (top) focus = { id: top.id, name: top.name, lat: top.location.lat, lng: top.location.lng };
      r = await post({ query: q, mode: "refine", previous: { query: r.body.query }, you: c.you, ...(top ? { focus } : {}) });
    }
    return { ...r, asked, base, pinned, focus, ms: Date.now() - t0 };
  } finally {
    setForecastOverride(null);
    setClockOverride(null);
  }
}

type Chk = { name: string; pass: boolean; got?: unknown };
function unitChecks(c: Case): Chk[] {
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
  return out;
}

function check(c: Case, r: Refined, asked: string[], base?: { youMin: number | null; query: string }, pinned?: Date | null, focus?: { id: string; name: string; lat: number; lng: number }) {
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
  add("≤3 cards", r.cards.length <= 3, r.cards.length);
  if (e.minCards) add(`≥${e.minCards} card`, r.cards.length >= e.minCards, r.cards.length);
  const facts = r.cards.flatMap((x) => x.facts);
  add("every fact has a source", facts.every((f) => typeof f.source === "string" && f.source.trim().length > 0), facts.length);
  add("every source has asOf", r.sources.length > 0 && r.sources.every((s) => !!s.asOf), r.sources.map((s) => s.name));
  if (e.middleIn) add("middle in acceptable set", !!r.middle && e.middleIn.includes(r.middle.name), r.middle?.name ?? null);
  if (e.intent === "meet_halfway") {
    add("cards have legs for you and them", r.cards.length > 0 && r.cards.every((x) => x.legs.some((l) => l.who === "you") && x.legs.some((l) => l.who === "them")));
    add("≥1 card", r.cards.length >= 1, r.cards.length);
    const area = (e.themArea ?? r.them?.area ?? "").toLowerCase();
    add("draftMessage has no 'them' area", !!r.draftMessage && !!area && !r.draftMessage.toLowerCase().includes(area), r.draftMessage);
    add("them is rounded to an area (radius ≥ 500 m)", !!r.them && r.them.radiusM >= 500);
  }
  if (e.weekday) add(`day = ${e.weekday}`, londonDayShort(new Date(r.when)) === e.weekday, londonDayShort(new Date(r.when)));
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
    add("reply is one sentence", !!r.reply && r.reply.length < 240 && !/[.!?]\s+\S/.test(r.reply.replace(/\b(?:St|Mr|Dr)\./g, "")), r.reply ?? null);
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
    if (focus) {
      add("selected place excluded", !r.cards.some((x) => x.id === focus.id || x.name === focus.name), r.cards.map((x) => x.name));
      const far = r.cards.filter((x) => x.kind !== "event" && Math.hypot((x.location.lat - focus.lat) * 111_000, (x.location.lng - focus.lng) * 69_000) > 1000);
      add("cards are in the selected place's area (≤1 km)", far.length === 0, far.map((x) => x.name));
    }
  }
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
        const checks = unitChecks(c);
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
