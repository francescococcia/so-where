// POST /api/speak { text } → audio/wav: one short assistant reply read aloud by a Gemini TTS model (voice Aoede, the
// same voice as live voice). Text only in, audio only out: nothing is logged or stored (the rate limit keeps an
// in-memory counter per IP). 503 when no key is set; the client then falls back to the browser's speechSynthesis.
import { GoogleGenAI } from "@google/genai";
import { LIVE_VOICE_NAME } from "@/lib/live-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Newest first; TTS_MODEL (env) wins. A model the key can't open is skipped for the life of the server. */
const MODELS = ["gemini-3.8-flash-lite-tts", "gemini-3.8-flash-tts", "gemini-2.5-flash-preview-tts"];
const dead = new Set<string>();
const MAX_CHARS = 400;
const PER_MIN = 12;
const PER_HOUR = 120;
const hits = new Map<string, number[]>();

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
  try {
    const body = (await req.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.replace(/\s+/g, " ").trim() : "";
  } catch {
    return json(400, "Send { text }.");
  }
  if (!text) return json(400, "Send { text }.");
  if (text.length > MAX_CHARS) return json(413, `Keep it under ${MAX_CHARS} characters.`);

  const ai = new GoogleGenAI({ apiKey: key });
  const models = [process.env.TTS_MODEL, ...MODELS].filter((m, i, a): m is string => !!m && a.indexOf(m) === i && !dead.has(m));
  for (const model of models) {
    try {
      const res = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text }] }], // text only: style prompts get read aloud by some TTS models
        config: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME } } } },
      });
      const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      const data = part?.inlineData?.data;
      if (!data) continue;
      const mime = part?.inlineData?.mimeType ?? "";
      const raw = Buffer.from(data, "base64");
      const audio = /wav/i.test(mime) || raw.subarray(0, 4).toString() === "RIFF" ? raw : wav(raw, Number(/rate=(\d+)/.exec(mime)?.[1] ?? 24000));
      return new Response(new Uint8Array(audio), {
        headers: { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-TTS-Model": model },
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404 || status === 400 || status === 403) dead.add(model);
      if (status === 429) return json(429, "Voice is busy. Try again in a moment.");
    }
  }
  return json(502, "Couldn't make the voice reply.");
}
