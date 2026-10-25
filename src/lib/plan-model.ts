// Planner model (the Argon pick + re-check in verify.ts): env PLAN_MODEL, default "gemini-4-argon".
// Same fallback rule as vision.ts: a model-not-found / permission error switches to gemini-3-flash-preview
// for the rest of the process. Plus a latency guard: if the primary model hasn't answered within
// PLAN_GUARD_MS (default 12 s), that one call is aborted and retried on flash (not cached; the next call tries
// Argon again). Only statuses are inspected; request and response bodies are never logged.
export const PLAN_DEFAULT = "gemini-4-argon";
export const PLAN_FALLBACK = "gemini-3-flash-preview";
export const PLAN_GUARD_MS = 12_000;
let fellBack = false;

/** The model the next planner call will try first. */
export const planModel = () => (fellBack ? PLAN_FALLBACK : process.env.PLAN_MODEL || PLAN_DEFAULT);
/** Tests: forget the cached fallback decision. */
export function resetPlanModelForTests() {
  fellBack = false;
}

const MODEL_MISSING = /not[ _]found|NOT_FOUND|is not supported|not available|PERMISSION_DENIED|permission|does not have access|unknown model|invalid model/i;
const guardMs = () => {
  const n = Number(process.env.PLAN_GUARD_MS);
  return Number.isFinite(n) && n > 0 ? n : PLAN_GUARD_MS;
};

export type PlanCall = { res: Response; model: string; ms: number; guarded: boolean };

/** POST generateContent with `body` within `timeoutMs` overall. Throws fetch/abort errors (caller treats as "no answer"). */
export async function planGenerate(body: unknown, key: string, timeoutMs: number, deps: { fetch?: typeof fetch; guardMs?: number } = {}): Promise<PlanCall> {
  const f = deps.fetch ?? fetch;
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const call = (model: string, ms: number) =>
    f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(500, ms)),
    });
  const first = planModel();
  if (first === PLAN_FALLBACK) return { res: await call(first, deadline - Date.now()), model: first, ms: Date.now() - t0, guarded: false };
  // Latency guard: leave flash at least ~3 s of the overall budget.
  const guard = Math.min(deps.guardMs ?? guardMs(), Math.max(1000, deadline - Date.now() - 3000));
  let res: Response;
  try {
    res = await call(first, guard);
  } catch (e) {
    const name = (e as Error)?.name;
    if (name !== "TimeoutError" && name !== "AbortError") throw e;
    return { res: await call(PLAN_FALLBACK, deadline - Date.now()), model: PLAN_FALLBACK, ms: Date.now() - t0, guarded: true };
  }
  if (res.ok) return { res, model: first, ms: Date.now() - t0, guarded: false };
  let missing = res.status === 404 || res.status === 403;
  if (!missing && res.status === 400) {
    const msg = await res.clone().text().catch(() => "");
    missing = MODEL_MISSING.test(msg) && /model/i.test(msg);
  }
  if (!missing) return { res, model: first, ms: Date.now() - t0, guarded: false };
  fellBack = true;
  return { res: await call(PLAN_FALLBACK, deadline - Date.now()), model: PLAN_FALLBACK, ms: Date.now() - t0, guarded: false };
}
