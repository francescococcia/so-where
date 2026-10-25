"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentStep, Clarify, PlanResultWithAgent } from "@/lib/plan-types";
import { FIXTURES, clarifyFixture, type FixtureId } from "@/lib/plan-fixture";

export type PlanStatus = "idle" | "running" | "result" | "clarify" | "error";

export type PlanState = {
  status: PlanStatus;
  /** What the user asked (shown); never the accumulated server query. */
  query: string;
  /** Accumulated server query (result.query / clarify query): sent back as previous.query next turn. */
  ask: string;
  /** One-sentence agent reply for refine turns (server `reply`). */
  reply: string | null;
  steps: AgentStep[];
  result: PlanResultWithAgent | null;
  clarify: Clarify | null;
  /** true when we're showing plan-fixture.ts instead of /api/plan */
  example: boolean;
  /** why we fell back, shown next to the "example data" tag */
  exampleReason: string | null;
  elapsedMs: number;
  /** Card blurbs may arrive after the result ({"type":"blurbs"}); true while we wait (max 3 s). */
  blurbsPending: boolean;
  /** Bumped on each new result (not on blurb merges), so the UI can tell a new plan from a filled-in one. */
  resultSeq: number;
  /** Live ask failed with no result at all: a friendly message (never demo data for a live ask). */
  error: string | null;
  /** Set when the server translated the user's words to English first (any-language asks). */
  translated: Translated | null;
};
/** Server `translated` on a result/clarify: the user's language and the model that really did the translation. */
export type Translated = { lang: string; langName: string; model: string };
const translatedOf = (v: unknown): Translated | null => {
  const t = v as Translated | null | undefined;
  return t && typeof t.lang === "string" && typeof t.langName === "string" && typeof t.model === "string" ? { lang: t.lang, langName: t.langName, model: t.model } : null;
};

/** Optional short description on a card (server4, src/lib/blurb.ts). Kept here so plan-types.ts stays unchanged. */
export type Blurb = { text: string; bestFor?: string; source: { name: string; url: string } };
export const blurbOf = (c: unknown): Blurb | null => {
  const b = (c as { blurb?: Blurb } | null)?.blurb;
  return b && typeof b.text === "string" && b.text.trim() && b.source && typeof b.source.url === "string" ? b : null;
};
const BLURB_WAIT_MS = 3000;

const EMPTY: PlanState = { status: "idle", query: "", ask: "", reply: null, steps: [], result: null, clarify: null, example: false, exampleReason: null, elapsedMs: 0, blurbsPending: false, resultSeq: 0, error: null, translated: null };

type Previous = { query: string; answer: string };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); rej(new DOMException("aborted", "AbortError")); }, { once: true });
  });

function upsert(steps: AgentStep[], step: AgentStep) {
  const i = steps.findIndex((s) => s.id === step.id);
  if (i === -1) return [...steps, step];
  const next = steps.slice();
  next[i] = { ...next[i], ...step };
  return next;
}

export function usePlan() {
  const [state, setState] = useState<PlanState>(EMPTY);
  const ctrl = useRef<AbortController | null>(null);
  const blurbTimer = useRef<number | null>(null);

  /** Replay steps one by one so the live rows still animate. */
  const replay = useCallback(async (steps: AgentStep[], signal: AbortSignal) => {
    for (const step of steps) {
      setState((s) => ({ ...s, steps: upsert(s.steps, { ...step, status: "running", detail: undefined, ms: undefined }) }));
      await sleep(Math.min(520, Math.max(160, (step.ms ?? 200) * 0.45)), signal);
      setState((s) => ({ ...s, steps: upsert(s.steps, step) }));
    }
    await sleep(180, signal);
  }, []);

  /** Show a fixture from plan-fixture.ts (always labelled "example data"). */
  const playFixture = useCallback(async (id: FixtureId, query: string, reason: string, signal: AbortSignal, opts?: { clarify?: boolean; lead?: AgentStep; translated?: Translated }) => {
    const base = FIXTURES[id];
    const fx = opts?.lead ? { ...base, steps: [opts.lead, ...base.steps] } : base;
    setState((s) => ({ ...s, example: true, exampleReason: reason }));
    if (opts?.clarify) {
      const steps: AgentStep[] = [
        { id: "parse", label: "Reading your ask", status: "done", detail: "Meet halfway · 2 people", source: "rules", ms: 40 },
        { id: "geocode", label: "Finding both starting points", status: "failed", detail: "Only one place given", source: "—", ms: 0 },
      ];
      await replay(steps, signal);
      setState((s) => ({ ...s, status: "clarify", clarify: clarifyFixture, steps, elapsedMs: 40 }));
      return;
    }
    await replay(fx.steps, signal);
    const total = fx.steps.reduce((a, s) => a + (s.ms ?? 0), 0);
    setState((s) => ({ ...s, status: "result", resultSeq: s.resultSeq + 1, steps: fx.steps, result: { ...fx, query: query || fx.query }, ask: query || fx.query, clarify: null, translated: opts?.translated ?? null, elapsedMs: total }));
  }, [replay]);

  /** `you` is the device location, already rounded to ~100 m by the caller; it is only sent, never stored here. */
  /** opts.refine = previous accumulated query → POST {mode:"refine", query, previous:{query, result?}} (result = the plan on screen, as received; server never stores it); opts.display = ask kept on screen. */
  const submit = useCallback(async (query: string, previous?: Previous, you?: { lat: number; lng: number }, opts?: { refine?: string; display?: string; focus?: { id: string; name: string; lat: number; lng: number }; result?: PlanResultWithAgent | null; /** "auto" | ISO code from the language picker */ lang?: string; /** already translated in the browser (voice, live-translate) */ translated?: { lang: string; model: string; ms?: number } }) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    if (blurbTimer.current) window.clearTimeout(blurbTimer.current);
    const t0 = performance.now();
    const refine = opts?.refine?.trim() || undefined;
    setState((s) => ({ ...EMPTY, resultSeq: s.resultSeq, status: "running", query: opts?.display ?? previous?.query ?? query, ask: refine ?? previous?.query ?? query }));

    let gotTerminal = false;
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          ...(refine ? { mode: "refine", query, previous: { query: refine, ...(opts?.result ? { result: opts.result } : {}) } } : previous ? { query: previous.query, answer: previous.answer, previous } : { query }),
          ...(you ? { you } : {}),
          // Refine only: the place the follow-up is about ("other Italian places in the area").
          ...(refine && opts?.focus ? { focus: opts.focus } : {}),
          // Any language: omitted for plain English so the request is byte-for-byte what it was.
          ...(opts?.lang && opts.lang !== "auto" ? { lang: opts.lang } : {}),
          ...(opts?.translated ? { translated: opts.translated } : {}),
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(`/api/plan answered ${res.status}`);

      const handle = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const msg = JSON.parse(trimmed);
        if (msg.type === "step" && msg.step) {
          setState((s) => ({ ...s, steps: upsert(s.steps, msg.step as AgentStep) }));
        } else if (msg.type === "result" && msg.result) {
          gotTerminal = true;
          const result = msg.result as PlanResultWithAgent & { reply?: string; leaveBy?: unknown };
          // leaveBy may ride on the line instead of the result; keep it on the result either way.
          if (!result.leaveBy && msg.leaveBy) result.leaveBy = msg.leaveBy;
          // Top-3 cards without a blurb yet: one may follow as {"type":"blurbs"}; shimmer for at most 3 s.
          const waiting = result.cards.slice(0, 3).some((c) => !blurbOf(c));
          if (waiting) {
            if (blurbTimer.current) window.clearTimeout(blurbTimer.current);
            blurbTimer.current = window.setTimeout(() => setState((s) => (s.blurbsPending ? { ...s, blurbsPending: false } : s)), BLURB_WAIT_MS);
          }
          setState((s) => ({
            ...s,
            blurbsPending: waiting,
            resultSeq: s.resultSeq + 1,
            status: "result",
            result,
            ask: typeof result.query === "string" && result.query ? result.query : s.ask,
            reply: typeof result.reply === "string" && result.reply ? result.reply : null,
            clarify: null,
            translated: translatedOf((result as { translated?: unknown }).translated),
            steps: result.steps?.length ? result.steps : s.steps,
            elapsedMs: performance.now() - t0,
          }));
        } else if (msg.type === "blurbs" && msg.blurbs && typeof msg.blurbs === "object") {
          // Late blurbs: merge into the result on screen (so refine's previous.result carries them too).
          const map = msg.blurbs as Record<string, Blurb>;
          if (blurbTimer.current) window.clearTimeout(blurbTimer.current);
          setState((s) => (s.result ? { ...s, blurbsPending: false, result: { ...s.result, cards: s.result.cards.map((c) => (blurbOf({ blurb: map[c.id] }) ? { ...c, blurb: map[c.id] } : c)) } } : s));
        } else if (msg.type === "error") {
          // An error after a result/clarify keeps what's on screen; with nothing yet, the catch below shows a friendly error.
          if (!gotTerminal) throw new Error(typeof msg.error === "string" ? msg.error : "Planning failed");
          // The server's own fallback ("Sorry, I couldn't plan that…", no cards) then an error: show the friendly error box instead of an empty plan.
          setState((s) =>
            s.status === "result" && s.result && !s.result.cards.length
              ? { ...s, status: "error", blurbsPending: false, error: s.result.headline || "Sorry, I couldn't plan that just now. Try again in a moment, or rephrase it." }
              : s,
          );
        } else if (msg.type === "clarify" && msg.clarify) {
          gotTerminal = true;
          // The server returns the cumulative query on clarify; keep it so the next answer goes back as previous:{query, answer}.
          setState((s) => ({ ...s, status: "clarify", ask: typeof msg.query === "string" ? msg.query : s.ask, reply: typeof msg.reply === "string" ? msg.reply : null, clarify: msg.clarify as Clarify, translated: translatedOf(msg.translated), elapsedMs: performance.now() - t0 }));
        }
      };

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          handle(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      }
      handle(buf + decoder.decode());
      if (!gotTerminal) throw new Error("stream ended without a plan");
    } catch (err) {
      if ((err as Error)?.name === "AbortError" || ac.signal.aborted) return;
      if (gotTerminal) return;
      // Live ask, no result at all: say so plainly. Demo data only ever comes from ?demo= links (showFixture).
      const offline = typeof navigator !== "undefined" && navigator.onLine === false;
      setState((s) => ({
        ...s,
        status: "error",
        blurbsPending: false,
        error: offline ? "You look offline. Check your connection and try again." : "Sorry, I couldn't plan that just now. Try again in a moment, or rephrase it.",
        elapsedMs: performance.now() - t0,
      }));
    }
  }, []);

  /** Show a fixture straight away (used by ?demo=meet|saturday|translate). `display` = the ask shown on screen. */
  const showFixture = useCallback((id: FixtureId, opts?: { display?: string; lead?: AgentStep; translated?: Translated }) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setState({ ...EMPTY, status: "running", query: opts?.display ?? FIXTURES[id].query });
    playFixture(id, FIXTURES[id].query, "demo link", ac.signal, { lead: opts?.lead, translated: opts?.translated }).catch(() => {});
  }, [playFixture]);

  const reset = useCallback(() => {
    ctrl.current?.abort();
    setState(EMPTY);
  }, []);

  return { state, submit, showFixture, reset };
}
