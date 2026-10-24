"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { ArrowRight, CalendarDays, Check, Coffee, DoorOpen, FlaskConical, GitCommitHorizontal, HelpCircle, LocateFixed, Loader2, Navigation, PencilLine, Send, X } from "lucide-react";
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
import { fmtAsOf, fmtWhen, gmapsDirections } from "./format";
import { usePlan } from "./use-plan";
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
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 12 }}
            transition={{ delay: 0.9 + i * 0.1, duration: 0.3 }}
            className="flex items-center gap-2 rounded-full bg-surface py-1.5 pl-2.5 pr-3 text-[12.5px] shadow-[var(--sw-shadow-float)]"
          >
            <span className="relative flex size-2.5" aria-hidden>
              <span className={cn("absolute inset-0 animate-ping rounded-full opacity-50 [animation-duration:2.4s] motion-reduce:hidden", f.verdict === "forecast" ? "bg-fc" : "bg-ok")} />
              <span className={cn("relative size-2.5 rounded-full", f.verdict === "forecast" ? "bg-fc" : "bg-ok")} />
            </span>
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
          className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium", it.on ? "bg-sunk text-ink" : "border border-line text-ink-3")}
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
    <section aria-label="How we answer" className="mt-6 border-t border-rule pt-4">
      <h2 className="text-[13px] font-semibold text-ink">Every fact gets a verdict</h2>
      <ul className="mt-2.5 flex flex-col gap-2">
        {LEGEND.map((l, i) => (
          <li key={l.v} className="grid grid-cols-[104px_1fr] items-center gap-3">
            <VerdictChip verdict={l.v} delay={0.1 + i * 0.06} />
            <span className="text-[13px] leading-5 text-ink-2">{l.text}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12.5px] leading-[18px] text-ink-3">
        Their location is rounded to about 500 m and never stored. Nothing is sent for you: you get a draft to copy.
      </p>
    </section>
  );
}

function Blind({ result }: { result: PlanResultWithAgent }) {
  const words = result.headline.split(" ");
  return (
    <div className="sw-blind relative overflow-hidden rounded-[16px] bg-ink px-4 pb-4 pt-3 text-white [perspective:600px]">
      <p className="num font-mono text-[11.5px] font-medium uppercase tracking-[0.08em] text-hi">
        {fmtWhen(result.when)} · {INTENT_LABEL[result.intent] ?? result.intent}
      </p>
      <h2 className="relative mt-1.5 text-[24px] font-bold leading-[1.15] tracking-[-0.02em] text-balance">
        {words.map((w, i) => (
          <motion.span key={i + w} className="inline-block origin-[50%_0%]" initial={{ opacity: 0, rotateX: -95, y: -4 }} animate={{ opacity: 1, rotateX: 0, y: 0 }} transition={{ delay: 0.08 + i * 0.045, type: "spring", stiffness: 380, damping: 22 }}>
            {w}
            {i < words.length - 1 ? "\u00a0" : ""}
          </motion.span>
        ))}
      </h2>
    </div>
  );
}

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
  }, [result]);

  const ask = useCallback(
    (q: string) => {
      const text = q.trim();
      if (!text) return;
      submit(text, undefined, you ?? undefined);
    },
    [submit, you]
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
      },
      () => setLocating("denied"),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, [you]);

  const refine = useCallback(
    (extra: string) => {
      const base = state.query || query;
      if (!base) return;
      const next = `${base.replace(/\s*\(refine:.*\)$/i, "")} (refine: ${extra})`;
      setQuery(next);
      submit(next, undefined, you ?? undefined);
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    },
    [state.query, query, submit, you]
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

  const selected = result?.cards.find((c) => c.id === selectedId) ?? result?.cards[0];
  const detail = result?.cards.find((c) => c.id === detailId) ?? null;
  const finished = status === "result" || status === "clarify";

  return (
    <MotionConfig reducedMotion="user">
      <main className="relative min-h-dvh bg-ground lg:h-dvh lg:overflow-hidden">
        <Header example={state.example} testedN={testedN} className="sticky top-0 z-20 bg-ground px-4 py-3 lg:hidden" />

        {/* Map: on top on phones, full-bleed behind the panel on desktop */}
        <div className="relative h-[46svh] min-h-[300px] overflow-hidden lg:absolute lg:inset-0 lg:h-auto">
          <PlanMap result={result} selectedId={selectedId} hoverId={hoverId} focusId={detailId} scanning={status === "running"} onSelect={select} onHover={setHoverId} padding={padding} reduced={reduced} />
          <div className="pointer-events-none absolute right-3 top-3 z-10 lg:right-4 lg:top-4">
            <LiveStrip facts={liveFacts(result, selectedId)} />
          </div>
          {state.example ? (
            <div className="pointer-events-none absolute bottom-4 left-[476px] z-10 hidden lg:block">
              <span className="inline-flex h-7 items-center gap-1.5 rounded-full bg-likely-bg px-2.5 text-[12px] font-semibold text-likely shadow-[var(--sw-shadow-float)]">
                <FlaskConical className="size-3.5" aria-hidden /> Example<span className="max-sm:hidden"> data</span> · not live
              </span>
            </div>
          ) : null}
        </div>

        {/* Plan panel */}
        <aside className="relative z-10 flex flex-col bg-surface lg:absolute lg:bottom-4 lg:left-4 lg:top-4 lg:w-[444px] lg:rounded-[20px] lg:border lg:border-line lg:shadow-[var(--sw-shadow-float)]">
          <div ref={scrollRef} className="flex-1 px-4 pb-6 pt-4 lg:overflow-y-auto lg:px-5 lg:pt-5">
            <Header example={state.example} testedN={testedN} className="mb-5 hidden lg:flex" />

            {status === "idle" ? (
              <div className="mb-4">
                <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.025em] text-ink">Where shall we meet?</h1>
                <p className="mt-2 text-[14.5px] leading-[22px] text-ink-2">
                  Ask like you&apos;d text a friend. We check travel times, opening hours, live trains and the weather, and tell you what we couldn&apos;t check.
                </p>
              </div>
            ) : null}

            {/* Ask */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                ask(query);
              }}
            >
              <div className="-mx-1 mb-2.5 flex flex-wrap gap-1.5 px-1" role="group" aria-label="Quick starts">
                {CHIPS.map((c) => {
                  const on = activeChip === c.id;
                  return (
                    <motion.button
                      key={c.id}
                      type="button"
                      whileTap={{ scale: 0.95 }}
                      onClick={() => {
                        setActiveChip(c.id);
                        setQuery(c.ask);
                        inputRef.current?.focus();
                      }}
                      aria-pressed={on}
                      className={cn("relative inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors duration-200 max-lg:min-h-11", on ? "text-white" : "bg-raised text-ink-2 hover:bg-sunk hover:text-ink")}
                    >
                      {on ? <motion.span layoutId="chip-on" className="absolute inset-0 rounded-full bg-ink" transition={{ type: "spring", stiffness: 500, damping: 36 }} /> : null}
                      <c.Icon className="relative size-4" aria-hidden />
                      <span className="relative">{c.label}</span>
                    </motion.button>
                  );
                })}
              </div>
              <div className="flex items-end gap-2 rounded-[14px] border border-line bg-raised p-1.5 pl-3.5 transition-colors focus-within:border-ink">
                <label htmlFor="ask" className="sr-only">Your ask</label>
                <textarea
                  id="ask"
                  ref={inputRef}
                  value={query}
                  rows={2}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActiveChip(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      ask(query);
                    }
                  }}
                  placeholder="Date Thursday at 7, I'm at Old Street, she's around Clapham…"
                  className="min-h-[52px] flex-1 resize-none bg-transparent py-2 text-[16px] leading-6 text-ink placeholder:text-ink-3 focus:outline-none"
                />
                <motion.button type="submit" whileTap={{ scale: 0.94 }} disabled={!query.trim() || status === "running"} aria-label="Plan it" className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] bg-ink text-white transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-35">
                  {status === "running" ? <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" aria-hidden /> : <ArrowRight className="size-5" aria-hidden />}
                </motion.button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.95 }}
                  onClick={locate}
                  aria-pressed={!!you}
                  className={cn(
                    "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold transition-colors max-lg:min-h-11",
                    you ? "bg-hi text-ink" : "bg-raised text-ink-2 hover:bg-sunk hover:text-ink"
                  )}
                >
                  {locating === "busy" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LocateFixed className="size-3.5" aria-hidden />}
                  {you ? "Using your location · ~100 m" : "Use my location"}
                  {you ? <X className="size-3.5" aria-label="Stop using location" /> : null}
                </motion.button>
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

              {status === "result" && result ? (
                <motion.div key={result.headline} className="flex flex-col gap-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  <Blind result={result} />
                  <Filters f={result.filters} />

                  <div ref={(n) => { if (n) cardRefs.current.set("__results", n); }} className="scroll-mt-20 lg:scroll-mt-4">
                    <LayoutGroup>
                      <AnimatePresence mode="popLayout" initial={false}>
                        {detail ? (
                          <PlaceDetail key="detail" card={detail} index={result.cards.indexOf(detail)} result={result} example={state.example} onClose={() => setDetailId(null)} onSend={() => setSendOpen(true)} />
                        ) : (
                          <motion.div key="list" className="flex flex-col gap-3" exit={{ opacity: 0 }}>
                            {result.cards.slice(0, 3).map((c, i) => (
                              <PlanCard key={c.id} card={c} index={i} selected={c.id === selected?.id} hovered={c.id === hoverId} onOpen={() => openDetail(c.id)} onHover={(on) => setHoverId(on ? c.id : null)} />
                            ))}
                            {!result.cards.length ? <p className="rounded-[14px] border border-line p-4 text-[14px] text-ink-2">Nothing matched. Try a wider area or a different time.</p> : null}
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </LayoutGroup>
                  </div>

                  <FollowUps intent={result.intent} onRefine={refine} disabled={false} />

                  {result.unknowns.length && !detail ? (
                    <section aria-label="Couldn't check" className="rounded-[14px] border border-dashed border-control p-3.5">
                      <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">Couldn&apos;t check</h3>
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {result.unknowns.map((u) => (
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
                      {result.sources.map((s) => `${s.name} ${fmtAsOf(s.asOf)}`).join(" · ")}
                    </p>
                    <p className="mt-1">Map data © OpenStreetMap contributors · tiles OpenFreeMap · Powered by TfL Open Data · Weather: Open-Meteo (CC BY 4.0)</p>
                  </footer>
                </motion.div>
              ) : null}

              {status === "running" && !state.steps.length ? (
                <div className="flex flex-col gap-2" aria-hidden>
                  <div className="h-11 rounded-[14px] bg-sunk" />
                  <div className="h-24 rounded-[14px] bg-sunk" />
                </div>
              ) : null}
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
                className="sticky bottom-0 flex gap-2 border-t border-line bg-surface px-4 py-3 lg:rounded-b-[20px] lg:px-5"
              >
                <motion.button type="button" whileTap={{ scale: 0.97 }} onClick={() => setSendOpen(true)} className="inline-flex min-h-11 flex-1 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-[10px] bg-ink px-4 text-[15px] font-semibold text-white transition-opacity hover:opacity-90">
                  <Send className="size-4" aria-hidden /> Send plan
                </motion.button>
                {selected ? (
                  <a href={gmapsDirections(selected.location.lat, selected.location.lng)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-[10px] border border-line px-3.5 text-[15px] font-medium text-ink transition-colors hover:border-ink">
                    <Navigation className="size-4" aria-hidden /> <span className="max-sm:sr-only">Directions</span>
                  </a>
                ) : null}
                <button type="button" onClick={change} className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-[10px] px-3 text-[15px] font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink">
                  <PencilLine className="size-4" aria-hidden /> Change
                </button>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </aside>

        {result ? <SendPlanDialog open={sendOpen} onOpenChange={setSendOpen} draft={result.draftMessage} /> : null}
      </main>
    </MotionConfig>
  );
}
