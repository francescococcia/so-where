"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentStep, Clarify, PlanResultWithAgent } from "@/lib/plan-types";
import { FIXTURES, clarifyFixture, pickFixture, type FixtureId } from "@/lib/plan-fixture";

export type PlanStatus = "idle" | "running" | "result" | "clarify";

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
};

const EMPTY: PlanState = { status: "idle", query: "", ask: "", reply: null, steps: [], result: null, clarify: null, example: false, exampleReason: null, elapsedMs: 0 };

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
  const playFixture = useCallback(async (id: FixtureId, query: string, reason: string, signal: AbortSignal, opts?: { clarify?: boolean }) => {
    const fx = FIXTURES[id];
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
    setState((s) => ({ ...s, status: "result", steps: fx.steps, result: { ...fx, query: query || fx.query }, ask: query || fx.query, clarify: null, elapsedMs: total }));
  }, [replay]);

  /** `you` is the device location, already rounded to ~100 m by the caller; it is only sent, never stored here. */
  /** opts.refine = previous accumulated query → POST {mode:"refine", query, previous:{query, result?}} (result = the plan on screen, as received; server never stores it); opts.display = ask kept on screen. */
  const submit = useCallback(async (query: string, previous?: Previous, you?: { lat: number; lng: number }, opts?: { refine?: string; display?: string; focus?: { id: string; name: string; lat: number; lng: number }; result?: PlanResultWithAgent | null }) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    const t0 = performance.now();
    const refine = opts?.refine?.trim() || undefined;
    setState({ ...EMPTY, status: "running", query: opts?.display ?? previous?.query ?? query, ask: refine ?? previous?.query ?? query });

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
          const result = msg.result as PlanResultWithAgent & { reply?: string };
          setState((s) => ({
            ...s,
            status: "result",
            result,
            ask: typeof result.query === "string" && result.query ? result.query : s.ask,
            reply: typeof result.reply === "string" && result.reply ? result.reply : null,
            clarify: null,
            steps: result.steps?.length ? result.steps : s.steps,
            elapsedMs: performance.now() - t0,
          }));
        } else if (msg.type === "clarify" && msg.clarify) {
          gotTerminal = true;
          // The server returns the cumulative query on clarify; keep it so the next answer goes back as previous:{query, answer}.
          setState((s) => ({ ...s, status: "clarify", ask: typeof msg.query === "string" ? msg.query : s.ask, reply: typeof msg.reply === "string" ? msg.reply : null, clarify: msg.clarify as Clarify, elapsedMs: performance.now() - t0 }));
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
      const reason = err instanceof Error ? err.message : "planner unavailable";
      const ask = refine ?? previous?.query ?? query;
      const id = pickFixture(ask);
      // The coffee example has no friend location: show the clarify turn first.
      const needsClarify = !previous && id === "meet" && !/she'?s|he'?s|they'?re|friend'?s? (?:at|in)|around/i.test(ask);
      setState((s) => ({ ...s, steps: [] }));
      try {
        await playFixture(id, opts?.display ?? ask, reason, ac.signal, { clarify: needsClarify });
      } catch {
        /* aborted */
      }
    }
  }, [playFixture]);

  /** Show a fixture straight away (used by ?demo=meet|saturday). */
  const showFixture = useCallback((id: FixtureId) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    setState({ ...EMPTY, status: "running", query: FIXTURES[id].query });
    playFixture(id, FIXTURES[id].query, "demo link", ac.signal).catch(() => {});
  }, [playFixture]);

  const reset = useCallback(() => {
    ctrl.current?.abort();
    setState(EMPTY);
  }, []);

  return { state, submit, showFixture, reset };
}
