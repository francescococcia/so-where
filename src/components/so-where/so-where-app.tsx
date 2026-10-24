"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { ArrowRight, CalendarDays, Check, CheckCircle2, Coffee, DoorOpen, FlaskConical, GitCommitHorizontal, HelpCircle, LocateFixed, Loader2, Navigation, PencilLine, Send, X } from "lucide-react";
import type { Fact, PlanResultWithAgent } from "@/lib/plan-types";
import type { FixtureId } from "@/lib/plan-fixture";
import { cn } from "@/lib/utils";
import { AgentSteps } from "./agent-steps";
import { ClarifyBox } from "./clarify-box";
import { PlanCard } from "./plan-card";
import { PlaceDetail } from "./place-detail";
import { FollowUps } from "./follow-ups";
import { SendPlanDialog } from "./send-plan-dialog";
import { Mark } from "./mark";
import { VerdictChip } from "./verdict-chip";
import { WeatherIcon, weatherKind } from "./fact-icon";
import { fmtAsOf, fmtWhen, gmapsDirections } from "./format";
import { usePlan } from "./use-plan";
import { CountUp } from "./motion-bits";
import type { MapPadding } from "./plan-map";

const PlanMap = dynamic(() => import("./plan-map"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-ground" aria-hidden />,
});

const CHIPS = [
  { id: "meet", label: "Meet halfway", Icon: GitCommitHorizontal, ask: "Date on Thursday at 7. I'm at Old Street, she's around Clapham. A pub halfway, about £40 for two." },
  { id: "coffee", label: "Coffee with a friend", Icon: Coffee, ask: "Coffee with Sam tomorrow morning. I'm at King's Cross." },
  { id: "near", label: "What's on near me", Icon: CalendarDays, ask: "It's Saturday, what's on near me?" },
  { id: "walkin", label: "No-registration events", Icon: DoorOpen, ask: "It's Saturday, what's on near me that I can just walk into?" },
] as const;

const INTENT_LABEL = { meet_halfway: "Meet halfway", near_me: "Near you" } as const;

function Header({ example, testedN, className }: { example: boolean; testedN: number | null; className?: string }) {
  return (
    <header className={cn("flex items-center gap-2.5", className)}>
      <span className="shrink-0"><Mark /></span>
      <span className="shrink-0 whitespace-nowrap text-[19px] font-bold tracking-[-0.02em] text-ink">So where?</span>
      <span className="hidden text-[13px] text-ink-3 2xl:inline">London</span>
      <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
        {testedN != null ? (
          <span className="num inline-flex h-6 items-center gap-1 rounded-full bg-ok-bg px-2 text-[12px] font-semibold text-ok" title="From evals/last-run.json">
            <Check className="size-3.5" strokeWidth={2.6} aria-hidden /> <span className="max-sm:hidden">Tested on</span> {testedN} asks
          </span>
        ) : null}
        <AnimatePresence>
          {example ? (
            <motion.span initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} className="inline-flex h-6 items-center gap-1 rounded-full bg-likely-bg px-2 text-[12px] font-semibold text-likely">
              <FlaskConical className="size-3.5" aria-hidden /> Example<span className="max-sm:hidden"> data</span>
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
    </header>
  );
}

function liveFacts(r: PlanResultWithAgent | null, cardId: string | null): Fact[] {
  if (!r) return [];
  const card = r.cards.find((c) => c.id === cardId) ?? r.cards[0];
  return (card?.facts ?? []).filter((f) => /train|line|status|weather|tube|bus/i.test(f.label) && f.verdict !== "unknown").slice(0, 2);
}

function LiveStrip({ facts }: { facts: Fact[] }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <AnimatePresence>
        {facts.map((f, i) => (
          <motion.div
            key={f.label + f.value}
            initial={{ opacity: 0, x: 16, scale: 0.92 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ delay: 0.9 + i * 0.1, type: "spring", stiffness: 380, damping: 26 }}
            className="sw-glass-chip flex items-center gap-2 rounded-full py-1.5 pl-2 pr-3 text-[12.5px] shadow-e3 ring-1 ring-white/70"
          >
            {weatherKind(f) ? (
              <WeatherIcon fact={f} />
            ) : (
              <span className="relative ml-0.5 flex size-2.5" aria-hidden>
                <span className={cn("absolute inset-0 animate-ping rounded-full opacity-50 [animation-duration:2.4s] motion-reduce:hidden", f.verdict === "forecast" ? "bg-fc" : "bg-ok")} />
                <span className={cn("relative size-2.5 rounded-full", f.verdict === "forecast" ? "bg-fc" : "bg-ok")} />
              </span>
            )}
            <span className="max-w-[190px] truncate sm:max-w-[300px] font-medium text-ink" title={f.value}>{f.value}</span>
            <span className="num shrink-0 whitespace-nowrap font-mono text-[11px] text-ink-3">
              {f.source.split(" · ")[0]}
              {f.asOf ? ` ${fmtAsOf(f.asOf)}` : ""}
            </span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function Filters({ f }: { f: PlanResultWithAgent["filters"] }) {
  const items: { label: string; on: boolean }[] = [];
  if (f.walkIn != null) items.push({ label: "No sign-up", on: f.walkIn });
  if (f.maxMinutes != null) items.push({ label: `Within ${f.maxMinutes} min`, on: true });
  if (f.free != null) items.push({ label: "Free only", on: f.free });
  if (f.budgetGBP != null) items.push({ label: `~£${f.budgetGBP} for two`, on: true });
  if (f.category) items.push({ label: f.category[0].toUpperCase() + f.category.slice(1), on: true });
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What we filtered on">
      {items.map((it, i) => (
        <motion.li
          key={it.label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 + i * 0.04 }}
          className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium", it.on ? "bg-sky-wash text-sky-ink ring-1 ring-sky/20" : "border border-dashed border-control text-ink-3")}
        >
          {it.on ? <Check className="size-3.5" strokeWidth={2.6} aria-hidden /> : null}
          {it.label}
        </motion.li>
      ))}
    </ul>
  );
}

const LEGEND = [
  { v: "confirmed", text: "A live or official source says so" },
  { v: "likely", text: "Our data says so, but nobody's checked lately" },
  { v: "forecast", text: "A prediction, like the weather" },
  { v: "unknown", text: "We couldn't check, so we say so" },
] as const;

function HowWeAnswer() {
  return (
    <section aria-label="How we answer" className="mt-6 rounded-[16px] bg-tint/70 p-4 shadow-e1 ring-1 ring-white/70">
      <h2 className="text-[13px] font-semibold text-ink">Every fact gets a verdict</h2>
      <ul className="mt-2 flex flex-col gap-0.5">
        {LEGEND.map((l, i) => (
          <motion.li
            key={l.v}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            whileHover={{ x: 3 }}
            transition={{ type: "spring", stiffness: 420, damping: 30, delay: 0.12 + i * 0.07 }}
            className="group -mx-2 grid grid-cols-[104px_1fr] items-center gap-3 rounded-[10px] px-2 py-1 transition-colors duration-200 hover:bg-raised"
          >
            <VerdictChip verdict={l.v} delay={0.1 + i * 0.06} />
            <span className="text-[13px] leading-5 text-ink-2 transition-colors duration-200 group-hover:text-ink">{l.text}</span>
          </motion.li>
        ))}
      </ul>
      <p className="mt-3 border-t border-rule pt-3 text-[12.5px] leading-[18px] text-ink-3">
        Their location is rounded to about 500 m and never stored. Nothing is sent for you: you get a draft to copy.
      </p>
    </section>
  );
}

function Blind({ result }: { result: PlanResultWithAgent }) {
  const words = result.headline.split(" ");
  return (
    <div className="sw-blind relative overflow-hidden rounded-[16px] bg-tint/80 py-3 pb-4 pl-5 pr-4 text-ink shadow-e2 ring-1 ring-line/70 [perspective:600px]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 bg-signal" />
      <p className="num font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em] text-signal-ink">
        {fmtWhen(result.when)} · {INTENT_LABEL[result.intent] ?? result.intent}
      </p>
      <h2 className="relative mt-1.5 text-[24px] font-bold leading-[1.15] tracking-[-0.02em] text-balance">
        {words.map((w, i) => {
          const m = /^(\D*)(\d{1,3})(\D*)$/.exec(w);
          return (
            <motion.span key={i + w} className="inline-block origin-[50%_0%]" initial={{ opacity: 0, rotateX: -95, y: -4 }} animate={{ opacity: 1, rotateX: 0, y: 0 }} transition={{ delay: 0.08 + i * 0.045, type: "spring", stiffness: 380, damping: 22 }}>
              {m ? (
                <>
                  {m[1]}
                  <CountUp value={Number(m[2])} delay={0.25 + i * 0.045} duration={1.1} className="num text-signal-ink" />
                  {m[3]}
                </>
              ) : (
                w
              )}
              {i < words.length - 1 ? "\u00a0" : ""}
            </motion.span>
          );
        })}
      </h2>
    </div>
  );
}

const HERO = "Where shall we meet?".split(" ");

function Hero() {
  return (
    <div className="relative mb-4 isolate">
      <div aria-hidden className="pointer-events-none absolute -inset-x-5 -top-6 bottom-[-12px] -z-10 overflow-hidden rounded-[22px]">
        <div className="sw-mesh" />
      </div>
      <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.025em] text-ink" aria-label="Where shall we meet?">
        {HERO.map((w, i) => (
          <motion.span key={w + i} aria-hidden className="inline-block" initial={{ opacity: 0, y: 18, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ delay: 0.25 + i * 0.07, type: "spring", stiffness: 320, damping: 24 }}>
            {i === HERO.length - 1 ? <span className="text-signal-ink">{w}</span> : w}
            {i < HERO.length - 1 ? "\u00a0" : ""}
          </motion.span>
        ))}
      </h1>
      <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.45, ease: [0.22, 1, 0.36, 1] }} className="mt-2 text-[14.5px] leading-[22px] text-ink-2">
        Ask like you&apos;d text a friend. We check travel times, opening hours, live trains and the weather, and tell you what we couldn&apos;t check.
      </motion.p>
    </div>
  );
}

/** Loading: a little route being traced between two stops while the planner works. */
function RouteScan() {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden>
      <div className="sw-glint relative h-[88px] overflow-hidden rounded-[16px] bg-white/60 shadow-e1 ring-1 ring-white/70">
        <svg viewBox="0 0 360 88" className="sw-scanroute absolute inset-0 h-full w-full" preserveAspectRatio="none">
          <path d="M24 64 C 90 64, 110 22, 180 24 S 270 66, 336 30" fill="none" stroke="var(--sw-control)" strokeWidth="3" strokeLinecap="round" />
          <path className="trace" d="M24 64 C 90 64, 110 22, 180 24 S 270 66, 336 30" fill="none" stroke="var(--sw-signal)" strokeWidth="3" strokeLinecap="round" />
          <circle cx="24" cy="64" r="6" fill="var(--sw-route-you)" stroke="#fff" strokeWidth="2.5" />
          <circle cx="336" cy="30" r="6" fill="var(--sw-amber)" stroke="#fff" strokeWidth="2.5" />
        </svg>
        <span className="dot absolute left-0 top-0 size-3 rounded-full bg-signal shadow-[0_0_0_4px_rgba(15,157,138,.25)]" style={{ offsetPath: "path('M24 64 C 90 64, 110 22, 180 24 S 270 66, 336 30')" } as React.CSSProperties} />
      </div>
      <div className="sw-skel h-20 opacity-80" />
      <div className="sw-skel h-20 opacity-60" />
    </div>
  );
}

type Toast = { id: number; text: string };

export function SoWhereApp({ testedN }: { testedN: number | null }) {
  const reduced = !!useReducedMotion();
  const { state, submit, showFixture } = usePlan();
  const [query, setQuery] = useState("");
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [you, setYou] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState<"idle" | "busy" | "denied">("idle");
  const [sendOpen, setSendOpen] = useState(false);
  const [padding, setPadding] = useState<MapPadding>({ top: 90, right: 80, bottom: 90, left: 500 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typeTimer = useRef<number | null>(null);
  const pulseTimer = useRef<number | null>(null);
  const [typing, setTyping] = useState(false);
  const [refining, setRefining] = useState(false);
  const [shown, setShown] = useState<PlanResultWithAgent | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const toastTimer = useRef<number | null>(null);
  const say = useCallback((text: string) => {
    setToast({ id: Date.now(), text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  // Glow while text is going in (typed by hand or by a suggestion chip).
  const pulse = useCallback(() => {
    setTyping(true);
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setTyping(false), 700);
  }, []);

  const stopTyping = useCallback(() => {
    if (typeTimer.current) window.clearInterval(typeTimer.current);
    typeTimer.current = null;
  }, []);

  // Suggestion chips type their ask into the box (instant with reduced motion).
  const typeIn = useCallback(
    (text: string) => {
      stopTyping();
      inputRef.current?.focus();
      if (reduced) {
        setQuery(text);
        return;
      }
      let i = 0;
      const step = Math.max(2, Math.ceil(text.length / 38));
      setQuery("");
      typeTimer.current = window.setInterval(() => {
        i = Math.min(text.length, i + step);
        setQuery(text.slice(0, i));
        pulse();
        if (i >= text.length) stopTyping();
      }, 16);
    },
    [reduced, stopTyping, pulse]
  );

  useEffect(() => () => {
    stopTyping();
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
  }, [stopTyping]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // Grow the ask box with its text (max ~5 lines).
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
  }, [query]);

  const { result, status } = state;

  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get("demo");
    if (demo === "meet" || demo === "saturday") {
      showFixture(demo as FixtureId);
      setQuery(demo === "meet" ? CHIPS[0].ask : CHIPS[3].ask);
      setActiveChip(demo === "meet" ? "meet" : "walkin");
    } else if (demo === "clarify") {
      setQuery(CHIPS[1].ask);
      setActiveChip("coffee");
      submit(CHIPS[1].ask);
    }
    const onResize = () => {
      const wide = window.innerWidth >= 1024;
      setPadding(wide ? { top: 110, right: 90, bottom: 90, left: 500 } : { top: 110, right: 56, bottom: 36, left: 36 });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [showFixture, submit]);

  useEffect(() => {
    setSelectedId(result?.cards[0]?.id ?? null);
    setDetailId(null);
    if (result) {
      setShown(result);
      if (refining) say("Picks updated");
    }
    if (status !== "running") setRefining(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  useEffect(() => {
    if (status === "clarify" || status === "idle") setRefining(false);
  }, [status]);

  const ask = useCallback(
    (q: string) => {
      stopTyping();
      const text = q.trim();
      if (!text) return;
      setRefining(false);
      setShown(null);
      submit(text, undefined, you ?? undefined);
    },
    [submit, you, stopTyping]
  );

  const locate = useCallback(() => {
    if (you) {
      setYou(null);
      return;
    }
    if (!("geolocation" in navigator)) return setLocating("denied");
    setLocating("busy");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        // Rounded to ~100 m before it leaves this function; sent with the ask, never stored.
        const r = (n: number) => Math.round(n * 1000) / 1000;
        setYou({ lat: r(p.coords.latitude), lng: r(p.coords.longitude) });
        setLocating("idle");
        say("Location on · rounded to ~100 m");
      },
      () => setLocating("denied"),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, [you, say]);

  const refine = useCallback(
    (extra: string) => {
      const base = state.query || query;
      if (!base) return;
      const next = `${base.replace(/\s*\(refine:.*\)$/i, "")} (refine: ${extra})`;
      setQuery(next);
      setRefining(true);
      say(`Re-checking: ${extra}`);
      submit(next, undefined, you ?? undefined);
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    },
    [state.query, query, submit, you, say]
  );

  const openDetail = useCallback((id: string) => {
    setSelectedId(id);
    setDetailId(id);
    requestAnimationFrame(() => cardRefs.current.get("__results")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }, []);

  const select = useCallback((id: string) => openDetail(id), [openDetail]);

  const change = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  // While a follow-up chip re-asks, keep the previous picks on screen (dimmed) so new results can animate into place.
  const view = status === "result" ? result : refining ? shown : null;
  const selected = result?.cards.find((c) => c.id === selectedId) ?? result?.cards[0];
  const detail = result?.cards.find((c) => c.id === detailId) ?? null;
  const finished = status === "result" || status === "clarify";

  return (
    <MotionConfig reducedMotion="user">
      <main className="relative min-h-dvh bg-ground lg:h-dvh lg:overflow-hidden">
        <Header example={state.example} testedN={testedN} className="sticky top-0 z-20 bg-ground/75 px-4 py-3 backdrop-blur-xl backdrop-saturate-150 lg:hidden" />

        {/* Map: on top on phones, full-bleed behind the panel on desktop */}
        <div className="relative h-[46svh] min-h-[300px] overflow-hidden lg:absolute lg:inset-0 lg:h-auto">
          <PlanMap result={result ?? (refining ? shown : null)} selectedId={selectedId} hoverId={hoverId} focusId={detailId} scanning={status === "running"} onSelect={select} onHover={setHoverId} padding={padding} reduced={reduced} />
          <div className="pointer-events-none absolute right-3 top-3 z-10 lg:right-4 lg:top-4">
            <LiveStrip facts={liveFacts(result, selectedId)} />
          </div>
          {state.example ? (
            <div className="pointer-events-none absolute bottom-4 left-[476px] z-10 hidden lg:block">
              <span className="sw-glass-chip inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold text-likely shadow-e3 ring-1 ring-white/70">
                <FlaskConical className="size-3.5" aria-hidden /> Example<span className="max-sm:hidden"> data</span> · not live
              </span>
            </div>
          ) : null}
        </div>

        {/* Plan panel */}
        <motion.aside
          initial={{ opacity: 0, x: -28, scale: 0.985 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 28, delay: 0.05 }}
          className="sw-glass relative z-10 -mt-5 flex flex-col rounded-t-[22px] lg:absolute lg:bottom-4 lg:left-4 lg:top-4 lg:mt-0 lg:w-[444px] lg:rounded-[22px]"
        >
          <div ref={scrollRef} className="flex-1 px-4 pb-6 pt-4 lg:overflow-y-auto lg:px-5 lg:pt-5">
            <Header example={state.example} testedN={testedN} className="mb-5 hidden lg:flex" />

            {status === "idle" ? <Hero /> : null}

            {/* Ask */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(query);
              }}
            >
              <div className="-mx-1 mb-2.5 flex flex-wrap gap-1.5 px-1" role="group" aria-label="Quick starts">
                {CHIPS.map((c, ci) => {
                  const on = activeChip === c.id;
                  return (
                    <motion.button
                      key={c.id}
                      initial={{ opacity: 0, y: 10, scale: 0.92 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ delay: 0.35 + ci * 0.06, type: "spring", stiffness: 420, damping: 26 }}
                      type="button"
                      disabled={status === "running"}
                      onClick={() => {
                        setActiveChip(c.id);
                        typeIn(c.ask);
                      }}
                      aria-pressed={on}
                      className="sw-chip min-h-9 px-3 text-[13px] font-medium max-lg:min-h-11"
                    >
                      {on ? <motion.span layoutId="chip-on" className="absolute inset-0 -z-10 rounded-full bg-signal-soft" transition={{ type: "spring", stiffness: 500, damping: 36 }} /> : null}
                      <c.Icon className={cn("size-4 transition-colors", on ? "text-signal-ink" : "text-ink-3")} aria-hidden />
                      <span>{c.label}</span>
                    </motion.button>
                  );
                })}
              </div>
              <motion.div layout="size" className={cn("sw-field flex items-end gap-2 p-1.5 pl-3.5", typing && "is-typing")}>
                <label htmlFor="ask" className="sr-only">Your ask</label>
                <textarea
                  id="ask"
                  ref={inputRef}
                  value={query}
                  rows={2}
                  onChange={(e) => {
                    stopTyping();
                    setQuery(e.target.value);
                    setActiveChip(null);
                    pulse();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      ask(query);
                    }
                  }}
                  placeholder="Date Thursday at 7, I'm at Old Street, she's around Clapham…"
                  className="min-h-[52px] flex-1 resize-none bg-transparent py-2 text-[16px] leading-6 text-ink caret-sky transition-[height] duration-200 placeholder:text-ink-3 focus:outline-none"
                />
                <motion.button
                  type="submit"
                  disabled={!query.trim() || status === "running"}
                  aria-busy={status === "running"}
                  aria-label="Plan it"
                  animate={{ scale: query.trim() || status === "running" ? 1 : 0.9 }}
                  whileHover={query.trim() && status !== "running" ? { scale: 1.06 } : undefined}
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: "spring", stiffness: 520, damping: 26 }}
                  className="sw-btn sw-btn-primary size-11 shrink-0 rounded-[12px] transition-[box-shadow,background-color,color] disabled:aria-busy:bg-signal-strong disabled:aria-busy:text-white"
                >
                  {status === "running" ? <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : <ArrowRight className="size-5" aria-hidden />}
                </motion.button>
              </motion.div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={locate}
                  aria-pressed={!!you}
                  aria-busy={locating === "busy"}
                  className={cn("sw-chip min-h-9 shrink-0 px-3 text-[12.5px] font-semibold max-lg:min-h-11", you && "bg-signal-soft")}
                >
                  {locating === "busy" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LocateFixed className={cn("size-3.5", you ? "text-signal-ink" : "text-ink-3")} aria-hidden />}
                  {you ? "Using your location · ~100 m" : "Use my location"}
                  {you ? <X className="size-3.5" aria-label="Stop using location" /> : null}
                </button>
                <span className="text-[11.5px] leading-4 text-ink-3">{locating === "denied" ? "Location blocked: name a station instead." : you ? "Sent with your ask only, never stored." : "Skips the “where are you?” question."}</span>
              </div>
            </form>

            {status === "idle" ? <HowWeAnswer /> : null}

            {/* Live steps */}
            <div className="mt-4 flex flex-col gap-4">
              {state.steps.length ? <AgentSteps steps={state.steps} finished={finished} elapsedMs={state.elapsedMs} /> : null}

              {state.example && state.exampleReason && finished ? (
                <p className="flex items-start gap-1.5 text-[12.5px] leading-[18px] text-ink-3">
                  <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-likely" aria-hidden />
                  <span>
                    Example data from the design mockups, not a live answer
                    {state.exampleReason !== "demo link" ? ` (the planner didn't respond: ${state.exampleReason})` : ""}.
                  </span>
                </p>
              ) : null}

              {status === "clarify" && state.clarify ? <ClarifyBox clarify={state.clarify} onAnswer={(answer) => submit(answer, { query: state.query, answer }, you ?? undefined)} onLocate={state.clarify.missing === "my_location" && !you ? locate : undefined} /> : null}

              {view ? (
                <motion.div key="results" className="flex flex-col gap-4" initial={{ opacity: 0 }} animate={{ opacity: refining && status === "running" ? 0.55 : 1 }} transition={{ duration: 0.3 }} aria-busy={status === "running"}>
                  <Blind key={view.headline} result={view} />
                  <Filters f={view.filters} />

                  <div ref={(n) => { if (n) cardRefs.current.set("__results", n); }} className="scroll-mt-20 lg:scroll-mt-4">
                    <LayoutGroup>
                      <AnimatePresence mode="popLayout" initial={false}>
                        {detail && result ? (
                          <PlaceDetail key="detail" card={detail} index={result.cards.indexOf(detail)} result={result} example={state.example} onClose={() => setDetailId(null)} onSend={() => setSendOpen(true)} />
                        ) : (
                          <motion.div key="list" layout className="flex flex-col gap-3" exit={{ opacity: 0 }}>
                            {view.cards.slice(0, 3).map((c, i) => (
                              <PlanCard key={c.id} card={c} index={i} when={view.when} selected={c.id === selected?.id} hovered={c.id === hoverId} onOpen={() => openDetail(c.id)} onHover={(on) => setHoverId(on ? c.id : null)} />
                            ))}
                            {!view.cards.length ? <p className="rounded-[14px] bg-tint p-4 text-[14px] text-ink-2 shadow-e1">Nothing matched. Try a wider area or a different time.</p> : null}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </LayoutGroup>
                  </div>

                  <FollowUps intent={view.intent} onRefine={refine} disabled={status === "running"} />

                  {view.unknowns.length && !detail ? (
                    <section aria-label="Couldn't check" className="rounded-[14px] border border-dashed border-control bg-raised/60 p-3.5">
                      <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">Couldn&apos;t check</h3>
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {view.unknowns.map((u) => (
                          <li key={u} className="flex items-start gap-2 text-[13px] leading-5 text-ink-2">
                            <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-unknown" aria-hidden />
                            {u}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  <footer className="text-[11.5px] leading-[17px] text-ink-3">
                    <p className="num font-mono">
                      {view.sources.map((s) => `${s.name} ${fmtAsOf(s.asOf)}`).join(" · ")}
                    </p>
                    <p className="mt-1">Map data © OpenStreetMap contributors · tiles OpenFreeMap · Powered by TfL Open Data · Weather: Open-Meteo (CC BY 4.0)</p>
                  </footer>
                </motion.div>
              ) : null}

              {status === "running" && !refining ? <RouteScan /> : null}
            </div>
          </div>

          {/* Action bar */}
          <AnimatePresence>
            {status === "result" && result ? (
              <motion.div
                initial={{ y: 24, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 24, opacity: 0 }}
                transition={{ delay: 0.3, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="sticky bottom-0 flex gap-2 border-t border-white/70 bg-white/85 px-4 py-3 shadow-[0_-10px_24px_-18px_rgba(74,52,30,0.35)] backdrop-blur-xl backdrop-saturate-150 lg:rounded-b-[22px] lg:px-5"
              >
                <button type="button" onClick={() => { setSendOpen(true); say("Draft ready · nothing is sent"); }} className="sw-btn sw-btn-primary min-h-11 flex-1 whitespace-nowrap rounded-[12px] px-4 text-[15px] font-semibold">
                  <Send className="size-4" aria-hidden /> Send plan
                </button>
                {selected ? (
                  <a href={gmapsDirections(selected.location.lat, selected.location.lng)} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-quiet min-h-11 gap-1.5 rounded-[12px] px-3.5 text-[15px] font-medium">
                    <Navigation className="size-4" aria-hidden /> <span className="max-sm:sr-only">Directions</span>
                  </a>
                ) : null}
                <button type="button" onClick={change} className="sw-btn sw-btn-ghost min-h-11 gap-1.5 rounded-[12px] px-3 text-[15px] font-medium">
                  <PencilLine className="size-4" aria-hidden /> Change
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
          {/* micro confirmations */}
          <div className="pointer-events-none absolute inset-x-0 bottom-[84px] z-30 flex justify-center" role="status" aria-live="polite">
            <AnimatePresence>
              {toast ? (
                <motion.div
                  key={toast.id}
                  initial={{ opacity: 0, y: 14, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 480, damping: 30 }}
                  className="sw-glass-chip inline-flex max-w-[90%] items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold text-ink shadow-e3 ring-1 ring-white/70"
                >
                  <CheckCircle2 className="size-4 shrink-0 text-signal-ink" aria-hidden />
                  <span className="truncate">{toast.text}</span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </motion.aside>

        {result ? <SendPlanDialog open={sendOpen} onOpenChange={setSendOpen} draft={result.draftMessage} /> : null}
      </main>
    </MotionConfig>
  );
}
