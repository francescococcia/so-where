// npm run eval — runs evals/plan-evals.json through the real plan handler (live network), prints
// per-case pass/fail and the overall rate, writes evals/last-run.json. Checks are fixed; don't tune them.
import { readFileSync, writeFileSync } from "node:fs";
import { POST } from "@/app/api/plan/route";
import type { PlanResultWithAgent } from "@/lib/plan-types";
import { londonClock, londonDayShort } from "@/lib/london-time";
import { setForecastOverride } from "@/lib/weather";

type Expect = { intent?: string; clarify: boolean; missing?: string; middleIn?: string[]; weekday?: string; time?: string; budgetGBP?: number; category?: string; walkIn?: boolean; minCards?: number; themArea?: string; weather?: "wet" | "warm"; clarifySteps?: number; segments?: boolean; noObjects?: boolean };
// `answers`: a clarify sequence; each reply is sent as {query: reply, answer: reply, previous: {query: <result.query>, answer: reply}}
// exactly like the UI, and the same clarify must never come back twice. `weather`: injected forecast (no Open-Meteo call).
type Wx = { tempC: number; rainPct: number; rainMm?: number; sunny?: boolean };
type Case = { id: string; query: string; you?: { lat: number; lng: number }; answer?: string; previous?: { query: string; answer: string }; answers?: string[]; weather?: Wx; expect: Expect };

const { cases } = JSON.parse(readFileSync("evals/plan-evals.json", "utf8")) as { cases: Case[] };

async function post(body: Record<string, unknown>) {
  const res = await POST(new Request("http://local/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as PlanResultWithAgent };
}

async function call(c: Case) {
  const t0 = Date.now();
  setForecastOverride(
    c.weather
      ? async () => ({ value: `${c.weather!.tempC}°C, ${c.weather!.rainPct}% chance of rain (eval-injected)`, tempC: c.weather!.tempC, rainPct: c.weather!.rainPct, rainMm: c.weather!.rainMm ?? 0, sunny: c.weather!.sunny ?? false, fetchedAt: new Date().toISOString(), ms: 0 })
      : null,
  );
  try {
    let r = await post({ query: c.query, you: c.you, answer: c.answer, previous: c.previous });
    const asked: string[] = [];
    for (const a of c.answers ?? []) {
      if (r.status !== 200 || !r.body.clarify) break;
      asked.push(`${r.body.clarify.missing}: ${r.body.clarify.question}`);
      r = await post({ query: a, you: c.you, answer: a, previous: { query: r.body.query, answer: a } });
    }
    if (r.status === 200 && r.body.clarify && c.answers) asked.push(`${r.body.clarify.missing}: ${r.body.clarify.question}`);
    return { ...r, asked, ms: Date.now() - t0 };
  } finally {
    setForecastOverride(null);
  }
}

function check(c: Case, r: PlanResultWithAgent, asked: string[]) {
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
      const { status, body, ms, asked } = await call(c);
      const checks = status === 200 ? check(c, body, asked) : [{ name: "HTTP 200", pass: false, got: status }];
      const pass = checks.every((x) => x.pass);
      row = { id: c.id, query: c.query, pass, ms, checks, headline: body.headline, middle: body.middle?.name ?? null, cards: body.cards?.map((x) => x.name) ?? [], clarify: body.clarify ?? null, ...(c.answers ? { asked } : {}), when: body.when, cardFacts: body.cards?.map((x) => ({ name: x.name, weather: x.facts.find((f) => f.label === "Weather fit") ?? null })), unknowns: body.unknowns, steps: body.steps?.map((s) => ({ id: s.id, status: s.status, ms: s.ms, detail: s.detail })) };
    } catch (err) {
      row = { id: c.id, query: c.query, pass: false, ms: 0, checks: [{ name: "handler ran", pass: false, got: String(err) }] };
    }
    if (row.pass) passed++;
    const failedChecks = row.checks.filter((x) => !x.pass).map((x) => `${x.name}${"got" in x ? ` (got ${JSON.stringify(x.got)})` : ""}`);
    console.log(`${row.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(26)} ${String(row.ms).padStart(6)} ms  ${row.pass ? ("headline" in row ? row.headline : "") : failedChecks.join("; ")}`);
    results.push(row);
  }
  const rate = passed / cases.length;
  console.log(`\n${passed}/${cases.length} passed (${(rate * 100).toFixed(0)}%)`);
  writeFileSync("evals/last-run.json", JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), passed, total: cases.length, rate, results }, null, 2) + "\n");
})();
