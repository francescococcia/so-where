"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Accessibility, ArrowLeft, ArrowUpRight, Banknote, ChevronDown, Clock, CloudSun, ExternalLink, Globe, HelpCircle, ListChecks, Map as MapIcon, Navigation, Route, Send, TrainFront } from "lucide-react";
import type { Fact, PlanCard as Card, PlanResultWithAgent, Verdict } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { VerdictChip } from "./verdict-chip";
import { fmtAsOf, fmtWhen, gmapsDirections } from "./format";
import { WeatherIcon, weatherKind } from "./fact-icon";
import { ROUTE, splitSubtitle } from "./plan-card";
import { JourneySentence } from "./journey";
import { costAnswer, findFact, openAnswer, priceFact, shortUnknown } from "./answers";

const ease = [0.22, 1, 0.36, 1] as const;
const item = (i: number) => ({ initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.4, delay: 0.18 + i * 0.05, ease } });

/** A checked fact. The source sits in a small chip that shows on hover, focus or tap, not on every row. */
function Row({ icon: Icon, label, fact, fallback }: { icon: typeof Clock; label: string; fact?: Fact; fallback?: string }) {
  const [show, setShow] = useState(false);
  const v: Verdict = fact?.verdict ?? "unknown";
  return (
    <li>
      <button
        type="button"
        onClick={() => setShow((x) => !x)}
        aria-expanded={fact ? show : undefined}
        disabled={!fact}
        className="group/row -mx-2 grid w-[calc(100%+1rem)] cursor-pointer grid-cols-[24px_1fr_auto] items-center gap-x-2.5 rounded-[12px] px-2 py-2 text-left transition-colors duration-200 hover:bg-raised focus-visible:bg-raised disabled:cursor-default"
      >
        {fact && weatherKind(fact) ? (
          <WeatherIcon fact={fact} className="size-6 [&>svg]:size-3.5" />
        ) : (
          <span className="grid size-6 place-items-center rounded-full bg-sky-wash text-sky-ink"><Icon className="size-3.5" aria-hidden /></span>
        )}
        <span className="min-w-0">
          <span className="block text-[14px] leading-5 text-ink"><span className="text-ink-3">{fact?.label ?? label}: </span>{fact?.value ?? fallback ?? "not listed"}</span>
          {fact ? (
            <span className={cn("num mt-1 h-5 items-center rounded-full bg-sky-wash px-2 font-mono text-[10.5px] text-sky-ink", show ? "inline-flex" : "hidden group-hover/row:inline-flex group-focus-visible/row:inline-flex")}>
              {fact.source}
              {fact.asOf ? ` · ${fmtAsOf(fact.asOf)}` : ""}
            </span>
          ) : null}
        </span>
        <VerdictChip verdict={v} size="sm" />
      </button>
    </li>
  );
}

function Answer({ icon: Icon, q, children, tone = "plain", fact, i }: { icon: typeof Clock; q: string; children: React.ReactNode; tone?: "ok" | "warn" | "plain" | "unknown"; fact?: Fact; i: number }) {
  return (
    <motion.div {...item(i)} className="grid grid-cols-[40px_1fr] items-start gap-3 py-3">
      <span className={cn("grid size-10 place-items-center rounded-[12px] shadow-e1", { ok: "bg-ok-bg text-ok", warn: "bg-amber-soft text-amber-ink", plain: "bg-sky-soft text-sky-ink", unknown: "bg-unknown-bg text-unknown" }[tone])}>
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-[12.5px] font-semibold text-ink-3">
          {q}
          {fact ? <VerdictChip verdict={fact.verdict} size="sm" title={`${fact.source}${fact.asOf ? ` · checked ${fmtAsOf(fact.asOf)}` : ""}`} /> : null}
        </p>
        <div className="mt-0.5 text-[17px] font-semibold leading-[1.35] tracking-[-0.01em] text-ink">{children}</div>
      </div>
    </motion.div>
  );
}

export function PlaceDetail({
  card,
  index,
  result,
  example,
  onClose,
  onSend,
}: {
  card: Card;
  index: number;
  result: PlanResultWithAgent;
  example: boolean;
  onClose: () => void;
  onSend: () => void;
}) {
  const { type, address } = splitSubtitle(card.subtitle);
  const hours = findFact(card, /^open/i);
  const open = openAnswer(card, result.when);
  const cost = costAnswer(card);
  const lines = findFact(card, /train|lines?$|status/i);
  const travel = findFact(card, /^travel/i);
  const weather = card.facts.find((f) => weatherKind(f)) ?? findFact(card, /weather/i);
  const price = priceFact(card);
  const access = findFact(card, /step-free|wheelchair|access/i);
  const signup = findFact(card, /sign-up|when/i);
  const used = new Set([hours, lines, travel, weather, price, access, signup].filter(Boolean));
  const other = card.facts.filter((f) => !used.has(f));
  const nChecks = card.facts.length + result.unknowns.length;
  const [checks, setChecks] = useState(false);
  const { lat, lng } = card.location;
  const osm = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=18/${lat.toFixed(5)}/${lng.toFixed(5)}`;
  const citymapper = `https://citymapper.com/directions?endcoord=${lat.toFixed(5)}%2C${lng.toFixed(5)}&endname=${encodeURIComponent(card.name)}`;
  let i = 0;

  return (
    <motion.section
      layoutId={`place-${card.id}`}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="relative overflow-hidden rounded-[20px] sw-glass-card shadow-e3 ring-1 ring-line/70"
      aria-label={`${card.name} details`}
    >
      {/* Blind header */}
      <div className="relative overflow-hidden border-b border-rule bg-gradient-to-b from-tint to-surface px-4 pb-4 pt-3 text-ink">
        <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-signal" />
        <div className="sw-blind-grain pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="relative flex items-center gap-2">
          <button type="button" onClick={onClose} className="sw-btn sw-btn-ghost -ml-1.5 min-h-9 gap-1 rounded-full px-2.5 text-[12.5px] font-semibold">
            <ArrowLeft className="size-4" aria-hidden /> All picks
          </button>
          {example ? <span className="ml-auto rounded-full bg-likely-bg px-2 py-0.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.08em] text-likely">Example data</span> : null}
        </div>
        <div className="relative mt-2 flex items-end gap-3">
          <motion.div layoutId={`rank-${card.id}`} className={cn("grid size-14 shrink-0 place-items-center rounded-[12px] font-mono text-[28px] font-bold tracking-[-0.04em]", index === 0 ? "bg-signal-strong text-white shadow-accent" : "bg-sky-soft text-sky-ink shadow-e1")}>
            {String(index + 1).padStart(2, "0")}
          </motion.div>
          <div className="min-w-0">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-signal-ink">{type}{card.kind === "event" ? " · event" : ""}</p>
            <motion.h2 layoutId={`name-${card.id}`} className="text-[24px] font-bold leading-[1.08] tracking-[-0.025em] text-ink">{card.name}</motion.h2>
          </div>
        </div>
        {address ? <motion.p {...item(0)} className="relative mt-2 text-[13px] text-ink-2">{address}</motion.p> : null}
        <motion.p {...item(1)} className="num relative mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-ink-3">For {fmtWhen(result.when)}</motion.p>
      </div>

      <div className="px-4 pb-4">
        {/* Three plain answers */}
        <div className="divide-y divide-rule">
          <Answer i={i++} icon={Clock} q="Open?" tone={open.state === true ? "ok" : open.state === false ? "warn" : "unknown"} fact={open.fact}>
            {open.text}
            {open.sub ? <p className="text-[13px] font-medium text-ink-3">{open.sub}</p> : null}
          </Answer>
          <Answer i={i++} icon={Route} q="How to get there?">
            <ul className="flex flex-col gap-2">
              {card.legs.map((l, k) => (
                <li key={l.who + k} className="grid grid-cols-[auto_1fr] gap-x-2 text-[15px] font-medium text-ink-2">
                  <span className="mt-[9px] size-2.5 rounded-full ring-2 ring-white" style={{ background: ROUTE[l.who] }} aria-hidden />
                  <span>
                    <span className="font-semibold text-ink">{l.who === "you" ? "You" : "Them"}: </span>
                    <JourneySentence leg={l} />
                    {l.who === "them" && result.them ? <span className="block text-[12px] font-normal text-ink-3">from around {result.them.area} (rounded)</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          </Answer>
          <Answer i={i++} icon={Banknote} q="Cost?" tone={cost.fact && !/not listed/i.test(cost.text) ? "plain" : "unknown"} fact={cost.fact}>
            {cost.text}
            {/not listed/i.test(cost.text) ? <p className="text-[13px] font-medium text-ink-3">Check before you go</p> : null}
          </Answer>
        </div>

        {weather ? (
          <motion.p {...item(i++)} className="mt-1 flex items-center gap-2 rounded-[12px] bg-raised px-2.5 py-2 text-[14px] text-ink">
            <WeatherIcon fact={weather} className="size-7 [&>svg]:size-4" />
            <span className="min-w-0">{weather.value}</span>
          </motion.p>
        ) : null}

        {card.why ? <motion.p {...item(i++)} className="mt-3 text-[14.5px] leading-[21px] text-ink-2">“{card.why}”</motion.p> : null}

        {/* Everything else, closed by default */}
        <motion.div {...item(i++)} className="mt-3 overflow-hidden rounded-[14px] bg-raised ring-1 ring-line/70">
          <button type="button" onClick={() => setChecks((o) => !o)} aria-expanded={checks} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3.5 text-left text-[14px] font-semibold text-ink transition-colors duration-200 hover:bg-sky-wash active:bg-sky-soft">
            <ListChecks className="size-4 text-sky-ink" aria-hidden />
            {checks ? "Hide the checks" : `Show the checks (${nChecks})`}
            <ChevronDown className={cn("ml-auto size-4 text-ink-3 transition-transform duration-200", checks && "rotate-180")} aria-hidden />
          </button>
          <AnimatePresence initial={false}>
            {checks ? (
              <motion.div key="checks" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease }} className="overflow-hidden">
                <div className="border-t border-line bg-surface px-3.5 pb-3 pt-1">
                  <ul className="flex flex-col">
                    <Row icon={Clock} label="Opening hours" fact={hours} fallback="not listed" />
                    {signup ? <Row icon={Clock} label="Sign-up" fact={signup} /> : null}
                    <Row icon={TrainFront} label="Trains" fact={lines ?? travel} fallback="not checked" />
                    {lines && travel ? <Row icon={Navigation} label="Travel" fact={travel} /> : null}
                    <Row icon={Banknote} label="Price" fact={price} fallback="not listed" />
                    <Row icon={Accessibility} label="Step-free" fact={access} fallback="not tagged" />
                    {weather ? <Row icon={CloudSun} label="Weather" fact={weather} /> : null}
                    {other.map((f) => (
                      <Row key={f.label} icon={HelpCircle} label={f.label} fact={f} />
                    ))}
                  </ul>
                  {card.url ? (
                    <a href={card.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-[13.5px] font-semibold text-ink underline decoration-hi decoration-2 underline-offset-4 hover:decoration-signal">
                      <Globe className="size-3.5" aria-hidden /> {card.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 42)} <ArrowUpRight className="size-3.5" aria-hidden />
                    </a>
                  ) : null}

                  {result.unknowns.length ? (
                    <div className="mt-3">
                      <h3 className="text-[12.5px] font-semibold text-ink-3">Not known</h3>
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {[...new Set(result.unknowns.map(shortUnknown))].map((u) => (
                          <li key={u} className="inline-flex h-7 items-center gap-1 rounded-full bg-unknown-bg px-2.5 text-[12.5px] text-unknown">
                            <HelpCircle className="size-3" aria-hidden /> {u}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  <div className="mt-3">
                    <h3 className="text-[12.5px] font-semibold text-ink-3">Sources</h3>
                    <ul className="mt-1.5 flex flex-wrap gap-1.5">
                      {result.sources.map((s) => (
                        <li key={s.name} className="num inline-flex h-6 items-center gap-1 rounded-full bg-raised px-2 font-mono text-[10.5px] text-ink-2">
                          {s.name} <span className="text-ink-3">{fmtAsOf(s.asOf)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </motion.div>

        {/* Actions */}
        <motion.div {...item(i++)} className="mt-4 grid grid-cols-2 gap-2">
          <button type="button" onClick={onSend} className="sw-btn sw-btn-primary col-span-2 min-h-12 rounded-[12px] px-4 text-[15px] font-semibold">
            <Send className="size-4" aria-hidden /> Send plan (opens a draft)
          </button>
          <a href={citymapper} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-quiet min-h-11 gap-1.5 rounded-[12px] px-3 text-[13.5px] font-semibold">
            <Navigation className="size-4" aria-hidden /> Citymapper
          </a>
          <a href={gmapsDirections(lat, lng)} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-quiet min-h-11 gap-1.5 rounded-[12px] px-3 text-[13.5px] font-semibold">
            <ExternalLink className="size-4" aria-hidden /> Transit directions
          </a>
          <a href={osm} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-ghost col-span-2 min-h-11 gap-1.5 rounded-[12px] bg-raised px-3 text-[13.5px] font-semibold">
            <MapIcon className="size-4" aria-hidden /> Open in OpenStreetMap
          </a>
        </motion.div>
      </div>
    </motion.section>
  );
}
