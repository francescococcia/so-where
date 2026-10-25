// Vision model for photo reading (/api/poster, /api/place-snap): env VISION_MODEL, default "gemini-4-argon".
// If that model isn't available to our key (404 / 403 / "not found" / "permission"), fall back to
// gemini-3-flash-preview and remember that for the rest of the process. Only statuses are inspected:
// request and response bodies (the image and its text) are never logged.
export const VISION_DEFAULT = "gemini-4-argon";
export const VISION_FALLBACK = "gemini-3-flash-preview";
let fellBack = false;

/** The model the next vision call will try first. */
export const visionModel = () => (fellBack ? VISION_FALLBACK : process.env.VISION_MODEL || VISION_DEFAULT);
/** Tests: forget the cached fallback decision. */
export function resetVisionModelForTests() {
  fellBack = false;
}

const MODEL_MISSING = /not[ _]found|NOT_FOUND|is not supported|not available|PERMISSION_DENIED|permission|does not have access|unknown model|invalid model/i;

/** POST generateContent with `body`; returns the response and the model that produced it. Throws fetch/abort errors. */
export async function visionGenerate(body: unknown, key: string, timeoutMs: number, deps: { fetch?: typeof fetch } = {}): Promise<{ res: Response; model: string }> {
  const f = deps.fetch ?? fetch;
  const deadline = Date.now() + timeoutMs;
  const call = (model: string) =>
    f(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(500, deadline - Date.now())),
    });
  const first = visionModel();
  const res = await call(first);
  if (res.ok || first === VISION_FALLBACK) return { res, model: first };
  let missing = res.status === 404 || res.status === 403;
  if (!missing && res.status === 400) {
    const msg = await res.clone().text().catch(() => "");
    missing = MODEL_MISSING.test(msg) && /model/i.test(msg);
  }
  if (!missing) return { res, model: first };
  fellBack = true;
  return { res: await call(VISION_FALLBACK), model: VISION_FALLBACK };
}
