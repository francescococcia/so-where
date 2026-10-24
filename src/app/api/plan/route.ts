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
// Request bodies are never logged (they can hold someone's location).
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

const blurbsOn = () => process.env.BLURBS !== "off";
/** Top-3 card blurbs, never throwing; {} when off, a clarify, or every card already has one (echoed refine). */
function blurbsFor(r: PlanResultRefined): Promise<Record<string, Blurb>> {
  if (!blurbsOn() || r.clarify || !r.cards.length || r.cards.slice(0, 3).every((c) => (c as { blurb?: Blurb }).blurb)) return Promise.resolve({});
  return planBlurbs(r, cardTags).catch(() => ({}));
}
const attach = (r: PlanResultRefined, b: Record<string, Blurb>) => {
  r.cards = r.cards.map((c) => (b[c.id] ? { ...c, blurb: b[c.id] } : c));
};

export async function POST(req: Request) {
  let body: PlanRequest | null = null;
  try {
    body = parseBody(await req.json());
  } catch {
    body = null;
  }
  if (!body) return Response.json({ error: "Send JSON like {\"query\": \"...\"}" }, { status: 400 });

  const stream = (req.headers.get("accept") ?? "").includes("application/x-ndjson");
  if (!stream) {
    try {
      const r = await runPlan(body);
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
        const r: PlanResultRefined = await runPlan(plan, (step: AgentStep) => send({ type: "step", step }));
        // `query` is the accumulated ask (earlier answers appended as "; them: X"): resend it as
        // previous.query with the next answer so a second clarify never loses the first answer.
        if (r.clarify) send({ type: "clarify", clarify: r.clarify, query: r.query, ...(r.reply ? { reply: r.reply } : {}) });
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
