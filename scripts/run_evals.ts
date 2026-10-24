// npm run eval — runs evals/plan-evals.json through the real plan handler (live network), prints
// per-case pass/fail and the overall rate, writes evals/last-run.json. Checks are fixed; don't tune them.
import { readFileSync, writeFileSync } from "node:fs";
import { POST } from "@/app/api/plan/route";
import type { PlanResultWithAgent } from "@/lib/plan-types";
import { londonClock, londonDayShort } from "@/lib/london-time";

type Expect = { intent?: string; clarify: boolean; missing?: string; middleIn?: string[]; weekday?: string; time?: string; budgetGBP?: number; category?: string; walkIn?: boolean; minCards?: number; themArea?: string };
type Case = { id: string; query: string; you?: { lat: number; lng: number }; answer?: string; previous?: { query: string; answer: string }; expect: Expect };

const { cases } = JSON.parse(readFileSync("evals/plan-evals.json", "utf8")) as { cases: Case[] };

async function call(c: Case) {
  const req = new Request("http://local/api/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: c.query, you: c.you, answer: c.answer, previous: c.previous }) });
  const t0 = Date.now();
  const res = await POST(req);
  return { status: res.status, body: (await res.json()) as PlanResultWithAgent, ms: Date.now() - t0 };
}

function check(c: Case, r: PlanResultWithAgent) {
  const e = c.expect;
  const out: { name: string; pass: boolean; got?: unknown }[] = [];
  const add = (name: string, pass: boolean, got?: unknown) => out.push({ name, pass, ...(got !== undefined ? { got } : {}) });
  if (e.intent) add(`intent = ${e.intent}`, r.intent === e.intent, r.intent);
  add(e.clarify ? "asks to clarify" : "no clarify", !!r.clarify === e.clarify, r.clarify?.question ?? null);
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
      const { status, body, ms } = await call(c);
      const checks = status === 200 ? check(c, body) : [{ name: "HTTP 200", pass: false, got: status }];
      const pass = checks.every((x) => x.pass);
      row = { id: c.id, query: c.query, pass, ms, checks, headline: body.headline, middle: body.middle?.name ?? null, cards: body.cards?.map((x) => x.name) ?? [], clarify: body.clarify ?? null, unknowns: body.unknowns, steps: body.steps?.map((s) => ({ id: s.id, status: s.status, ms: s.ms, detail: s.detail })) };
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
