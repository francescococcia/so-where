// POST /api/speak { text, lang? } → audio/wav: one short assistant reply read aloud by a Gemini TTS model (voice Aoede, the
// same voice as live voice). Text only in, audio only out: nothing is logged or stored (the rate limit keeps an
// in-memory counter per IP). 503 when no key is set; the client then falls back to the browser's speechSynthesis.
// `lang` (ISO 639-1, e.g. "it") = the reply was translated: the TTS gets speechConfig.languageCode so it speaks it
// natively; a model that rejects the code is retried once without it. No lang = exactly the old English request.
import { GoogleGenAI } from "@google/genai";
import { LIVE_VOICE_NAME } from "@/lib/live-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** TTS_MODEL (env) wins, then gemini-3.8-flash-tts (the brief's model, nicer prosody, ~2.8 s for a reply), then
 * flash-lite-tts (~1.8 s) in the same request if the first errors or is slow. A model the key can't open is skipped
 * for the life of the server. The X-TTS-Model header names the model that really answered. */
const MODELS = ["gemini-3.8-flash-tts", "gemini-3.8-flash-lite-tts", "gemini-2.5-flash-preview-tts"];
/** Give the first model this long before falling back (the client gives up at 9 s and uses speechSynthesis). */
const FIRST_MS = 5000;
const dead = new Set<string>();
const MAX_CHARS = 400;
const PER_MIN = 12;
const PER_HOUR = 120;
const hits = new Map<string, number[]>();
/** BCP 47 codes Gemini TTS knows, for translated replies. */
const TTS_LANG: Record<string, string> = { it: "it-IT", es: "es-US", fr: "fr-FR", de: "de-DE", pt: "pt-BR", nl: "nl-NL", pl: "pl-PL", ro: "ro-RO", tr: "tr-TR", ar: "ar-EG", hi: "hi-IN", bn: "bn-BD", ja: "ja-JP", ko: "ko-KR", ru: "ru-RU", uk: "uk-UA", zh: "cmn-CN", el: "el-GR", sv: "sv-SE" };

function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.filter((t) => now - t < 60_000).length >= PER_MIN || recent.length >= PER_HOUR) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value as string);
  return false;
}

const json = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

/** 16-bit mono PCM → WAV (Gemini TTS returns audio/L16 at 24 kHz). */
function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || process.env.TTS === "off") return json(503, "Voice replies aren't switched on here.");
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json(403, "Not allowed.");
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  if (limited(ip)) return json(429, "Too many voice replies. Try again in a minute.");

  let text = "";
  let languageCode: string | undefined;
  try {
    const body = (await req.json()) as { text?: unknown; lang?: unknown };
    text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
    const lang = typeof body.lang === "string" ? body.lang.toLowerCase().slice(0, 2) : "";
    if (lang && lang !== "en" && TTS_LANG[lang]) languageCode = TTS_LANG[lang];
  } catch {
    return json(400, "Send { text }.");
  }
  if (!text) return json(400, "Send { text }.");
  if (text.length > MAX_CHARS) return json(413, `Keep it under ${MAX_CHARS} characters.`);

  const ai = new GoogleGenAI({ apiKey: key });
  const models = [process.env.TTS_MODEL, ...MODELS].filter((m, i, a): m is string => !!m && a.indexOf(m) === i && !dead.has(m));
  const tries = models.flatMap((m) => (languageCode ? [{ model: m, languageCode }, { model: m, languageCode: undefined }] : [{ model: m, languageCode: undefined }]));
  const started = Date.now();
  for (const { model, languageCode: lc } of tries) {
    if (dead.has(model)) continue;
    const left = 8000 - (Date.now() - started);
    if (left < 1200) break;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), model === models[0] ? Math.min(FIRST_MS, left) : left);
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }], // text only: style prompts get read aloud by some TTS models
        config: { abortSignal: ac.signal, responseModalities: ["AUDIO"], speechConfig: { ...(lc ? { languageCode: lc } : {}), voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME } } } },
      });
      clearTimeout(timer);
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const data = part?.inlineData?.data;
      if (!data) continue;
      const mime = part?.inlineData?.mimeType ?? "";
      const raw = Buffer.from(data, "base64");
      const audio = /wav/i.test(mime) || raw.subarray(0, 4).toString() === "RIFF" ? raw : wav(raw, Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000));
      return new Response(new Uint8Array(audio), {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-TTS-Model": model, "X-TTS-Ms": String(Date.now() - started), "Access-Control-Expose-Headers": "X-TTS-Model, X-TTS-Ms" },
      });
    } catch (e) {
      clearTimeout(timer);
      const status = (e as { status?: number }).status;
      if (ac.signal.aborted) continue; // too slow: next model
      if (status === 400 && lc) continue; // maybe just the language code: retry this model without it
      if (status === 404 || status === 400 || status === 403) dead.add(model);
      if (status === 429) return json(429, "Voice is busy. Try again in a moment.");
    }
  }
  return json(502, "Couldn't make the voice reply.");
}
