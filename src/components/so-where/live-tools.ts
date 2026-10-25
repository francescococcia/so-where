"use client";
// useLiveTools: turns the app's existing actions into the six voice tools for <LiveVoiceButton onTool>.
// Everything is answered from what's already on screen or from the normal /api/plan flow (via the app's own
// ask/refine). Replies are short and never include the other person's area, street or station.
import { useCallback, useEffect, useRef } from "react";
import type { PlanCard, PlanResultWithAgent } from "@/lib/plan-types";
import type { LiveToolCall } from "@/lib/live-config";
import type { PlanState } from "./use-plan";
import { leaveByOf } from "./blurb";

export type LiveToolsDeps = {
  /** usePlan().state */
  state: PlanState;
  /** The plan currently on screen (the app's `view`, else state.result). */
  view: PlanResultWithAgent | null;
  /** Card the user has open/selected, if any. */
  selectedId?: string | null;
  /** New ask (the app's askOrAnswer: also answers an open clarify question). */
  ask: (q: string) => void;
  /** Follow-up on the plan on screen (the app's refine). */
  refine: (text: string) => void;
  /** Open a card on the map/detail panel (the app's openDetail). */
  openDetail: (id: string) => void;
  /** Open the Send dialog. Must only open it; never send. */
  openSend: () => void;
};

const PLAN_WAIT_MS = 50_000;
const ukTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
};
const kind = (c: PlanCard) => c.subtitle.split("·")[0]?.trim() ?? "";
const mins = (c: PlanCard) => {
  const you = c.legs.find((l) => l.who === "you")?.minutes;
  const them = c.legs.find((l) => l.who === "them")?.minutes;
  return [you != null ? `you ${Math.round(you)} min` : "", them != null ? `them ${Math.round(them)} min` : ""].filter(Boolean).join(", ");
};

/** "Top picks: 1) The George, pub, you 18 min, them 21 min: quiet back room. 2) …" (no addresses). */
export function summarisePlan(r: PlanResultWithAgent | null, reply?: string | null): string {
  if (!r || !r.cards.length) return reply || r?.headline || "No places came back for that.";
  const picks = r.cards.slice(0, 3).map((c, i) => `${i + 1}) ${c.name}${kind(c) ? `, ${kind(c)}` : ""}${mins(c) ? `, ${mins(c)}` : ""}${c.why ? `: ${c.why}` : ""}`);
  const when = ukTime(r.when);
  return `${reply ? reply + " " : ""}${r.headline}${when ? ` (for ${when})` : ""}. Top picks: ${picks.join(" ")}`.slice(0, 900);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
function findCard(cards: PlanCard[], name?: string, index?: number, fallbackId?: string | null): PlanCard | null {
  if (index != null && cards[index - 1]) return cards[index - 1];
  if (name) {
    const n = norm(name);
    const ord = ["first", "second", "third"].findIndex((w) => n.includes(w));
    if (ord >= 0 && cards[ord]) return cards[ord];
    const hit = cards.find((c) => norm(c.name) === n) ?? cards.find((c) => norm(c.name).includes(n) || n.includes(norm(c.name)));
    if (hit) return hit;
    const words = n.split(" ").filter((w) => w.length > 2 && w !== "the");
    const scored = cards.map((c) => ({ c, s: words.filter((w) => norm(c.name).includes(w)).length })).sort((a, b) => b.s - a.s);
    if (scored[0]?.s) return scored[0].c;
    return null;
  }
  return cards.find((c) => c.id === fallbackId) ?? cards[0] ?? null;
}

export function useLiveTools(deps: LiveToolsDeps) {
  const d = useRef(deps);
  d.current = deps;
  // Latest plan state for the waiter (state changes land after ask/refine return).
  const st = useRef(deps.state);
  useEffect(() => { st.current = deps.state; }, [deps.state]);

  /** Resolve once the run we just started has finished (result, clarify or error). */
  const settle = useCallback(async () => {
    const t0 = Date.now();
    let sawRunning = false;
    while (Date.now() - t0 < PLAN_WAIT_MS) {
      await new Promise((r) => setTimeout(r, 150));
      const s = st.current;
      if (s.status === "running") sawRunning = true;
      else if (sawRunning || Date.now() - t0 > 2500) return s;
    }
    return st.current;
  }, []);

  const outcome = (s: PlanState) => {
    if (s.status === "clarify" && s.clarify) return `Need one thing first: ${s.clarify.question}`;
    if (s.status === "error") return s.error || "That didn't work just now.";
    if (s.status === "running") return "Still working on it; the picks will appear on screen.";
    return summarisePlan(s.result, s.reply);
  };

  const onTool = useCallback(async (call: LiveToolCall): Promise<string> => {
    const { view, selectedId, ask, refine, openDetail, openSend } = d.current;
    const cards = view?.cards ?? [];
    switch (call.name) {
      case "plan": {
        if (!call.args.query.trim()) return "I need the ask: who's meeting, from where, and when.";
        ask(call.args.query);
        return outcome(await settle());
      }
      case "refine": {
        if (!cards.length) return "There's no plan on screen yet. Ask for one first.";
        if (!call.args.text.trim()) return "What should change?";
        refine(call.args.text);
        return outcome(await settle());
      }
      case "focus": {
        const c = findCard(cards, call.args.name, call.args.index, selectedId);
        if (!c) return cards.length ? `Couldn't find that one. On screen: ${cards.map((x) => x.name).join(", ")}.` : "No plan on screen yet.";
        openDetail(c.id);
        return `Opened ${c.name}${kind(c) ? ` (${kind(c)})` : ""}${mins(c) ? `, ${mins(c)}` : ""}. ${c.why}`.trim();
      }
      case "isOpen": {
        const c = findCard(cards, call.args.name, undefined, selectedId);
        if (!c) return "No place on screen to check.";
        const f = c.facts.find((x) => /^open\b|hours|closed/i.test(x.label) || /^(open|closed)\b/i.test(x.value));
        if (!f) return `No opening hours on file for ${c.name}; worth checking before you go.`;
        const hedge = f.verdict === "confirmed" ? "" : f.verdict === "likely" ? " (likely; from listed hours)" : " (not confirmed)";
        return `${c.name}: ${f.label} ${f.value}${hedge}. Plan is for ${ukTime(view!.when)}.`;
      }
      case "leaveBy": {
        const c = findCard(cards, call.args.name, undefined, selectedId);
        if (!c || !view) return "No place on screen yet.";
        const lb = c === cards[0] ? leaveByOf(view) : null;
        if (lb?.you) return `Leave by ${lb.you} to get to ${c.name} for ${lb.arriveBy}.`;
        const you = c.legs.find((l) => l.who === "you")?.minutes;
        const at = new Date(view.when);
        if (you == null || Number.isNaN(at.getTime())) return `No journey time for ${c.name}.`;
        const leave = new Date(at.getTime() - (Math.round(you) + 5) * 60_000).toISOString();
        return `About ${Math.round(you)} min away: leave by ${ukTime(leave)} to arrive for ${ukTime(view.when)} with a few minutes spare.`;
      }
      case "draftMessage": {
        if (!cards.length) return "Nothing to send yet; make a plan first.";
        openSend();
        return "The draft is open on screen. Nothing has been sent: they read it and tap Send themselves.";
      }
    }
  }, [settle]);

  const context = useCallback(() => {
    const v = d.current.view;
    if (!v?.cards.length) return "No plan on screen yet.";
    return `A plan is on screen for ${ukTime(v.when)}: ${v.cards.slice(0, 3).map((c, i) => `${i + 1}) ${c.name}`).join(", ")}.`;
  }, []);

  return { onTool, context };
}
