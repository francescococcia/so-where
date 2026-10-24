"use client";

import { useCallback, useRef, useState } from "react";
import type { AgentStep, Clarify, PlanResultWithAgent } from "@/lib/plan-types";
import { FIXTURES, clarifyFixture, pickFixture, type FixtureId } from "@/lib/plan-fixture";

export type PlanStatus = "idle" | "running" | "result" | "clarify";

export type PlanState = {
  status: PlanStatus;
  query: string;
  steps: AgentStep[];
  result: PlanResultWithAgent | null;
  clarify: Clarify | null;
  /** true when we're showing plan-fixture.ts instead of /api/plan */
  example: boolean;
  /** why we fell back, shown next to the "example data" tag */
  exampleReason: string | null;
  elapsedMs: number;
};

const EMPTY: PlanState = { status: "idle", query: "", steps: [], result: null, clarify: null, example: false, exampleReason: null, elapsedMs: 0 };

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
    setState((s) => ({ ...s, status: "result", steps: fx.steps, result: { ...fx, query: query || fx.query }, clarify: null, elapsedMs: total }));
  }, [replay]);

  /** `you` is the device location, already rounded to ~100 m by the caller; it is only sent, never stored here. */
  const submit = useCallback(async (query: string, previous?: Previous, you?: { lat: number; lng: number }) => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    const t0 = performance.now();
    setState({ ...EMPTY, status: "running", query: previous?.query ?? query });

    let gotTerminal = false;
    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({ ...(previous ? { query: previous.query, answer: previous.answer, previous } : { query }), ...(you ? { you } : {}) }),
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
          const result = msg.result as PlanResultWithAgent;
          setState((s) => ({
            ...s,
            status: "result",
            result,
            clarify: null,
            steps: result.steps?.length ? result.steps : s.steps,
            elapsedMs: performance.now() - t0,
          }));
        } else if (msg.type === "clarify" && msg.clarify) {
          gotTerminal = true;
          setState((s) => ({ ...s, status: "clarify", clarify: msg.clarify as Clarify, elapsedMs: performance.now() - t0 }));
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
      const ask = previous?.query ?? query;
      const id = pickFixture(ask);
      // The coffee example has no friend location: show the clarify turn first.
      const needsClarify = !previous && id === "meet" && !/she'?s|he'?s|they'?re|friend'?s? (?:at|in)|around/i.test(ask);
      setState((s) => ({ ...s, steps: [] }));
      try {
        await playFixture(id, ask, reason, ac.signal, { clarify: needsClarify });
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
