// Proves: /api/live-token mints a token (key stays server-side), a Live session opens with it,
// a text turn gets an audio reply (+ transcript), and a tool call round-trips. Prints no secrets.
// Usage: BASE=http://localhost:3107 node scripts/test-live-voice.mjs
import { GoogleGenAI, Modality } from "@google/genai";
const BASE = process.env.BASE || "http://localhost:3107";
const IP = { "X-Forwarded-For": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` }; // fresh rate-limit bucket per run
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"} ${m}`); if (!c) process.exitCode = 1; };

// 1) token route
const res = await fetch(`${BASE}/api/live-token`, { method: "POST", headers: { Origin: BASE, ...IP } });
const body = await res.json();
ok(res.status === 200 && typeof body.token === "string" && body.token.startsWith("auth_tokens/"), `POST /api/live-token → ${res.status}, model=${body.model}, expiresAt=${body.expiresAt}`);
ok(!JSON.stringify(body).includes(process.env.GEMINI_API_KEY || "@@none@@"), "response does not contain the API key");
const bad = await fetch(`${BASE}/api/live-token`, { method: "POST", headers: { Origin: "https://evil.example" } });
ok(bad.status === 403, `cross-origin POST → ${bad.status}`);

// 2) Live session with the ephemeral token, as the browser does
const ai = new GoogleGenAI({ apiKey: body.token, httpOptions: { apiVersion: "v1alpha" } });
let audio = 0, said = "", toolCalls = [], turns = 0;
let onTurn;
const session = await ai.live.connect({
  model: body.model,
  config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {} },
  callbacks: {
    onopen: () => console.log("live socket open"),
    onerror: (e) => console.log("live error", e?.message),
    onclose: (e) => console.log("live closed", e?.code, (e?.reason || "").slice(0, 120)),
    onmessage: (m) => {
      if (m.toolCall?.functionCalls) {
        for (const fc of m.toolCall.functionCalls) {
          toolCalls.push(fc.name + " " + JSON.stringify(fc.args));
          const output = fc.name === "plan"
            ? "Borough is the fair middle (for 19:00). Top picks: 1) The Rake, pub, you 14 min, them 16 min: tiny craft-beer pub. 2) The Globe, pub, you 15 min, them 17 min. 3) Southwark Tavern, pub, you 13 min, them 18 min."
            : "Done.";
          session.sendToolResponse({ functionResponses: [{ id: fc.id, name: fc.name, response: { output } }] });
        }
      }
      const sc = m.serverContent;
      for (const p of sc?.modelTurn?.parts ?? []) if (p.inlineData?.data) audio += Buffer.from(p.inlineData.data, "base64").length;
      if (sc?.outputTranscription?.text) said += sc.outputTranscription.text;
      if (sc?.turnComplete) { turns++; onTurn?.(); }
    },
  },
});
const turn = (text) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("turn timeout")), 40000);
  onTurn = () => { if (!audio) return; clearTimeout(t); resolve(); }; // a tool call also ends a turn; wait for the spoken one
  session.sendClientContent({ turns: [{ role: "user", parts: [{ text }] }], turnComplete: true });
});
try {
  await turn("Hi! Who are you, in one sentence?");
  ok(audio > 0, `text turn → audio reply ${audio} bytes (24 kHz PCM ≈ ${(audio / 48000).toFixed(1)} s); said: "${said.trim().slice(0, 140)}"`);
  said = ""; audio = 0;
  await turn("Find me a pub halfway for drinks Thursday at 7. I'm at Old Street, my friend is in Clapham.");
  ok(toolCalls.some((c) => c.startsWith("plan")), `tool call: ${toolCalls.join(" | ") || "none"}`);
  ok(audio > 0 && said.length > 0, `after tool → spoken reply: "${said.trim().slice(0, 200)}"`);
  said = ""; audio = 0; toolCalls = [];
  await turn("Great, send it to her for me.");
  ok(!/\bsent\b(?! anything)/i.test(said) || /tap send|you'll need|you need/i.test(said), `send request → tools: ${toolCalls.join(" | ") || "none"}; said: "${said.trim().slice(0, 200)}"`);
} catch (e) { ok(false, String(e.message)); }
session.close();

// 3) light rate limit: 6/min per IP (one already used above + one 403 doesn't count)
let codes = [];
for (let i = 0; i < 6; i++) codes.push((await fetch(`${BASE}/api/live-token`, { method: "POST", headers: IP })).status);
ok(codes.includes(429), `rate limit after a burst: ${codes.join(",")}`);
process.exit();
