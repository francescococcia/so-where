// Probe: mint an ephemeral token with the server key, then open a Live session with it and send a text turn.
import { GoogleGenAI, Modality } from "@google/genai";
const model = process.argv[2] || "gemini-3.8-live";
const key = process.env.GEMINI_API_KEY;
const admin = new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1alpha" } });
const now = Date.now();
const tok = await admin.authTokens.create({ config: { uses: 1, expireTime: new Date(now + 30 * 60e3).toISOString(), newSessionExpireTime: new Date(now + 60e3).toISOString(), httpOptions: { apiVersion: "v1alpha" } } });
console.log("token ok:", typeof tok.name === "string" && tok.name.startsWith("auth_tokens/"));
const ai = new GoogleGenAI({ apiKey: tok.name, httpOptions: { apiVersion: "v1alpha" } });
let text = "", audioBytes = 0, outTx = "";
const done = new Promise((res, rej) => {
  setTimeout(() => rej(new Error("timeout")), 25000);
  ai.live.connect({ model, config: { responseModalities: [Modality.AUDIO], outputAudioTranscription: {}, systemInstruction: "Reply in one short British English sentence." },
    callbacks: { onopen: () => console.log("open"), onerror: (e) => rej(new Error(e.message || "ws error")), onclose: (e) => { if (!audioBytes && !text) rej(new Error("closed " + e.code + " " + e.reason)); },
      onmessage: (m) => { const sc = m.serverContent; if (sc?.modelTurn?.parts) for (const p of sc.modelTurn.parts) { if (p.text) text += p.text; if (p.inlineData?.data) audioBytes += Buffer.from(p.inlineData.data, "base64").length; }
        if (sc?.outputTranscription?.text) outTx += sc.outputTranscription.text; if (sc?.turnComplete) res(); } } }).then((s) => { globalThis.s = s; s.sendClientContent({ turns: [{ role: "user", parts: [{ text: "Say hello and name one London park." }] }], turnComplete: true }); }, rej);
});
try { await done; console.log(JSON.stringify({ model, ok: true, audioBytes, text: text.slice(0, 120), transcript: outTx.slice(0, 160) })); } catch (e) { console.log(JSON.stringify({ model, ok: false, error: String(e.message).slice(0, 300) })); }
globalThis.s?.close(); process.exit(0);
