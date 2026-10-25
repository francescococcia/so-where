"use client";

import { motion } from "motion/react";
import { Banknote, Clock, Sparkles } from "lucide-react";
import type { Fact, PlanCard as Card, Verdict } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { PhotoThumb } from "./place-photo";
import { CountUp, useTilt } from "./motion-bits";
import { JourneyCompact } from "./journey";
import { TONE_CLASS, costAnswer, cuisineChip, openAnswer } from "./answers";
import { WeatherIcon, weatherKind } from "./fact-icon";
import { BestFor, BlurbShimmer, cardArea, noPlaceholder } from "./blurb";
import { blurbOf } from "./use-plan";

export const WHO = { you: "You", them: "Them" } as const;
export const ROUTE = { you: "var(--sw-route-you)", them: "var(--sw-route-them)" } as const;
const V_DOT: Record<Verdict, string> = { confirmed: "bg-ok", likely: "bg-[#c99a00]", forecast: "bg-fc", unknown: "bg-control" };

export function splitSubtitle(s: string) {
  const [type, ...rest] = noPlaceholder(s).split(" · ");
  return { type: type ?? "", address: rest.join(" · ") };
}

export function keyFacts(card: Card, n = 2): Fact[] {
  const score = (f: Fact) => (/^open/i.test(f.label) ? 0 : /entry|price|sign-up|when/i.test(f.label) ? 1 : /train|line/i.test(f.label) ? 2 : 3) + (f.verdict === "unknown" ? 5 : 0);
  return [...card.facts].sort((a, b) => score(a) - score(b)).slice(0, n);
}

export function MiniBars({ card, big = false, delay = 0 }: { card: Card; big?: boolean; delay?: number }) {
  const max = Math.max(30, ...card.legs.map((l) => l.minutes));
  return (
    <div className={cn("flex flex-col", big ? "gap-2.5" : "gap-1.5")}>
      {card.legs.map((l, i) => (
        <div key={l.who + i} className="grid grid-cols-[38px_1fr_auto] items-center gap-2">
          <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">{WHO[l.who]}</span>
          <div className={cn("relative overflow-hidden rounded-full bg-sunk", big ? "h-2.5" : "h-1.5")}>
            <motion.span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: ROUTE[l.who], width: "100%", transformOrigin: "0% 50%" }}
              initial={{ scaleX: 0 }}
              animate={{ scaleX: l.minutes / max }}
              transition={{ duration: 0.9, delay: delay + 0.1 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span className={cn("num text-right font-mono font-semibold text-ink", big ? "min-w-[52px] text-[15px]" : "min-w-[44px] text-[13px]")}>
            <CountUp value={l.minutes} delay={delay + 0.1 + i * 0.12} />
            <span className="ml-0.5 text-[0.8em] font-medium text-ink-3">min</span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function PlanCard({
  card,
  index,
  when,
  selected,
  hovered,
  onOpen,
  onHover,
  blurbPending = false,
}: {
  blurbPending?: boolean;
  card: Card;
  when: string;
  index: number;
  selected: boolean;
  hovered: boolean;
  onOpen: () => void;
  onHover: (on: boolean) => void;
}) {
  const tilt = useTilt(4);
  const { type, address } = splitSubtitle(card.subtitle);
  const area = cardArea(card);
  const blurb = blurbOf(card);
  const wx = card.facts.find((f) => weatherKind(f));
  const open = openAnswer(card, when);
  const cost = costAnswer(card);
  const cuisine = cuisineChip(card);
  const vibe = vibeOf(card);
  const answers: { key: string; icon: typeof Clock; text: string; tone: string; sub?: string; dim?: boolean; v?: Verdict; wx?: Fact }[] = [
    ...(card.kind === "event" && open.state === null ? [] : [{ key: "open", icon: Clock, text: open.text, tone: TONE_CLASS[open.tone], sub: open.sub, dim: open.tone === "unknown", v: open.fact?.verdict }]),
    ...(cost.fact && !/not listed/i.test(cost.text) ? [{ key: "cost", icon: Banknote, text: cost.text, tone: "text-sky-ink", v: cost.fact.verdict }] : []),
    ...(wx ? [{ key: "wx", icon: Clock, text: wx.value, tone: "", v: wx.verdict, wx }] : []),
  ];
  const tally = (["confirmed", "likely", "forecast", "unknown"] as Verdict[]).map((v) => [v, card.facts.filter((f) => f.verdict === v).length] as const).filter(([, n]) => n);

  return (
    <motion.article
      layoutId={`place-${card.id}`}
      initial={{ opacity: 0, y: 26, rotateX: -8 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 26, delay: 0.25 + 0.09 * index, layout: { type: "spring", stiffness: 380, damping: 34 } }}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.985, y: -1 }}
      style={tilt.style}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={() => {
        tilt.onPointerLeave();
        onHover(false);
      }}
      onPointerEnter={() => onHover(true)}
      className={cn(
        "sw-card sw-glass-card group relative overflow-hidden rounded-[18px] [transform-style:preserve-3d]",
        selected ? "is-on" : "ring-1 ring-line/70",
        hovered && "is-hover"
      )}
    >
      <button type="button" onClick={onOpen} onFocus={() => onHover(true)} onBlur={() => onHover(false)} aria-label={`Open details for ${card.name}`} className="block w-full cursor-pointer rounded-[18px] text-left focus-visible:outline-offset-[-2px]">
        {/* ticket stub */}
        <div className="grid grid-cols-[64px_1fr]">
          <motion.div layoutId={`rank-${card.id}`} className={cn("relative flex flex-col items-center justify-between py-3.5 font-mono", index === 0 ? "bg-signal-strong text-white" : "bg-signal-soft text-signal-ink")}>
            <span className={cn("text-[10px] font-semibold uppercase tracking-[0.16em]", index === 0 ? "opacity-95" : "opacity-70")}>No.</span>
            <span className="num text-[30px] font-bold leading-none tracking-[-0.04em]">{String(index + 1).padStart(2, "0")}</span>
            <span className={cn("text-[9.5px] font-semibold uppercase tracking-[0.12em]", index === 0 ? "opacity-95" : "opacity-70")}>{index === 0 ? "Best" : card.kind}</span>
            {/* perforation */}
            <span className="sw-perf absolute -right-[5px] inset-y-0 w-[10px]" aria-hidden />
          </motion.div>
          <div className="min-w-0 px-4 pb-3.5 pt-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-signal-ink">{type}</span>
                  {cuisine ? <CuisineChip {...cuisine} /> : null}
                  {vibe ? <VibeChip {...vibe} /> : null}
                </p>
                <motion.h3 layoutId={`name-${card.id}`} className="text-[18.5px] font-bold leading-[1.15] tracking-[-0.02em] text-ink">{card.name}</motion.h3>
                {area || address ? <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{area || address}</p> : null}
                {blurb ? (
                  <div className="mt-1.5 flex flex-col items-start gap-1">
                    {blurb.bestFor ? <BestFor text={blurb.bestFor} /> : null}
                    <p className="line-clamp-1 text-[13px] leading-5 text-ink-2" title={blurb.text}>{blurb.text}</p>
                  </div>
                ) : blurbPending && index < 3 ? (
                  <BlurbShimmer className="mt-2" />
                ) : null}
              </div>
              <PhotoThumb card={card} className="size-[60px] transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:scale-[1.03]" />
            </div>

            <ul className="mt-2.5 flex flex-col gap-1.5">
              {card.legs.map((l, k) => (
                <li key={l.who + k} className="flex min-w-0 items-center gap-2 text-[13px] text-ink-2">
                  <span className="size-2 shrink-0 rounded-full" style={{ background: ROUTE[l.who] }} aria-hidden />
                  <span className="num shrink-0 font-semibold text-ink">
                    {card.legs.length > 1 ? `${WHO[l.who]} · ` : ""}
                    {l.minutes} min
                  </span>
                  <JourneyCompact leg={l} className="min-w-0 flex-1" />
                </li>
              ))}
            </ul>

            <ul className="mt-2.5 flex flex-col gap-1">
              {answers.map((a) => (
                <li key={a.key} className={cn("flex items-center gap-2 text-[13px] leading-5 text-ink", a.wx && "-mx-1.5 rounded-[8px] bg-raised px-1.5 py-0.5")}>
                  {a.wx ? <WeatherIcon fact={a.wx} className="-ml-0.5 size-[18px]" /> : <a.icon className={cn("size-3.5 shrink-0", a.tone)} aria-hidden />}
                  <span className={cn("min-w-0 truncate font-medium", a.dim && "text-ink-3", a.key === "open" && a.tone === "text-amber-ink" && "text-amber-ink")}>
                    {a.text}
                    {a.sub ? <span className="num font-normal text-ink-3"> · {a.sub}</span> : null}
                  </span>
                  {a.v ? <span title={a.v} className={cn("ml-auto size-1.5 shrink-0 rounded-full", V_DOT[a.v])} aria-label={a.v} /> : null}
                </li>
              ))}
            </ul>

            <div className="mt-3 flex items-center gap-2 border-t border-dashed border-line pt-2.5">
              <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-ink-3" aria-label="Verdict tally">
                {tally.map(([v, n]) => (
                  <span key={v} title={`${n} ${v}`} className="num inline-flex items-center gap-1 whitespace-nowrap font-mono">
                    <span aria-hidden className={cn("size-1.5 rounded-full", V_DOT[v])} />{n}
                  </span>
                ))}
                <span className="whitespace-nowrap">checks</span>
              </span>
              <span className="ml-auto inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[12px] font-semibold text-ink transition-colors duration-200 group-hover:bg-signal-soft group-hover:text-signal-ink">All details</span>
            </div>
          </div>
        </div>
      </button>
    </motion.article>
  );
}

/** server16: set only when the venue came from MongoDB Atlas vector similarity (plan-types.ts unchanged). */
export function vibeOf(card: Card): { terms: string[]; source: string } | null {
  const v = (card as Card & { vibe?: { terms?: unknown; source?: unknown } }).vibe;
  return v && Array.isArray(v.terms) && v.terms.length && typeof v.source === "string" ? { terms: v.terms.map(String), source: v.source } : null;
}

/** "Vibe match" chip: frosted orange, the matched words + source on hover. */
export function VibeChip({ terms, source }: { terms: string[]; source: string }) {
  return (
    <span
      title={`Vibe match: ${terms.join(", ")} · ${source}`}
      aria-label={`Vibe match: ${terms.join(", ")}`}
      className="inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full bg-signal/12 px-1.5 text-[11px] font-semibold leading-none text-signal-ink ring-1 ring-signal/30 backdrop-blur-md"
    >
      <Sparkles className="size-2.5" aria-hidden />
      Vibe match
    </span>
  );
}

/** Small cuisine chip ("Italian"); dashed when the server only infers it from the name. */
export function CuisineChip({ text, likely }: { text: string; likely?: boolean }) {
  return (
    <span
      title={likely ? `${text}, going by the name` : `${text} (OSM cuisine tag)`}
      className={cn("inline-flex h-[18px] shrink-0 items-center rounded-full px-1.5 text-[11px] font-semibold leading-none", likely ? "border border-dashed border-signal/45 text-signal-ink" : "bg-signal-soft text-signal-ink ring-1 ring-signal/20")}
    >
      {text}
    </span>
  );
}
