// POST /api/plan {query, you?, when?, previous?} → PlanResultWithAgent (JSON), or NDJSON when
// `Accept: application/x-ndjson`: {"type":"step",...} lines then one {"type":"result"} or {"type":"clarify"}.
// Request bodies are never logged (they can hold someone's location).
import { runPlan, type PlanRequest } from "@/lib/plan";
import type { AgentStep, PlanResultWithAgent } from "@/lib/plan-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

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
  return {
    query: b.query.slice(0, 500),
    you: you && typeof you === "object" && Number.isFinite(you.lat) && Number.isFinite(you.lng) ? { lat: you.lat, lng: you.lng } : undefined,
    when: typeof b.when === "string" ? b.when : undefined,
    previous: prev && str(prev.query) ? { query: (prev.query as string).slice(0, 500), answer: answer.slice(0, 200) } : undefined,
  };
}

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
      return Response.json(await runPlan(body), { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ error: "Planning failed" }, { status: 500 });
    }
  }

  const enc = new TextEncoder();
  const plan = body;
  const rs = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        const r: PlanResultWithAgent = await runPlan(plan, (step: AgentStep) => send({ type: "step", step }));
        if (r.clarify) send({ type: "clarify", clarify: r.clarify });
        else send({ type: "result", result: r });
      } catch {
        send({ type: "error", error: "Planning failed" });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(rs, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" } });
}
