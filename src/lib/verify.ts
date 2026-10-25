// Verification loop for the picks (server7). Argon (PLAN_MODEL, see plan-model.ts) proposes the top picks
// from the already-checked option pool; deterministic checks then test them against our own data:
//   hard: closed / over at the plan time, closes or ends within 1 h of it, no TfL journey, over the max
//         minutes, outdoor-only when rain is forecast, not step-free when step-free was asked for;
//   soft: hours not listed, weather fit / step-free / cuisine not tagged (only counts when a better-checked
//         option exists).
// If Argon's top pick fails, the failures go back to Argon once to re-pick from the options that pass; the
// answer is accepted only if it names a passing option from the pool, else the best passing option by our own
// ranking is used. Never fabricate: cards only ever come from the pool, and Argon's text is never shown as a fact.
// Without Argon (no key, PLAN_ARGON=off, call failed) only hard failures cause swaps, so behaviour is unchanged.
// Privacy: Argon gets the ask with their area scrubbed and the public venue facts; never coordinates.
import type { PlanCard, PlanResultWithAgent } from "@/lib/plan-types";
import { planGenerate, planModel } from "@/lib/plan-model";

export type Swap = { from: string; to: string; reason: string };
/** Optional result field (backward compatible; plan-types.ts unchanged). model: "rules" when no LLM ran. */
export type VerifyInfo = { rounds: number; swapped: Swap[]; model: string };
export type PlanResultVerified = PlanResultWithAgent & { verify?: VerifyInfo };

type Hours = { openAtPlan?: boolean | null; closesAt?: string | null; closingSoon?: boolean; hoursKnown?: boolean };
export type VCard = PlanCard & Hours;
export type CardCheck = { hard: string[]; soft: string[] };
export type CheckOpts = { maxMinutes?: number; stepFree?: boolean };

export const STEP_FREE_ASK = /step[- ]free|wheelchair|accessible|no stairs|without stairs/i;
const factOf = (c: PlanCard, label: string) => c.facts.find((f) => f.label === label);

/** Deterministic checks for one card, from its own fields and sourced facts only. */
export function checkCard(c: VCard, o: CheckOpts = {}): CardCheck {
  const hard: string[] = [];
  const soft: string[] = [];
  const ev = c.kind === "event";
  if (c.openAtPlan === false) hard.push(ev ? "already over by then" : "closed then");
  else if (c.closingSoon) hard.push(c.closesAt ? `${ev ? "ends" : "closes"} ${c.closesAt}` : `${ev ? "ends" : "closes"} within the hour`);
  else if (c.hoursKnown === false) soft.push("hours not listed");
  const you = c.legs.find((l) => l.who === "you");
  const travel = c.facts.some((f) => f.label === "Travel" && /tfl/i.test(f.source));
  if (!you || !Number.isFinite(you.minutes) || !travel) hard.push("no TfL journey");
  else if (o.maxMinutes && you.minutes > o.maxMinutes) hard.push(`${you.minutes} min away (max ${o.maxMinutes})`);
  const fit = factOf(c, "Weather fit");
  if (fit && /outdoor only/i.test(fit.value)) hard.push(`outdoor only, ${fit.value.split(" - ")[0].replace(/^Rain likely.*/i, "rain likely")}`);
  else if (fit?.verdict === "unknown") soft.push("weather fit not tagged");
  if (o.stepFree) {
    const sf = factOf(c, "Step-free");
    if (sf && /: no\b/i.test(sf.value)) hard.push("not step-free (OSM)");
    else if (sf && /limited/i.test(sf.value)) soft.push("limited step-free access");
    else if (!sf || sf.verdict === "unknown") soft.push("step-free not tagged");
  }
  const cu = factOf(c, "Cuisine");
  if (cu && cu.verdict === "unknown") soft.push(cu.value.replace(/ \(OSM.*$/, "").toLowerCase());
  return { hard, soft };
}

/** Minutes between the two sides' journeys (report only: all cards at one hub share it). */
export function fairnessGap(c: PlanCard): number | null {
  const a = c.legs.find((l) => l.who === "you")?.minutes;
  const b = c.legs.find((l) => l.who === "them")?.minutes;
  return a != null && b != null ? Math.abs(a - b) : null;
}

export type PickerCand = { id: string; name: string; kind: string; subtitle: string; minutes: number[]; facts: string[]; why: string };
export type PickerIn = { query: string; when: string; need: number; candidates: PickerCand[]; failures?: string[]; allowed?: string[] };
export type PickerOut = { ids: string[]; reasons: string[]; model: string; ms: number; guarded?: boolean } | null;
export type Picker = (x: PickerIn) => Promise<PickerOut>;

const SCHEMA = {
  type: "OBJECT",
  properties: { picks: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, reason: { type: "STRING" } }, required: ["id", "reason"] } } },
  required: ["picks"],
};

/** Argon (PLAN_MODEL) as the picker: JSON ids + one-line reasons. null on no key / off / any failure. */
export const argonPicker: Picker = async (x) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key || /^(off|0|false)$/i.test(process.env.PLAN_ARGON ?? "")) return null;
  const list = x.candidates.map((c) => `- id=${c.id} | ${c.name} | ${c.subtitle} | travel ${c.minutes.join(" / ")} min | ${c.facts.join("; ")} | ${c.why}`).join("\n");
  const prompt = x.failures
    ? `Our checks rejected your top pick for this plan:\n${x.failures.join("\n")}\nPick again, choosing only from these ids, which passed every check: ${x.allowed!.join(", ")}.\nAsk: "${x.query}" (plan time ${x.when}).\nOptions:\n${list}\nReturn up to ${x.need} picks, best first, each with a short reason based only on the facts listed.`
    : `You are planning an outing in London. Ask: "${x.query}" (plan time ${x.when}).\nThese options are already found and checked (TfL times, OSM hours, forecast). Pick the best ${x.need} for this ask, best first. Use only ids from the list. Prefer options that are clearly open at that time, fit the weather and what was asked. Reasons: one short line each, based only on the facts listed; do not invent facts.\nOptions:\n${list}`;
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, responseMimeType: "application/json", responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: "low" } } };
  try {
    const call = await planGenerate(body, key, x.failures ? 12_000 : 15_000);
    if (!call.res.ok) return null;
    const j = (await call.res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
    const picks = (JSON.parse(text) as { picks?: { id?: unknown; reason?: unknown }[] }).picks ?? [];
    const ids = picks.map((p) => String(p.id ?? "").trim()).filter(Boolean);
    return ids.length ? { ids, reasons: picks.map((p) => String(p.reason ?? "").slice(0, 160)), model: call.model, ms: call.ms, guarded: call.guarded } : null;
  } catch {
    return null;
  }
};

let testPicker: Picker | null = null;
/** Tests / evals: replace the Argon picker (null restores it). */
export function setPlanPickerForTests(p: Picker | null) {
  testPicker = p;
}

type Begin = (id: string, label: string, source?: string) => (status: "running" | "done" | "failed" | "skipped", detail?: string, source?: string) => void;
export type VerifyOpts = CheckOpts & { begin: Begin; query: string; when: Date; whenLabel: string; fixed?: boolean; max: number };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Picks the final cards (≤ max) from the pool and records what the loop did. */
export async function verifyPicks(pool: VCard[], o: VerifyOpts): Promise<{ cards: VCard[]; verify: VerifyInfo }> {
  const checks = new Map(pool.map((c) => [c.id, checkCard(c, o)]));
  const what = ["open ≥1 h at the plan time", "TfL journey", ...(pool.some((c) => fairnessGap(c) != null) ? ["fairness gap"] : []), "weather fit", ...(o.stepFree ? ["step-free"] : [])];
  const fails = (c: VCard) => [...checks.get(c.id)!.hard];
  const hardClean = pool.filter((c) => !checks.get(c.id)!.hard.length);
  const minSoft = Math.min(...hardClean.map((c) => checks.get(c.id)!.soft.length));
  const passes = (c: VCard) => !checks.get(c.id)!.hard.length && checks.get(c.id)!.soft.length <= minSoft;
  const gap = pool.map(fairnessGap).find((g) => g != null);
  const summary = (cards: VCard[]) => {
    const bad = cards.filter((c) => fails(c).length);
    return `${pool.length} option${pool.length === 1 ? "" : "s"} checked (${what.join(", ")})${gap != null ? ` · fairness gap ${gap} min` : ""} · ${cards.length - bad.length}/${cards.length} shown pass${bad.length ? ` · flagged: ${bad.map((c) => `${c.name} (${fails(c).join(", ")})`).join("; ")}` : ""}`;
  };
  const swapped: Swap[] = [];
  const rulesPick = (start: VCard[]) => {
    // Keep the order; replace hard failures with the next hard-clean option not already shown.
    const out: VCard[] = [];
    const spare = pool.filter((c) => !start.includes(c) && !fails(c).length);
    for (const c of start) {
      if (out.length >= o.max) break;
      if (fails(c).length && spare.length) {
        const to = spare.shift()!;
        swapped.push({ from: c.name, to: to.name, reason: fails(c).join(", ") });
        out.push(to);
      } else out.push(c);
    }
    for (const c of spare) if (out.length < o.max && !out.includes(c)) out.push(c);
    return out;
  };
  const done = (cards: VCard[], rounds: number, model: string) => ({ cards, verify: { rounds, swapped, model } });

  if (!pool.length || o.fixed) {
    o.begin("recheck", "Checking the plan against hours, TfL and weather")("done", pool.length ? summary(pool) : "Nothing to check");
    return done(pool.slice(0, o.max), pool.length ? 1 : 0, "rules");
  }
  const picker = testPicker ?? argonPicker;
  const need = Math.min(o.max, pool.length);
  const cands: PickerCand[] = pool.map((c) => ({ id: c.id, name: c.name, kind: c.kind, subtitle: c.subtitle, minutes: c.legs.map((l) => l.minutes), facts: c.facts.filter((f) => f.label !== "Price").map((f) => `${f.label}: ${f.value}`), why: c.why }));
  const endPick = pool.length > 1 ? o.begin("argon", `Argon picking from ${pool.length} checked options`, "Gemini") : null;
  const first = pool.length > 1 ? await picker({ query: o.query, when: o.whenLabel, need, candidates: cands }) : null;
  if (!first) {
    endPick?.("skipped", "Planner model not used, kept our own ranking");
    const cards = rulesPick(pool.slice(0, o.max));
    const sw = swapped[0];
    o.begin("recheck", sw ? `Re-checked: swapped ${sw.from} (${sw.reason}) for ${sw.to}` : "Checking the picks against hours, TfL and weather")("done", summary(cards));
    return done(cards, 1, "rules");
  }
  const byId = new Map(pool.map((c) => [c.id, c]));
  const proposed = [...new Set(first.ids)].map((id) => byId.get(id)).filter((c): c is VCard => !!c);
  const fabricated = first.ids.filter((id) => !byId.has(id));
  endPick!("done", `${first.model}${first.guarded ? " (Argon over the latency guard, flash used)" : ""}, ${secs(first.ms)}: ${proposed.map((c) => c.name).join(", ") || "no listed option"}${fabricated.length ? ` · ignored ${fabricated.length} id${fabricated.length > 1 ? "s" : ""} not in the list` : ""}${first.reasons[0] ? ` · "${first.reasons[0]}"` : ""}`, first.model);
  let model = first.model;
  let rounds = 1;
  const invented = !byId.has(first.ids[0]);
  let top: VCard | undefined = invented ? undefined : proposed[0];
  let swapLabel: string | null = null;
  if (!top || !passes(top)) {
    const reason = !top ? "not in the checked options" : [...checks.get(top.id)!.hard, ...checks.get(top.id)!.soft].join(", ");
    const fromName = top ? top.name : "an option not in our data";
    const allowed = pool.filter(passes);
    if (allowed.length) {
      rounds = 2;
      const endRe = o.begin("argon-recheck", "Argon re-picking after the checks", "Gemini");
      const re = await picker({ query: o.query, when: o.whenLabel, need, candidates: cands, failures: [`${fromName}: ${reason}`], allowed: allowed.map((c) => c.id) });
      const reTop = re?.ids.map((id) => byId.get(id)).find((c): c is VCard => !!c && allowed.includes(c));
      const to = reTop ?? allowed[0];
      endRe(re ? "done" : "failed", re ? `${re.model}, ${secs(re.ms)}${reTop ? "" : " · its answer didn't pass, used the best passing option"}` : "No answer, used the best passing option");
      if (re && reTop) model = re.model;
      swapped.push({ from: fromName, to: to.name, reason });
      swapLabel = `Argon re-checked: swapped ${fromName} (${reason}) for ${to.name}`;
      top = to;
    } else top = top ?? proposed[0] ?? pool[0];
  }
  // The rest: Argon's order where it passes the hard checks, then our own ranking.
  const rest = proposed.filter((c) => c !== top && !fails(c).length);
  const fill = pool.filter((c) => c !== top && !rest.includes(c) && !fails(c).length);
  const cards = [top!, ...rest, ...fill].slice(0, o.max);
  if (cards.length < need) for (const c of pool) if (cards.length < need && !cards.includes(c)) cards.push(c);
  o.begin("recheck", swapLabel ?? "Checked Argon's picks against hours, TfL and weather")("done", summary(cards));
  return done(cards, rounds, model);
}

export { planModel };
