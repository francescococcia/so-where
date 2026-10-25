// POST /api/live-token → { token, model, expiresAt } : a one-use, short-lived Gemini Live ephemeral token.
// The real GEMINI_API_KEY never leaves the server. The token is locked to our model, system prompt and tools,
// so it can't be reused for anything else. Audio and transcripts go browser ↔ Gemini directly; this route
// never sees them, and nothing here is stored or logged (not even the caller's IP beyond an in-memory counter).
import { GoogleGenAI, Modality } from "@google/genai";
import { DEFAULT_LIVE_MODEL, LIVE_SYSTEM_PROMPT, LIVE_TOOLS, LIVE_VOICE_NAME } from "@/lib/live-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PER_MIN = 6;
const PER_HOUR = 40;
const hits = new Map<string, number[]>();

function limited(ip: string) {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  const lastMin = recent.filter((t) => now - t < 60_000).length;
  if (lastMin >= PER_MIN || recent.length >= PER_HOUR) {
    hits.set(ip, recent);
    return true;
  }
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value as string);
  return false;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

export async function POST(req: Request) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || process.env.LIVE_VOICE === "off") return json(503, { error: "Live voice isn't switched on here." });
  // Same-origin only (browsers send Origin on POST); blocks other sites minting tokens with our key.
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return json(403, { error: "Not allowed." });
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
  if (limited(ip)) return json(429, { error: "Too many voice sessions. Try again in a minute." });

  const model = process.env.LIVE_MODEL || DEFAULT_LIVE_MODEL;
  const now = Date.now();
  const expiresAt = new Date(now + 30 * 60_000).toISOString(); // a session can run up to ~15 min
  try {
    const ai = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1alpha" } });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: expiresAt,
        newSessionExpireTime: new Date(now + 60_000).toISOString(), // must connect within a minute
        liveConnectConstraints: {
          model,
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: LIVE_SYSTEM_PROMPT,
            tools: [{ functionDeclarations: LIVE_TOOLS }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME } } },
          },
        },
        httpOptions: { apiVersion: "v1alpha" },
      },
    });
    if (!token.name) return json(502, { error: "Voice is unavailable right now." });
    return json(200, { token: token.name, model, expiresAt });
  } catch {
    // No details: errors can echo request config. The client falls back to the browser mic.
    return json(502, { error: "Voice is unavailable right now." });
  }
}

export function GET() {
  return json(405, { error: "Use POST." });
}
