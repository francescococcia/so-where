"use client";

import { useEffect, useState } from "react";
import { animate, AnimatePresence, motion, useDragControls, useMotionValue, useReducedMotion, type PanInfo } from "motion/react";
import { Accessibility, ArrowUpRight, Banknote, ChevronDown, Clock, CloudSun, Globe, HelpCircle, Map as MapIcon, Navigation, Send, Sparkles, TrainFront, X } from "lucide-react";
import type { Fact, PlanCard as Card, Leg, PlanResultWithAgent, Verdict } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { VerdictChip } from "./verdict-chip";
import { fmtAsOf, fmtTime, gmapsDirections } from "./format";
import { WeatherIcon, weatherKind } from "./fact-icon";
import { CuisineChip, ROUTE, splitSubtitle } from "./plan-card";
import { JourneySentence } from "./journey";
import { useActiveSeg } from "./vehicles";
import { PhotoHero, RatingSlot, placeMeta, whyHere } from "./place-photo";
import { BestFor, LeaveByChip, SourcePill, leaveByOf } from "./blurb";
import { blurbOf } from "./use-plan";
import { TONE_CLASS, costAnswer, cuisineChip, hoursRow, findFact, kindLabel, noTime, openAnswer, priceFact, shortUnknown } from "./answers";

const ease = [0.22, 1, 0.36, 1] as const;

/** "12 min for you · 14 for her · open till 23:00": the fit facts kept under a blurb. */
function fitLine(result: PlanResultWithAgent, card: Card, openText: string, openNow: boolean | null) {
  const you = card.legs.find((l) => l.who === "you");
  const them = card.legs.find((l) => l.who === "them");
  const who = result.headline.match(/,\s*(her|him|them)\s+\d+/i)?.[1]?.toLowerCase() ?? "them";
  const till = openNow === true ? openText.match(/^Open (?:(\w{3}) )?until (.+)$/) : null;
  return [
    you ? `${you.minutes} min for you` : "",
    them ? `${them.minutes}${you ? "" : " min"} for ${who}` : "",
    till ? `open ${till[1] ? `${till[1]} ` : ""}till ${till[2]}` : /^Closes soon · (.+)$/.exec(openText)?.[1] ? `closes ${/^Closes soon · (.+)$/.exec(openText)![1]}` : "",
  ].filter(Boolean).join(" · ");
}
const item = (i: number) => ({ initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.35, delay: 0.08 + i * 0.04, ease } });

/** A checked fact; its source shows on hover, focus or tap. */
function Row({ icon: Icon, label, fact }: { icon: typeof Clock; label: string; fact?: Fact }) {
  const [show, setShow] = useState(false);
  const v: Verdict = fact?.verdict ?? "unknown";
  return (
    <li>
      <button
        type="button"
        onClick={() => setShow((x) => !x)}
        aria-expanded={fact ? show : undefined}
        disabled={!fact}
        className="group/row -mx-2 grid w-[calc(100%+1rem)] cursor-pointer grid-cols-[22px_1fr_auto] items-center gap-x-2.5 rounded-[10px] px-2 py-1.5 text-left transition-colors duration-200 hover:bg-white/70 focus-visible:bg-white/70 disabled:cursor-default"
      >
        {fact && weatherKind(fact) ? <WeatherIcon fact={fact} className="size-[22px] [&>svg]:size-3.5" /> : <Icon className="mx-auto size-4 text-ink-3" aria-hidden />}
        <span className="min-w-0">
          <span className="block text-[13.5px] leading-5 text-ink"><span className="text-ink-3">{fact?.label ?? label} </span>{fact?.value ?? "—"}</span>
          {fact ? (
            <span className={cn("num mt-0.5 h-5 items-center rounded-full bg-sunk px-2 font-mono text-[10.5px] text-ink-2", show ? "inline-flex" : "hidden group-hover/row:inline-flex group-focus-visible/row:inline-flex")}>
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

function Tile({ label, value, dot, tone, i }: { label: string; value: string; dot?: string; tone?: string; i: number }) {
  return (
    <motion.div {...item(i)} className="min-w-0 rounded-[12px] bg-white/70 px-3 py-2 shadow-e1 ring-1 ring-white/80">
      <p className="flex items-center gap-1.5 text-[11.5px] font-medium text-ink-3">
        {dot ? <span className="size-2 rounded-full" style={{ background: dot }} aria-hidden /> : null}
        {label}
      </p>
      <p className={cn("num truncate text-[16px] font-bold tracking-[-0.01em] text-ink", tone)}>{value}</p>
    </motion.div>
  );
}

/** One person's journey; the segment the map vehicle is on gets a soft highlight. */
function JourneyRow({ cardId, leg, area }: { cardId: string; leg: Leg; area?: string }) {
  const active = useActiveSeg(cardId, leg.who);
  return (
    <li className="grid grid-cols-[auto_1fr] gap-x-2.5 text-[14px] text-ink-2">
      <span className={cn("mt-[7px] size-2.5 rounded-full ring-2 ring-white transition-transform duration-300", active != null && "scale-125")} style={{ background: ROUTE[leg.who] }} aria-hidden />
      <span>
        <span className="font-semibold text-ink">{leg.who === "you" ? "You" : "Them"} </span>
        <JourneySentence leg={leg} active={active} />
        {area ? <span className="block text-[12px] text-ink-3">from ~{area}</span> : null}
      </span>
    </li>
  );
}

/** Lumap-style place detail: header, two actions, stat tiles, journeys, then the checks (closed). */
export function PlaceDetail({ card, result, example, onClose, onSend }: { card: Card; result: PlanResultWithAgent; example: boolean; onClose: () => void; onSend: () => void }) {
  const { type, address } = splitSubtitle(card.subtitle);
  const label = kindLabel(type, card.kind === "event" ? "Event" : "");
  const hoursRaw = findFact(card, /^open/i);
  const hours = hoursRaw && !noTime(hoursRaw.value) ? hoursRaw : undefined;
  const open = openAnswer(card, result.when);
  const blurb = blurbOf(card);
  const leaveBy = leaveByOf(result);
  const fit = blurb ? fitLine(result, card, open.text, open.state) : "";
  const cost = costAnswer(card);
  const cuisine = cuisineChip(card);
  const lines = findFact(card, /train|lines?$|status/i);
  const travel = findFact(card, /^travel/i);
  const weather = findFact(card, /weather|forecast/i) ?? card.facts.find((f) => f !== lines && f !== travel && weatherKind(f));
  const price = priceFact(card);
  const access = findFact(card, /step-free|wheelchair|access/i);
  const whenRaw = findFact(card, /sign-up|when/i);
  const signup = whenRaw && !noTime(whenRaw.value) ? whenRaw : undefined;
  const used = new Set([hoursRaw, lines, travel, weather, price, access, whenRaw].filter(Boolean));
  const shownVals = new Set([...used].map((f) => f!.value.trim().toLowerCase()));
  const other = card.facts.filter((f) => !used.has(f) && !noTime(f.value) && !shownVals.has(f.value.trim().toLowerCase()));
  const nChecks = card.facts.length + result.unknowns.length;
  const [checks, setChecks] = useState(false);
  const { lat, lng } = card.location;
  const osm = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=18/${lat.toFixed(5)}/${lng.toFixed(5)}`;
  const citymapper = `https://citymapper.com/directions?endcoord=${lat.toFixed(5)}%2C${lng.toFixed(5)}&endname=${encodeURIComponent(card.name)}`;
  const tiles: { label: string; value: string; dot?: string; tone?: string }[] = [
    ...card.legs.map((l) => ({ label: l.who === "you" ? "You" : "Them", value: `${l.minutes} min`, dot: ROUTE[l.who] })),
    ...(() => {
      const um = open.text.match(/^Open (?:(\w{3}) )?until (.+)$/);
      const until = um?.[2]?.replace(/^midnight$/, "Midnight");
      const soon = open.text.match(/^Closes soon(?: · (.+))?$/);
      if (soon) return [{ label: "Closes soon", value: soon[1] ?? fmtTime(result.when), tone: TONE_CLASS.soon }];
      if (until) return [{ label: um?.[1] ? `Open ${um[1]} until` : "Open until", value: until, tone: TONE_CLASS.ok }];
      if (open.text === "Open 24 hours") return [{ label: "Open", value: "24 hours", tone: TONE_CLASS.ok }];
      if (open.state === true) return [{ label: "Open at", value: fmtTime(result.when), tone: TONE_CLASS.ok }];
      if (open.state === false) return [{ label: "Closed at", value: fmtTime(result.when), tone: TONE_CLASS.closed }];
      return card.kind === "venue" ? [{ label: "Hours", value: "Not listed", tone: TONE_CLASS.unknown }] : [];
    })(),
    ...(cost.fact && !/not listed/i.test(cost.text) ? [{ label: "Cost", value: cost.text }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      {/* Header: Google-Maps-style place card */}
      <div className="flex flex-col gap-2.5">
        <motion.div initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.45, ease }} className="pr-10 max-sm:pr-0">
          <PhotoHero card={card} />
        </motion.div>
        <div>
          <h2 className="text-[24px] font-bold leading-[1.1] tracking-[-0.025em] text-ink">{card.name}</h2>
          {blurb?.bestFor ? <BestFor text={blurb.bestFor} className="mt-1.5" /> : null}
          <RatingSlot rating={(card as Card & { rating?: { value: number; count: number; source: string } }).rating} />
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13.5px] text-ink-2">
            <span>{[placeMeta(result, card) || label, cost.fact && !/not listed/i.test(cost.text) ? cost.text : ""].filter(Boolean).join(" · ")}</span>
            {cuisine ? <CuisineChip {...cuisine} /> : null}
            {example ? <span className="inline-flex h-5 items-center rounded-full bg-likely-bg px-2 text-[11.5px] font-semibold text-likely">Example</span> : null}
          </p>
          {address ? <p className="mt-0.5 text-[12.5px] text-ink-3">{address}</p> : null}
          {leaveBy ? <LeaveByChip lb={leaveBy} className="mt-2.5" /> : null}
          {blurb ? (
            <motion.div {...item(0)} className="mt-2.5 flex gap-2 rounded-[12px] bg-signal-soft px-3 py-2.5 text-[13.5px] leading-5 text-ink">
              <Sparkles className="mt-[3px] size-3.5 shrink-0 text-signal-ink" aria-hidden />
              <div className="min-w-0">
                <p>
                  <span className="font-semibold text-signal-ink">Why here: </span>
                  {blurb.text} <SourcePill source={blurb.source} className="ml-0.5" />
                </p>
                {fit ? <p className="num mt-1 text-[12px] leading-[17px] text-ink-3">{fit}</p> : null}
              </div>
            </motion.div>
          ) : (
            <motion.p {...item(0)} className="mt-2.5 flex gap-2 rounded-[12px] bg-signal-soft px-3 py-2 text-[13.5px] leading-5 text-ink">
              <Sparkles className="mt-[3px] size-3.5 shrink-0 text-signal-ink" aria-hidden />
              <span><span className="font-semibold text-signal-ink">Why here: </span>{whyHere(result, card)}</span>
            </motion.p>
          )}
        </div>
      </div>

      {/* Two actions */}
      <motion.div {...item(0)} className="grid grid-cols-2 gap-2">
        <a href={gmapsDirections(lat, lng)} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-quiet min-h-11 gap-1.5 rounded-[12px] px-3 text-[14px] font-semibold">
          <Navigation className="size-4" aria-hidden /> Directions
        </a>
        <button type="button" onClick={onSend} className="sw-btn sw-btn-primary min-h-11 gap-1.5 rounded-[12px] px-3 text-[14px] font-semibold">
          <Send className="size-4" aria-hidden /> Send plan
        </button>
      </motion.div>

      {/* Stat tiles */}
      {tiles.length ? (
        <div className={cn("grid gap-2", tiles.length >= 4 ? "grid-cols-2 sm:grid-cols-4" : tiles.length === 3 ? "grid-cols-3" : "grid-cols-2")}>
          {tiles.map((t, k) => <Tile key={t.label + k} {...t} i={k + 1} />)}
        </div>
      ) : null}

      {/* Journeys */}
      <motion.ul {...item(4)} className="flex flex-col gap-2.5">
        {card.legs.map((l, k) => (
          <JourneyRow key={l.who + k} cardId={card.id} leg={l} area={l.who === "them" ? result.them?.area : undefined} />
        ))}
      </motion.ul>


      {/* Checks, closed by default */}
      <motion.div {...item(6)} className="overflow-hidden rounded-[14px] bg-white/55 ring-1 ring-white/80">
        <button type="button" onClick={() => setChecks((o) => !o)} aria-expanded={checks} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3.5 text-left text-[14px] font-semibold text-ink transition-colors duration-200 hover:bg-white/70">
          Checks <span className="num font-mono text-[12px] font-medium text-ink-3">{nChecks}</span>
          <ChevronDown className={cn("ml-auto size-4 text-ink-3 transition-transform duration-200", checks && "rotate-180")} aria-hidden />
        </button>
        <AnimatePresence initial={false}>
          {checks ? (
            <motion.div key="checks" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.28, ease }} className="overflow-hidden">
              <div className="border-t border-white/80 px-3.5 pb-3 pt-1">
                <ul className="flex flex-col">
                  <Row icon={Clock} label="Hours" fact={hoursRow(hours)} />
                  {signup ? <Row icon={Clock} label="When" fact={signup} /> : null}
                  <Row icon={TrainFront} label="Trains" fact={lines ?? travel} />
                  {lines && travel && travel.value !== lines.value ? <Row icon={Navigation} label="Travel" fact={travel} /> : null}
                  <Row icon={Banknote} label="Price" fact={price} />
                  {access ? <Row icon={Accessibility} label="Step-free" fact={access} /> : null}
                  {weather ? <Row icon={CloudSun} label="Weather" fact={weather} /> : null}
                  {other.map((f) => <Row key={f.label} icon={HelpCircle} label={f.label} fact={f} />)}
                </ul>
                {result.unknowns.length ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Not known">
                    {[...new Set(result.unknowns.map(shortUnknown))].map((u) => (
                      <li key={u} className="inline-flex h-7 items-center gap-1 rounded-full bg-unknown-bg px-2.5 text-[12.5px] text-unknown">
                        <HelpCircle className="size-3" aria-hidden /> {u}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[13px] font-semibold text-ink">
                  <a href={citymapper} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-signal-ink"><Navigation className="size-3.5" aria-hidden /> Citymapper</a>
                  <a href={osm} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-signal-ink"><MapIcon className="size-3.5" aria-hidden /> OpenStreetMap</a>
                  {card.url ? <a href={card.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:text-signal-ink"><Globe className="size-3.5" aria-hidden /> Website <ArrowUpRight className="size-3" aria-hidden /></a> : null}
                </div>
                <p className="num mt-3 font-mono text-[10.5px] leading-4 text-ink-3">{result.sources.map((s) => `${s.name} ${fmtAsOf(s.asOf)}`).join(" · ")}</p>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

/**
 * The detail lives outside the list: a floating glass panel on the right (≥768px),
 * or a bottom sheet with ~50% / ~90% snap points on phones. Content crossfades when the place changes.
 */
export function DetailPanel({ card, mobile, onClose, ...rest }: { card: Card | null; mobile: boolean; result: PlanResultWithAgent; example: boolean; onClose: () => void; onSend: () => void }) {
  const drag = useDragControls();
  const [snap, setSnap] = useState<"half" | "full">("half");
  const sheetY = useMotionValue(2000);
  const reduced = useReducedMotion();
  const spring = reduced ? ({ duration: 0 } as const) : ({ type: "spring", stiffness: 300, damping: 34 } as const);
  // Sheet is 90svh tall; "half" shows ~50% of the screen, "full" ~90%.
  const halfY = () => (typeof window === "undefined" ? 400 : window.innerHeight * 0.4);
  useEffect(() => {
    if (!mobile || !card) return;
    const c = animate(sheetY, snap === "full" ? 0 : halfY(), spring);
    return () => c.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mobile, !!card, snap]);
  useEffect(() => {
    if (!card) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [card, onClose]);
  useEffect(() => {
    if (!card) setSnap("half");
  }, [card]);

  const body = card ? (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.div key={card.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.25, ease }}>
        <PlaceDetail card={card} onClose={onClose} {...rest} />
      </motion.div>
    </AnimatePresence>
  ) : null;
  const close = (
    <button type="button" onClick={onClose} aria-label="Close details" className="absolute right-3 top-3 z-10 grid size-9 cursor-pointer place-items-center rounded-full bg-white/80 text-ink-2 shadow-e1 ring-1 ring-line/60 transition-colors hover:bg-white hover:text-ink">
      <X className="size-4" aria-hidden />
    </button>
  );

  if (!mobile) {
    return (
      <AnimatePresence>
        {card ? (
          <motion.aside
            key="detail-panel"
            role="dialog"
            aria-label={`${card.name} details`}
            initial={{ x: 420, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 420, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 30 }}
            className="sw-glass fixed bottom-4 right-4 top-4 z-30 flex w-[380px] flex-col rounded-[22px]"
          >
            {close}
            <div className="flex-1 overflow-y-auto px-5 pb-5 pt-5">{body}</div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    );
  }

  const onDragEnd = (_: unknown, info: PanInfo) => {
    const vh = window.innerHeight;
    const y = sheetY.get();
    const v = info.velocity.y;
    let next: "half" | "full" | "close";
    if (v > 700 || y > vh * 0.6) next = "close";
    else if (v < -400 || y < vh * 0.2) next = "full";
    else next = "half";
    if (next === "close") return onClose();
    if (next === snap) animate(sheetY, next === "full" ? 0 : halfY(), spring);
    else setSnap(next);
  };

  return (
    <AnimatePresence>
      {card ? (
        <motion.aside
          key="detail-sheet"
          role="dialog"
          aria-label={`${card.name} details`}
          style={{ y: sheetY }}
          exit={{ y: typeof window === "undefined" ? 1000 : window.innerHeight, transition: { duration: 0.25, ease } }}
          drag="y"
          dragListener={false}
          dragControls={drag}
          dragMomentum={false}
          dragConstraints={{ top: 0 }}
          dragElastic={{ top: 0.05, bottom: 0 }}
          onDragEnd={onDragEnd}
          className="sw-glass fixed inset-x-0 bottom-0 z-40 flex h-[90svh] flex-col rounded-t-[24px] shadow-e3"
        >
          <div onPointerDown={(e) => drag.start(e)} className="flex shrink-0 cursor-grab touch-none justify-center pb-2 pt-2.5 active:cursor-grabbing">
            <button type="button" aria-label={snap === "full" ? "Shrink details" : "Expand details"} onClick={() => setSnap((s) => (s === "full" ? "half" : "full"))} className="h-1.5 w-11 rounded-full bg-ink-3/40" />
          </div>
          {close}
          <div className={cn("flex-1 overscroll-contain px-4 pt-1", snap === "full" ? "overflow-y-auto pb-6" : "overflow-y-auto pb-[46svh]")}>{body}</div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
