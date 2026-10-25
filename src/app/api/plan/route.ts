// POST /api/plan {query, you?, when?, previous?} → PlanResultWithAgent (JSON), or NDJSON when
// Follow-up chat: {mode:"refine", query:"<short refinement>", previous:{query:"<last result.query>"}, you?} → the
// (optional `focus:{id?,name?,lat,lng}` = the selected card: "other … in the area" searches around it, excluding it) →
// optional `previous.result` = the result on screen: "is it open?" is then answered from the focus/top card's hours and
// that same result comes back unchanged with `reply` (no replan unless the place is closed) →
// the same result plus `reply` (one sentence) and `query` (accumulated ask to send as previous.query next turn).
// `Accept: application/x-ndjson`: {"type":"step",...} lines then one {"type":"result"} or {"type":"clarify"}.
// Cards may carry `blurb` {text, bestFor?, source:{name,url}} (top 3; see blurb.ts). Stream: attached to the result
// when ready within ~600 ms, else sent after it as {"type":"blurbs","blurbs":{[cardId]: Blurb}} (≤2.5 s, may be absent).
// The stream always ends with a result or clarify (a failure is a result with a friendly headline, plus {"type":"error"}).
// Any language: optional `lang` ("auto" | ISO code picked in the UI) and `translated` ({lang, model} when the browser
// already translated a spoken ask via /api/translate). Plainly English text skips translation (cheap rules, no model
// call); otherwise the user's words go to English first (step "translate") and the result carries
// `translated: {lang, langName, model}` so the UI can reply in that language.
// Request bodies are never logged (they can hold someone's location).
import { langEnglishName, langName, looksEnglish, toEnglish } from "@/lib/translate";
import { planBlurbs, type Blurb } from "@/lib/blurb";
import { cardTags, failedResult, planRunWrite, runPlan, type PlanFocus, type PlanRequest, type PlanResultRefined } from "@/lib/plan";
import type { AgentStep, PlanResultWithAgent } from "@/lib/plan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Refine only: {focus:{id?, name?, lat, lng}} = the card the user has selected ("other Italian places in the area"). */
function focusOf(v: unknown): PlanFocus | null {
  if (!v || typeof v !== "object") return null;
  const f = v as Record<string, unknown>;
  if (typeof f.lat !== "number" || typeof f.lng !== "number" || !Number.isFinite(f.lat) || !Number.isFinite(f.lng)) return null;
  return { lat: f.lat, lng: f.lng, ...(typeof f.id === "string" ? { id: f.id.slice(0, 80) } : {}), ...(typeof f.name === "string" ? { name: f.name.slice(0, 120) } : {}) };
}

/** Refine only: previous.result = the plan on screen (echoed back for "is it open?", never stored or logged). */
function resultOf(v: unknown): PlanResultWithAgent | null {
  if (!v || typeof v !== "object") return null;
  const r = v as PlanResultWithAgent;
  if (!Array.isArray(r.cards) || !r.cards.length || typeof r.when !== "string" || typeof r.query !== "string") return null;
  if (!r.cards.every((c) => c && typeof c.name === "string" && typeof c.id === "string" && Array.isArray(c.facts))) return null;
  return { ...r, cards: r.cards.slice(0, 3), steps: Array.isArray(r.steps) ? r.steps : [] };
}

function parseBody(raw: unknown): PlanRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.query !== "string" || !b.query.trim()) return null;
  const you = b.you as { lat: number; lng: number } | undefined;
  const prev = b.previous && typeof b.previous === "object" ? (b.previous as Record<string, unknown>) : undefined;
  // Clarify answers arrive as {query, answer, previous:{query, answer}}: the top-level `answer` (else
  // previous.answer, else query) is the user's reply that fills the missing slot of previous.query.
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);
  const answer = str(b.answer) ?? str(prev?.answer) ?? (b.query as string);
  const refine = b.mode === "refine" && str(prev?.query) ? (b.query as string).slice(0, 300) : undefined;
  return {
    ...(refine !== undefined ? { refine } : {}),
    query: b.query.slice(0, 500),
    you: you && typeof you === "object" && Number.isFinite(you.lat) && Number.isFinite(you.lng) ? { lat: you.lat, lng: you.lng } : undefined,
    when: typeof b.when === "string" ? b.when : undefined,
    ...(refine !== undefined && focusOf(b.focus) ? { focus: focusOf(b.focus)! } : {}),
    previous: prev && str(prev.query) ? { query: (prev.query as string).slice(0, 1500), answer: refine !== undefined ? "" : answer.slice(0, 200), ...(refine !== undefined && resultOf(prev.result) ? { result: resultOf(prev.result)! } : {}) } : undefined,
  };
}

type Translated = { lang: string; langName: string; model: string };
/** Translate the user's own words in place (fresh ask, clarify answer or refinement). Null = English, untouched. */
async function translateAsk(raw: unknown, body: PlanRequest): Promise<{ step: AgentStep; translated: Translated } | null> {
  const b = (raw ?? {}) as Record<string, unknown>;
  const hint = typeof b.lang === "string" ? b.lang.toLowerCase().slice(0, 4) : "auto";
  const pre = b.translated && typeof b.translated === "object" ? (b.translated as Record<string, unknown>) : null;
  if (pre && typeof pre.lang === "string" && /^[a-z]{2}$/.test(pre.lang) && pre.lang !== "en" && typeof pre.model === "string") {
    const lang = pre.lang;
    const model = pre.model.slice(0, 60);
    return { translated: { lang, langName: langName(lang), model }, step: { id: "translate", label: `Translated from ${langEnglishName(lang)} · ${model}`, status: "done", detail: `${langName(lang)} → English · voice`, source: model, ms: typeof pre.ms === "number" ? Math.round(pre.ms) : undefined } };
  }
  const field = body.refine !== undefined ? "refine" : body.previous?.answer ? "answer" : "query";
  const text = field === "refine" ? body.refine! : field === "answer" ? body.previous!.answer : body.query;
  if (hint === "en" || ((hint === "auto" || !hint) && looksEnglish(text))) return null;
  const t0 = Date.now();
  const t = await toEnglish(text, hint).catch(() => null);
  if (!t || !t.model || t.lang === "en") return null;
  if (field === "refine") body.refine = body.query = t.english.slice(0, 300);
  else if (field === "answer") body.previous!.answer = t.english.slice(0, 200);
  else body.query = t.english.slice(0, 500);
  return { translated: { lang: t.lang, langName: t.langName, model: t.model }, step: { id: "translate", label: `Translated from ${langEnglishName(t.lang)} · ${t.model}`, status: "done", detail: `${t.langName} → English`, source: t.model, ms: Date.now() - t0 } };
}
const withTranslation = (r: PlanResultRefined, tr: { step: AgentStep; translated: Translated } | null) => {
  if (!tr) return r;
  r.steps = [tr.step, ...(r.steps ?? []).filter((s) => s.id !== "translate")];
  (r as PlanResultRefined & { translated?: Translated }).translated = tr.translated;
  return r;
};

const blurbsOn = () => process.env.BLURBS !== "off";
/** Top-3 card blurbs, never throwing; {} when off, a clarify, or every card already has one (echoed refine). */
function blurbsFor(r: PlanResultRefined): Promise<Record<string, Blurb>> {
  if (!blurbsOn() || r.clarify || !r.cards.length || r.cards.slice(0, 3).every((c) => (c as { blurb?: Blurb }).blurb)) return Promise.resolve({});
  return planBlurbs(r, cardTags).catch(() => ({}));
}
const attach = (r: PlanResultRefined, b: Record<string, Blurb>) => {
  r.cards = r.cards.map((c) => (b[c.id] ? { ...c, blurb: b[c.id] } : c));
};

/** Stream only: true when no model translation will run (so no "Translating" row flashes up for English). */
function looksEnglishBody(raw: unknown, body: PlanRequest) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const hint = typeof b.lang === "string" ? b.lang.toLowerCase().slice(0, 4) : "auto";
  if (b.translated || hint === "en") return true;
  const text = body.refine !== undefined ? body.refine : body.previous?.answer || body.query;
  return (hint === "auto" || !hint) && looksEnglish(text);
}

export async function POST(req: Request) {
  let body: PlanRequest | null = null;
  let raw: unknown = null;
  try {
    raw = await req.json();
    body = parseBody(raw);
  } catch {
    body = null;
  }
  if (!body) return Response.json({ error: "Send JSON like {\"query\": \"...\"}" }, { status: 400 });

  const stream = (req.headers.get("accept") ?? "").includes("application/x-ndjson");
  if (!stream) {
    try {
      const tr = await translateAsk(raw, body);
      const r = withTranslation(await runPlan(body), tr);
      attach(r, await blurbsFor(r));
      await planRunWrite(r); // finish the plan_runs insert before the serverless function returns
      return Response.json(r, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "Planning failed" }, { status: 500 });
    }
  }

  const enc = new TextEncoder();
  const plan = body;
  const rs = new ReadableStream<Uint8Array>({
    async start(controller) {
      let ended = false;
      const send = (o: { type: string; [k: string]: unknown }) => {
        if (o.type === "result" || o.type === "clarify") ended = true;
        controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      };
      try {
        let tr: Awaited<ReturnType<typeof translateAsk>> = null;
        if (!looksEnglishBody(raw, plan)) {
          send({ type: "step", step: { id: "translate", label: "Translating your ask", status: "running" } });
          tr = await translateAsk(raw, plan);
          send({ type: "step", step: tr?.step ?? { id: "translate", label: "Reading your language", status: "skipped", detail: "Read as English" } });
          // ui24: the English words of a fresh ask, so the loading radar can find the places named in it. Only on this
          // stream to the asker's own browser; never in steps, the result or plan_runs.
          if (tr && plan.refine === undefined && !plan.previous?.answer) send({ type: "translated", english: plan.query });
        } else tr = await translateAsk(raw, plan); // pre-translated voice ask only; no model call
        const r: PlanResultRefined = withTranslation(await runPlan(plan, (step: AgentStep) => send({ type: "step", step })), tr);
        // `query` is the accumulated ask (earlier answers appended as "; them: X"): resend it as
        // previous.query with the next answer so a second clarify never loses the first answer.
        if (r.clarify) send({ type: "clarify", clarify: r.clarify, query: r.query, ...(r.reply ? { reply: r.reply } : {}), ...(tr ? { translated: tr.translated } : {}) });
        else {
          const pending = blurbsFor(r);
          const early = await Promise.race([pending, new Promise<null>((res) => setTimeout(() => res(null), 600))]);
          if (early) attach(r, early);
          send({ type: "result", result: r });
          if (!early) {
            const late = await pending;
            if (Object.keys(late).length) send({ type: "blurbs", blurbs: late });
          }
        }
        await planRunWrite(r); // result already sent; keep the function alive until plan_runs is written
      } catch {
        // Never end empty: a friendly result the UI can show, plus the error marker.
        if (!ended) send({ type: "result", result: failedResult(plan.query) });
        send({ type: "error", error: "Planning failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(rs, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
