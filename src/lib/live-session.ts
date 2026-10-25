"use client";
// useLiveVoice: a spoken conversation with Gemini Live, straight from the browser.
// - Auth: a one-use ephemeral token from POST /api/live-token (the API key never reaches the browser).
// - Mic: getUserMedia → AudioWorklet → 16 kHz 16-bit PCM chunks (~50 ms) → session.sendRealtimeInput.
// - Speaker: 24 kHz PCM from the model, scheduled gap-free; flushed instantly on barge-in (server `interrupted`).
// - Tools: function calls are handed to the app's `onTool` and the short string it returns goes back to the model.
// Privacy: no audio or transcript is recorded, stored, uploaded elsewhere or logged. Captions live in memory only
// (last line each side) and are cleared when the session ends.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveServerMessage, Session } from "@google/genai";
import { LIVE_SYSTEM_PROMPT, LIVE_TOOLS, LIVE_TOOL_NAMES, LIVE_VOICE_NAME, type LiveToolCall, type LiveToolHandler } from "./live-config";

export type LiveState = "idle" | "connecting" | "listening" | "thinking" | "speaking";
export type LiveCaptions = { you: string; agent: string };

export type UseLiveVoiceOptions = {
  onTool: LiveToolHandler;
  /** Live couldn't start (no token, socket refused, timeout, no AudioWorklet). Use the Web Speech mic instead. */
  onFallback?: (reason: string) => void;
  /** Optional one-line app context sent silently at the start (e.g. "A plan is on screen: top pick X"). */
  context?: () => string | null | undefined;
  /** Endpoint override (tests). */
  tokenUrl?: string;
};

const CONNECT_TIMEOUT_MS = 9000;
const TOOL_TIMEOUT_MS = 55_000;
const CAPTION_MAX = 110;

const WORKLET = `
class SwMic extends AudioWorkletProcessor {
  constructor() { super(); this.ratio = sampleRate / 16000; this.buf = new Int16Array(800); this.n = 0; this.pos = 0; this.acc = 0; this.cnt = 0; this.sq = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        let s = this.acc / this.cnt; this.acc = 0; this.cnt = 0;
        s = s > 1 ? 1 : s < -1 ? -1 : s;
        this.sq += s * s;
        this.buf[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.n === this.buf.length) {
          this.port.postMessage({ pcm: this.buf.buffer, rms: Math.sqrt(this.sq / this.n) }, [this.buf.buffer]);
          this.buf = new Int16Array(800); this.n = 0; this.sq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("sw-mic", SwMic);`;

function toBase64(buf: ArrayBuffer) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64Pcm16(b64: string) {
  const bin = atob(b64);
  const n = bin.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    out[i] = v / 0x8000;
  }
  return out;
}
/** Keep the tail of a running caption short, cut at a word. */
function tail(s: string) {
  const t = s.replace(/\s+/g, " ").trimStart();
  if (t.length <= CAPTION_MAX) return t;
  const cut = t.slice(-CAPTION_MAX);
  const sp = cut.indexOf(" ");
  return "…" + (sp > 0 && sp < 20 ? cut.slice(sp + 1) : cut);
}

function asCall(name: string | undefined, args: unknown): LiveToolCall | null {
  if (!name || !(LIVE_TOOL_NAMES as string[]).includes(name)) return null;
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 400) : undefined);
  switch (name) {
    case "plan": return { name, args: { query: str(a.query) ?? "" } };
    case "refine": return { name, args: { text: str(a.text) ?? "" } };
    case "focus": return { name, args: { index: typeof a.index === "number" ? a.index : undefined, name: str(a.name) } };
    case "isOpen": return { name, args: { name: str(a.name) } };
    case "leaveBy": return { name, args: { name: str(a.name) } };
    default: return { name: "draftMessage", args: {} };
  }
}

export function useLiveVoice({ onTool, onFallback, context, tokenUrl = "/api/live-token" }: UseLiveVoiceOptions) {
  const [state, setStateRaw] = useState<LiveState>("idle");
  const [captions, setCaptions] = useState<LiveCaptions>({ you: "", agent: "" });
  const [model, setModel] = useState<string | null>(null);
  const cb = useRef({ onTool, onFallback, context });
  cb.current = { onTool, onFallback, context };

  const r = useRef({
    session: null as Session | null,
    stream: null as MediaStream | null,
    inCtx: null as AudioContext | null,
    outCtx: null as AudioContext | null,
    analyser: null as AnalyserNode | null,
    node: null as AudioWorkletNode | null,
    sources: new Set<AudioBufferSourceNode>(),
    nextTime: 0,
    turnDone: true,
    micLevel: 0,
    gen: 0,
    state: "idle" as LiveState,
    lastSpeaker: "agent" as "you" | "agent",
    thinkTimer: 0 as number | ReturnType<typeof setTimeout>,
    cancelled: new Set<string>(),
    toolsPending: 0,
  });

  const setState = useCallback((s: LiveState) => {
    r.current.state = s;
    setStateRaw(s);
  }, []);

  /** Current loudness 0..1 (mic while listening, speaker while speaking). Read it in rAF; it's not React state. */
  const getLevel = useCallback(() => {
    const x = r.current;
    if (x.state === "speaking" && x.analyser) {
      const a = new Uint8Array(x.analyser.fftSize);
      x.analyser.getByteTimeDomainData(a);
      let sq = 0;
      for (const v of a) sq += ((v - 128) / 128) ** 2;
      return Math.min(1, Math.sqrt(sq / a.length) * 3.2);
    }
    return x.state === "listening" ? Math.min(1, x.micLevel * 6) : 0;
  }, []);

  const flush = useCallback(() => {
    const x = r.current;
    for (const s of x.sources) try { s.stop(); } catch { /* already ended */ }
    x.sources.clear();
    x.nextTime = 0;
  }, []);

  const teardown = useCallback(() => {
    const x = r.current;
    x.gen++;
    clearTimeout(x.thinkTimer as number);
    flush();
    try { x.session?.close(); } catch { /* closed */ }
    x.session = null;
    x.node?.port.close();
    x.node?.disconnect();
    x.node = null;
    x.stream?.getTracks().forEach((t) => t.stop());
    x.stream = null;
    x.inCtx?.close().catch(() => {});
    x.outCtx?.close().catch(() => {});
    x.inCtx = x.outCtx = null;
    x.analyser = null;
    x.micLevel = 0;
    x.turnDone = true;
    x.cancelled.clear();
    x.toolsPending = 0;
    setCaptions({ you: "", agent: "" });
  }, [flush]);

  const stop = useCallback(() => {
    teardown();
    setState("idle");
  }, [teardown, setState]);

  useEffect(() => () => teardown(), [teardown]);

  const play = useCallback((b64: string) => {
    const x = r.current;
    const ctx = x.outCtx;
    if (!ctx) return;
    const pcm = fromBase64Pcm16(b64);
    if (!pcm.length) return;
    const buf = ctx.createBuffer(1, pcm.length, 24000);
    buf.copyToChannel(pcm, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(x.analyser ?? ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, x.nextTime);
    src.start(at);
    x.nextTime = at + buf.duration;
    x.sources.add(src);
    src.onended = () => {
      x.sources.delete(src);
      if (!x.sources.size && x.turnDone && x.state === "speaking") setState("listening");
    };
  }, [setState]);

  const runTools = useCallback(async (calls: { id?: string; name?: string; args?: Record<string, unknown> }[], gen: number) => {
    const x = r.current;
    x.toolsPending++;
    setState("thinking");
    const responses = await Promise.all(
      calls.map(async (fc) => {
        const call = asCall(fc.name, fc.args);
        let output: string;
        if (!call) output = "Unknown tool.";
        else {
          try {
            output = await Promise.race([
              Promise.resolve(cb.current.onTool(call)),
              new Promise<string>((res) => setTimeout(() => res("That took too long. Say sorry briefly and offer to try again."), TOOL_TIMEOUT_MS)),
            ]);
          } catch {
            output = "That didn't work just now.";
          }
        }
        if (call?.name === "draftMessage") output += " (Draft only. Nothing was sent; the user must tap Send.)";
        return { id: fc.id, name: fc.name, response: { output: String(output ?? "").slice(0, 1200) } };
      }),
    );
    x.toolsPending = Math.max(0, x.toolsPending - 1);
    if (gen !== x.gen || !x.session) return;
    const live = responses.filter((f) => !f.id || !x.cancelled.has(f.id));
    if (live.length) x.session.sendToolResponse({ functionResponses: live });
  }, [setState]);

  const onMessage = useCallback((m: LiveServerMessage, gen: number) => {
    const x = r.current;
    if (gen !== x.gen) return;
    if (m.toolCall?.functionCalls?.length) {
      runTools(m.toolCall.functionCalls, gen);
      return;
    }
    if (m.toolCallCancellation?.ids) m.toolCallCancellation.ids.forEach((id) => x.cancelled.add(id));
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.interrupted) {
      // Barge-in: the user spoke over us. Drop queued audio at once.
      flush();
      x.turnDone = true;
      setState("listening");
    }
    const heard = sc.inputTranscription?.text;
    if (heard) {
      if (x.state === "speaking") flush(); // also cut locally; the server's `interrupted` follows
      setCaptions((c) => ({ ...c, you: tail((x.lastSpeaker === "you" ? c.you : "") + heard) }));
      x.lastSpeaker = "you";
      if (x.state !== "thinking") setState("listening");
      clearTimeout(x.thinkTimer as number);
      x.thinkTimer = setTimeout(() => { if (x.state === "listening" && gen === x.gen) setState("thinking"); }, 900);
    }
    const said = sc.outputTranscription?.text;
    if (said) {
      setCaptions((c) => ({ ...c, agent: tail((x.lastSpeaker === "agent" ? c.agent : "") + said) }));
      x.lastSpeaker = "agent";
    }
    for (const p of sc.modelTurn?.parts ?? []) {
      if (p.inlineData?.data && p.inlineData.mimeType?.startsWith("audio/")) {
        clearTimeout(x.thinkTimer as number);
        x.turnDone = false;
        play(p.inlineData.data);
        if (x.state !== "speaking") setState("speaking");
      }
    }
    if (sc.turnComplete) {
      x.turnDone = true;
      clearTimeout(x.thinkTimer as number);
      // A tool call ends the model's turn too; stay "thinking" until the tool answers and it speaks.
      if (!x.sources.size && !x.toolsPending && x.state !== "listening") setState("listening");
    }
  }, [flush, play, runTools, setState]);

  const start = useCallback(async () => {
    const x = r.current;
    if (x.state !== "idle") return;
    teardown();
    const gen = x.gen;
    setState("connecting");
    const fail = (reason: string) => {
      if (gen !== r.current.gen) return;
      teardown();
      setState("idle");
      cb.current.onFallback?.(reason);
    };
    try {
      if (typeof AudioWorkletNode === "undefined" || !navigator.mediaDevices?.getUserMedia) return fail("no-audio-worklet");
      // Contexts are created inside the tap so autoplay rules let them run.
      const inCtx = new AudioContext();
      const outCtx = new AudioContext({ sampleRate: 24000 });
      x.inCtx = inCtx;
      x.outCtx = outCtx;
      const analyser = outCtx.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(outCtx.destination);
      x.analyser = analyser;

      const tokenP = fetch(tokenUrl, { method: "POST", cache: "no-store" }).then(async (res) => {
        if (!res.ok) throw new Error(`token ${res.status}`);
        return (await res.json()) as { token: string; model: string };
      });
      const micP = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then((s) => {
        // Track it at once so a later failure still releases the mic.
        if (gen === r.current.gen) r.current.stream = s;
        else s.getTracks().forEach((t) => t.stop());
        return s;
      });
      const sdkP = import("@google/genai");
      const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      const workletP = inCtx.audioWorklet.addModule(workletUrl).finally(() => URL.revokeObjectURL(workletUrl));
      const [{ token, model: liveModel }, stream, { GoogleGenAI, Modality }] = await Promise.all([tokenP, micP, sdkP, workletP]);
      if (gen !== x.gen) return;
      setModel(liveModel);

      const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: "v1alpha" } });
            const session = await Promise.race([
        ai.live.connect({
          model: liveModel,
          // Locked server-side in the token too; sent here so a dev key without constraints behaves the same.
          config: {
            responseModalities: [Modality.AUDIO],
            systemInstruction: LIVE_SYSTEM_PROMPT,
            tools: [{ functionDeclarations: LIVE_TOOLS }],
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE_NAME } } },
          },
          callbacks: {
            onopen: () => {},
            onmessage: (m) => onMessage(m, gen),
            onerror: () => { if (gen === r.current.gen && r.current.state === "connecting") fail("socket-error"); },
            onclose: () => {
              if (gen !== r.current.gen) return;
              if (r.current.state === "connecting") fail("closed-early");
              else stop();
            },
          },
        }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("connect timeout")), CONNECT_TIMEOUT_MS)),
      ]);
      if (gen !== x.gen) { try { session.close(); } catch { /* */ } return; }
      x.session = session;

      const ctxLine = cb.current.context?.();
      if (ctxLine) session.sendClientContent({ turns: [{ role: "user", parts: [{ text: `[App context, don't read this out] ${ctxLine.slice(0, 600)}` }] }], turnComplete: false });

      const srcNode = inCtx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(inCtx, "sw-mic");
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        if (gen !== r.current.gen || !r.current.session) return;
        r.current.micLevel = e.data.rms;
        r.current.session.sendRealtimeInput({ audio: { data: toBase64(e.data.pcm), mimeType: "audio/pcm;rate=16000" } });
      };
      srcNode.connect(node);
      // Keep the graph pulling without making the mic audible.
      const mute = inCtx.createGain();
      mute.gain.value = 0;
      node.connect(mute).connect(inCtx.destination);
      x.node = node;
      await Promise.all([inCtx.resume(), outCtx.resume()]);
      if (gen === x.gen) setState("listening");
    } catch (e) {
      const name = (e as Error)?.name;
      fail(name === "NotAllowedError" ? "mic-denied" : "connect-failed");
    }
  }, [teardown, setState, tokenUrl, onMessage, stop]);

  /** Typed turn into the same conversation (also used by tests). */
  const sendText = useCallback((text: string) => {
    const s = r.current.session;
    if (!s || !text.trim()) return;
    s.sendClientContent({ turns: [{ role: "user", parts: [{ text: text.slice(0, 500) }] }], turnComplete: true });
    setState("thinking");
  }, [setState]);

  const toggle = useCallback(() => (r.current.state === "idle" ? start() : stop()), [start, stop]);

  return { state, active: state !== "idle", captions, model, start, stop, toggle, sendText, getLevel };
}
