"use client";
// "Any language" mic: records one short spoken ask (16 kHz PCM, in memory only), stops after a pause, and sends it
// once to /api/translate, where gemini-3.5-live-translate-preview turns it into English. Nothing is stored or logged;
// the buffer is dropped as soon as the request is made.
import { useCallback, useEffect, useRef, useState } from "react";
import { WORKLET, toBase64 } from "@/lib/live-session";

export type HeardTranslation = { lang: string; langName: string; english: string; original: string; model: string; ms: number };

const MAX_MS = 12_000;
const SILENCE_MS = 1300;
const SPEECH_RMS = 0.02;

export function useTranslateMic({ onResult, onError }: { onResult: (r: HeardTranslation) => void; onError: (msg: string) => void }) {
  const [state, setState] = useState<"idle" | "listening" | "translating">("idle");
  const cb = useRef({ onResult, onError });
  cb.current = { onResult, onError };
  const r = useRef<{ ctx: AudioContext | null; stream: MediaStream | null; node: AudioWorkletNode | null; chunks: Int16Array[]; timer: number | null; heard: boolean; quietSince: number; t0: number } | null>(null);
  const supported = typeof window !== "undefined" && typeof AudioWorkletNode !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  const teardown = () => {
    const s = r.current;
    if (!s) return null;
    r.current = null;
    if (s.timer) window.clearTimeout(s.timer);
    try { s.node?.disconnect(); } catch {}
    s.stream?.getTracks().forEach((t) => t.stop());
    void s.ctx?.close().catch(() => {});
    return s;
  };

  const finish = useCallback(async () => {
    const s = teardown();
    if (!s) return;
    const n = s.chunks.reduce((a, c) => a + c.length, 0);
    if (!s.heard || n < 16000 * 0.4) {
      setState("idle");
      cb.current.onError("Didn't catch that.");
      return;
    }
    const pcm = new Int16Array(n);
    let o = 0;
    for (const c of s.chunks) { pcm.set(c, o); o += c.length; }
    s.chunks = [];
    setState("translating");
    const t0 = performance.now();
    try {
      const res = await fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ audio: toBase64(pcm.buffer) }) });
      const j = (await res.json()) as Partial<HeardTranslation> & { error?: string };
      if (!res.ok || !j.english) throw new Error(j.error || "translate failed");
      cb.current.onResult({ lang: j.lang ?? "und", langName: j.langName ?? "Spoken", english: j.english, original: j.original ?? j.english, model: j.model ?? "", ms: performance.now() - t0 });
    } catch {
      cb.current.onError("Couldn't translate that. Try again or type it.");
    } finally {
      setState("idle");
    }
  }, []);

  const start = useCallback(async () => {
    if (r.current || !supported) return;
    setState("listening");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      const node = new AudioWorkletNode(ctx, "sw-mic");
      const s = { ctx, stream, node, chunks: [] as Int16Array[], timer: null as number | null, heard: false, quietSince: performance.now(), t0: performance.now() };
      r.current = s;
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        if (r.current !== s) return;
        s.chunks.push(new Int16Array(e.data.pcm));
        const now = performance.now();
        if (e.data.rms > SPEECH_RMS) { s.heard = true; s.quietSince = now; }
        else if (s.heard && now - s.quietSince > SILENCE_MS) void finish();
        if (now - s.t0 > MAX_MS) void finish();
      };
      ctx.createMediaStreamSource(stream).connect(node);
      s.timer = window.setTimeout(() => { if (r.current === s && !s.heard) { teardown(); setState("idle"); cb.current.onError("Didn't catch that."); } }, 7000);
    } catch {
      teardown();
      setState("idle");
      cb.current.onError("Mic blocked. Type instead.");
    }
  }, [supported, finish]);

  const toggle = useCallback(() => {
    if (state === "listening") void finish();
    else if (state === "idle") void start();
  }, [state, start, finish]);

  useEffect(() => () => { teardown(); }, []);
  return { supported, state, toggle };
}
