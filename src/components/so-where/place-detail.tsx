"use client";

import { motion } from "motion/react";
import { Accessibility, ArrowLeft, ArrowUpRight, Banknote, Clock, CloudSun, ExternalLink, Footprints, Globe, HelpCircle, Map as MapIcon, Navigation, Phone, Send, TrainFront } from "lucide-react";
import type { Fact, PlanCard as Card, PlanResultWithAgent, Verdict } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { VerdictChip } from "./verdict-chip";
import { fmtAsOf, fmtTime, fmtWhen, gmapsDirections } from "./format";
import { CountUp, lineColour } from "./motion-bits";
import { MiniBars, ROUTE, WHO, splitSubtitle } from "./plan-card";

const ease = [0.22, 1, 0.36, 1] as const;
const item = (i: number) => ({ initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.4, delay: 0.18 + i * 0.05, ease } });

function find(card: Card, re: RegExp) {
  return card.facts.find((f) => re.test(f.label));
}

/** "12:00–00:00" → is `when` inside it (London time)? Returns null when we can't tell. */
function openAt(hours: string | undefined, whenIso: string): boolean | null {
  if (!hours) return null;
  const m = hours.match(/(\d{1,2}):(\d{2})\s*[–-]\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const t = fmtTime(whenIso).split(":").map(Number);
  if (t.length < 2 || t.some(Number.isNaN)) return null;
  const now = t[0] * 60 + t[1];
  const a = +m[1] * 60 + +m[2];
  let b = +m[3] * 60 + +m[4];
  if (b <= a) b += 24 * 60;
  return (now >= a && now < b) || (now + 1440 >= a && now + 1440 < b);
}

function walkEstimate(card: Card) {
  for (const l of card.legs) {
    const m = l.summary.match(/~?(\d+)\s*min walk/i);
    if (m) return { who: l.who, min: +m[1], est: /estimate/i.test(l.summary) };
  }
  return null;
}

function Row({ icon: Icon, label, fact, fallback, i }: { icon: typeof Clock; label: string; fact?: Fact; fallback?: string; i: number }) {
  const v: Verdict = fact?.verdict ?? "unknown";
  return (
    <motion.div {...item(i)} className="grid grid-cols-[28px_1fr_auto] items-start gap-x-2.5 py-2.5">
      <span className="grid size-7 place-items-center rounded-full bg-raised text-ink"><Icon className="size-3.5" aria-hidden /></span>
      <div className="min-w-0">
        <p className="text-[11.5px] font-medium text-ink-3">{fact?.label ?? label}</p>
        <p className="text-[14.5px] font-medium leading-5 text-ink">{fact?.value ?? fallback ?? "Not in our sources"}</p>
        <p className="num mt-0.5 font-mono text-[10.5px] text-ink-3">
          {fact ? fact.source : "—"}
          {fact?.asOf ? ` · checked ${fmtAsOf(fact.asOf)}` : ""}
        </p>
      </div>
      <VerdictChip verdict={v} delay={0.25 + i * 0.05} />
    </motion.div>
  );
}

function Segments({ summary }: { summary: string }) {
  const parts = summary.split(/\s*·\s*|,\s*then\s*|\s+then\s+/i).filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-1">
      {parts.map((p, i) => {
        const c = lineColour(p);
        const walk = /walk/i.test(p);
        return (
          <span key={i} className="inline-flex items-center gap-1">
            {i ? <span className="text-ink-3" aria-hidden>›</span> : null}
            <span className={cn("inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold", c ? "text-white" : "bg-raised text-ink-2")} style={c ? { background: c, color: c === "#FFD300" || c === "#F3A9BB" || c === "#95CDBA" ? "#15171c" : "#fff" } : undefined}>
              {walk ? <Footprints className="size-3" aria-hidden /> : c ? <TrainFront className="size-3" aria-hidden /> : null}
              {p}
            </span>
          </span>
        );
      })}
    </span>
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
  const hours = find(card, /^open/i);
  const isOpen = openAt(hours?.value, result.when);
  const lines = find(card, /train|lines?$|status/i);
  const travel = find(card, /^travel/i);
  const weather = find(card, /weather/i);
  const price = find(card, /price|entry|fee|£/i);
  const access = find(card, /step-free|wheelchair|access/i);
  const signup = find(card, /sign-up|when/i);
  const used = new Set([hours, lines, travel, weather, price, access, signup].filter(Boolean));
  const other = card.facts.filter((f) => !used.has(f));
  const walk = walkEstimate(card);
  const { lat, lng } = card.location;
  const osm = `https://www.openstreetmap.org/?mlat=${lat.toFixed(5)}&mlon=${lng.toFixed(5)}#map=18/${lat.toFixed(5)}/${lng.toFixed(5)}`;
  const citymapper = `https://citymapper.com/directions?endcoord=${lat.toFixed(5)}%2C${lng.toFixed(5)}&endname=${encodeURIComponent(card.name)}`;
  let i = 0;

  return (
    <motion.section
      layoutId={`place-${card.id}`}
      transition={{ type: "spring", stiffness: 300, damping: 32 }}
      className="relative overflow-hidden rounded-[20px] bg-surface ring-2 ring-ink"
      aria-label={`${card.name} details`}
    >
      {/* Blind header */}
      <div className="relative overflow-hidden bg-ink px-4 pb-4 pt-3 text-white">
        <div className="sw-blind-grain pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="relative flex items-center gap-2">
          <button type="button" onClick={onClose} className="-ml-1.5 inline-flex min-h-9 cursor-pointer items-center gap-1 rounded-full px-2 text-[12.5px] font-semibold text-white/80 transition-colors hover:bg-white/10 hover:text-white">
            <ArrowLeft className="size-4" aria-hidden /> All picks
          </button>
          {example ? <span className="ml-auto rounded-full bg-hi px-2 py-0.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.08em] text-ink">Example data</span> : null}
        </div>
        <div className="relative mt-2 flex items-end gap-3">
          <motion.div layoutId={`rank-${card.id}`} className={cn("grid size-14 shrink-0 place-items-center rounded-[12px] font-mono text-[28px] font-bold tracking-[-0.04em]", index === 0 ? "bg-signal" : "bg-white/10")}>
            {String(index + 1).padStart(2, "0")}
          </motion.div>
          <div className="min-w-0">
            <p className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-hi">{type}{card.kind === "event" ? " · event" : ""}</p>
            <motion.h2 layoutId={`name-${card.id}`} className="text-[24px] font-bold leading-[1.08] tracking-[-0.025em]">{card.name}</motion.h2>
          </div>
        </div>
        {address ? <motion.p {...item(0)} className="relative mt-2 text-[13px] text-white/75">{address}</motion.p> : null}
        <motion.p {...item(1)} className="num relative mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-white/60">For {fmtWhen(result.when)}</motion.p>
      </div>

      <div className="px-4 pb-4">
        {/* Open-at-time banner */}
        <motion.div {...item(i++)} className={cn("-mx-4 flex items-center gap-2 px-4 py-2.5 text-[13.5px] font-semibold", isOpen === true ? "bg-ok-bg text-ok" : isOpen === false ? "bg-signal-soft text-signal-ink" : "bg-unknown-bg text-unknown")}>
          <Clock className="size-4" aria-hidden />
          {isOpen === true ? `Open at ${fmtTime(result.when)}` : isOpen === false ? `Probably closed at ${fmtTime(result.when)}` : `Can't tell if it's open at ${fmtTime(result.when)}`}
          <span className="ml-auto font-mono text-[10.5px] uppercase tracking-[0.08em] opacity-80">{hours ? hours.verdict : "unknown"}</span>
        </motion.div>

        {card.why ? <motion.p {...item(i++)} className="mt-3 text-[15px] font-medium leading-[22px] text-ink">“{card.why}”</motion.p> : null}

        {/* Journeys */}
        <motion.h3 {...item(i++)} className="mt-4 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">Getting there</motion.h3>
        <motion.div {...item(i++)} className="mt-2 rounded-[14px] bg-raised p-3">
          {card.legs.length > 1 ? <MiniBars card={card} big delay={0.2} /> : null}
          <ol className={cn("flex flex-col gap-3", card.legs.length > 1 && "mt-3 border-t border-line pt-3")}>
            {card.legs.map((l, k) => (
              <li key={l.who + k} className="grid grid-cols-[auto_1fr] gap-x-3">
                <span className="mt-0.5 flex flex-col items-center">
                  <span className="size-3 rounded-full ring-2 ring-white" style={{ background: ROUTE[l.who] }} />
                  <span className="mt-1 w-0.5 flex-1 rounded-full" style={{ background: ROUTE[l.who], opacity: 0.35 }} />
                </span>
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold text-ink">{WHO[l.who]}</span>
                    <span className="num font-mono text-[20px] font-bold leading-none tracking-[-0.02em] text-ink"><CountUp value={l.minutes} delay={0.3 + k * 0.1} /></span>
                    <span className="text-[12px] text-ink-3">min{l.who === "them" ? " · from their rounded area" : ""}</span>
                  </p>
                  <div className="mt-1.5"><Segments summary={l.summary} /></div>
                </div>
              </li>
            ))}
          </ol>
          {walk ? (
            <p className="mt-3 flex items-center gap-1.5 border-t border-line pt-2.5 text-[12.5px] text-ink-2">
              <Footprints className="size-3.5" aria-hidden /> Last stretch on foot: ~{walk.min} min{walk.est ? " (our estimate, not TfL)" : ""}
            </p>
          ) : null}
        </motion.div>

        {/* Facts */}
        <motion.h3 {...item(i++)} className="mt-4 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">What we checked</motion.h3>
        <div className="mt-1 divide-y divide-rule">
          <Row icon={Clock} label="Opening hours" fact={hours} fallback="Hours not in our sources" i={i++} />
          {signup ? <Row icon={Clock} label="Sign-up" fact={signup} i={i++} /> : null}
          <Row icon={TrainFront} label="Line status" fact={lines ?? travel} fallback="Not checked" i={i++} />
          {lines && travel ? <Row icon={Navigation} label="Travel" fact={travel} i={i++} /> : null}
          <Row icon={Banknote} label="Price / entry" fact={price} fallback="No prices in our sources" i={i++} />
          <Row icon={Accessibility} label="Wheelchair / step-free" fact={access} fallback="Not tagged in OSM" i={i++} />
          <Row icon={CloudSun} label="Weather" fact={weather} fallback="No forecast" i={i++} />
          {other.map((f) => (
            <Row key={f.label} icon={HelpCircle} label={f.label} fact={f} i={i++} />
          ))}
          <motion.div {...item(i++)} className="grid grid-cols-[28px_1fr] items-start gap-x-2.5 py-2.5">
            <span className="grid size-7 place-items-center rounded-full bg-raised text-ink"><Globe className="size-3.5" aria-hidden /></span>
            <div className="min-w-0 text-[13.5px]">
              {card.url ? (
                <a href={card.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold text-ink underline decoration-hi decoration-2 underline-offset-4 hover:decoration-signal">
                  {card.url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "").slice(0, 42)} <ArrowUpRight className="size-3.5" aria-hidden />
                </a>
              ) : (
                <span className="text-ink-2">No website in our sources</span>
              )}
              <p className="mt-0.5 flex items-center gap-1 text-[12.5px] text-ink-3"><Phone className="size-3" aria-hidden /> Phone: not in our sources</p>
            </div>
          </motion.div>
        </div>

        {result.unknowns.length ? (
          <motion.section {...item(i++)} aria-label="Couldn't check" className="mt-3 rounded-[14px] border border-dashed border-control p-3">
            <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">Couldn&apos;t check</h3>
            <ul className="mt-1.5 flex flex-col gap-1">
              {result.unknowns.map((u) => (
                <li key={u} className="flex items-start gap-2 text-[13px] leading-5 text-ink-2">
                  <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-unknown" aria-hidden /> {u}
                </li>
              ))}
            </ul>
          </motion.section>
        ) : null}

        <motion.div {...item(i++)} className="mt-3">
          <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">Sources</h3>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {result.sources.map((s) => (
              <li key={s.name} className="num inline-flex h-6 items-center gap-1 rounded-full bg-raised px-2 font-mono text-[10.5px] text-ink-2">
                {s.name} <span className="text-ink-3">{fmtAsOf(s.asOf)}</span>
              </li>
            ))}
          </ul>
        </motion.div>

        {/* Actions */}
        <motion.div {...item(i++)} className="mt-4 grid grid-cols-2 gap-2">
          <motion.button type="button" whileTap={{ scale: 0.97 }} onClick={onSend} className="col-span-2 inline-flex min-h-12 cursor-pointer items-center justify-center gap-2 rounded-[12px] bg-signal px-4 text-[15px] font-semibold text-white shadow-[0_6px_0_#8f170f] transition-transform hover:-translate-y-0.5 active:translate-y-0.5 active:shadow-[0_2px_0_#8f170f]">
            <Send className="size-4" aria-hidden /> Send plan (opens a draft)
          </motion.button>
          <a href={citymapper} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[12px] border border-line px-3 text-[13.5px] font-semibold text-ink transition-colors hover:border-ink">
            <Navigation className="size-4" aria-hidden /> Citymapper
          </a>
          <a href={gmapsDirections(lat, lng)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[12px] border border-line px-3 text-[13.5px] font-semibold text-ink transition-colors hover:border-ink">
            <ExternalLink className="size-4" aria-hidden /> Transit directions
          </a>
          <a href={osm} target="_blank" rel="noopener noreferrer" className="col-span-2 inline-flex min-h-11 items-center justify-center gap-1.5 rounded-[12px] bg-raised px-3 text-[13.5px] font-semibold text-ink transition-colors hover:bg-sunk">
            <MapIcon className="size-4" aria-hidden /> Open in OpenStreetMap
          </a>
        </motion.div>
      </div>
    </motion.section>
  );
}
