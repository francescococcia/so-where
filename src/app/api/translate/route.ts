// POST /api/translate — "speak any language".
//   {text, hint?}            → {lang, langName, english, model}   (model null + skipped when the text is plainly English)
//   {text, to:"it"}          → {lang, langName, text, model}      (an English reply put into the user's language)
//   {audio: base64 PCM16 16 kHz mono} → {lang, langName, english, original, model, detectModel}
//                               (gemini-3.5-live-translate-preview over the Live API; 502 if it can't answer)
// Text and audio are never logged or stored.
import { audioToEnglish, detectLang, fromEnglish, langName, looksEnglish, toEnglish } from "@/lib/translate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_AUDIO_BYTES = 16000 * 2 * 15; // 15 s
const hits = new Map<string, number[]>();
function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value as string);
  return recent.length > 30;
}
const json = (status: number, body: unknown) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json(403, { error: "Not allowed." });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  if (limited(ip)) return json(429, { error: "Too many requests. Try again in a minute." });
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Send {text} or {audio}." });
  }
  if (!process.env.GEMINI_API_KEY) return json(503, { error: "Translation isn't switched on here." });

  if (typeof b.audio === "string" && b.audio) {
    const pcm = Buffer.from(b.audio, "base64");
    if (pcm.length < 3200 || pcm.length > MAX_AUDIO_BYTES) return json(413, { error: "Keep it under 15 seconds." });
    const r = await audioToEnglish(pcm);
    if (!r) return json(502, { error: "Couldn't translate that. Try again or type it." });
    const d = await detectLang(r.original);
    const lang = d?.lang ?? "und";
    return json(200, { lang, langName: lang === "und" ? "Spoken" : langName(lang), english: r.english, original: r.original, model: r.model, detectModel: d?.model ?? null });
  }

  const text = typeof b.text === "string" ? b.text.replace(/\s+/g, " ").trim() : "";
  if (!text) return json(400, { error: "Send {text} or {audio}." });
  if (text.length > 700) return json(413, { error: "Too long." });
  const to = typeof b.to === "string" ? b.to.toLowerCase().slice(0, 3) : "";
  if (to && to !== "en") {
    const r = await fromEnglish(text, to);
    return r ? json(200, { lang: to, langName: langName(to), text: r.text, model: r.model }) : json(502, { error: "Couldn't translate the reply." });
  }
  const hint = typeof b.hint === "string" ? b.hint.toLowerCase().slice(0, 4) : "auto";
  if (hint === "en" || ((hint === "auto" || !hint) && looksEnglish(text))) return json(200, { lang: "en", langName: "English", english: text, model: null, skipped: true });
  const r = await toEnglish(text, hint);
  return r ? json(200, r) : json(502, { error: "Couldn't translate that." });
}
