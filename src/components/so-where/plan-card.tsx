"use client";

import { motion } from "motion/react";
import { ArrowUpRight, Footprints } from "lucide-react";
import type { Fact, PlanCard as Card, Verdict } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { CountUp, useTilt } from "./motion-bits";

export const WHO = { you: "You", them: "Them" } as const;
export const ROUTE = { you: "var(--sw-route-you)", them: "var(--sw-route-them)" } as const;
const V_DOT: Record<Verdict, string> = { confirmed: "bg-ok", likely: "bg-[#c99a00]", forecast: "bg-fc", unknown: "bg-control" };
const V_TXT: Record<Verdict, string> = { confirmed: "text-ok", likely: "text-likely", forecast: "text-fc", unknown: "text-unknown" };

export function splitSubtitle(s: string) {
  const [type, ...rest] = s.split(" · ");
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
  selected,
  hovered,
  onOpen,
  onHover,
}: {
  card: Card;
  index: number;
  selected: boolean;
  hovered: boolean;
  onOpen: () => void;
  onHover: (on: boolean) => void;
}) {
  const tilt = useTilt(4);
  const { type, address } = splitSubtitle(card.subtitle);
  const facts = keyFacts(card);
  const walk = card.legs.length === 1 ? card.legs[0] : null;
  const tally = (["confirmed", "likely", "forecast", "unknown"] as Verdict[]).map((v) => [v, card.facts.filter((f) => f.verdict === v).length] as const).filter(([, n]) => n);

  return (
    <motion.article
      layoutId={`place-${card.id}`}
      initial={{ opacity: 0, y: 26, rotateX: -8 }}
      animate={{ opacity: 1, y: 0, rotateX: 0 }}
      transition={{ type: "spring", stiffness: 260, damping: 26, delay: 0.25 + 0.09 * index }}
      whileHover={{ y: -3 }}
      style={tilt.style}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={() => {
        tilt.onPointerLeave();
        onHover(false);
      }}
      onPointerEnter={() => onHover(true)}
      className={cn(
        "sw-card group relative overflow-hidden rounded-[18px] bg-surface [transform-style:preserve-3d]",
        selected ? "ring-2 ring-ink" : hovered ? "ring-2 ring-signal/60" : "ring-1 ring-line"
      )}
    >
      <button type="button" onClick={onOpen} onFocus={() => onHover(true)} onBlur={() => onHover(false)} aria-label={`Open details for ${card.name}`} className="block w-full cursor-pointer text-left">
        {/* ticket stub */}
        <div className="grid grid-cols-[64px_1fr]">
          <motion.div layoutId={`rank-${card.id}`} className={cn("relative flex flex-col items-center justify-between py-3.5 font-mono", index === 0 ? "bg-signal text-white" : "bg-ink text-white")}>
            <span className="text-[10px] font-semibold uppercase tracking-[0.16em] opacity-70">No.</span>
            <span className="num text-[30px] font-bold leading-none tracking-[-0.04em]">{String(index + 1).padStart(2, "0")}</span>
            <span className="text-[9.5px] font-semibold uppercase tracking-[0.12em] opacity-70">{index === 0 ? "Best" : card.kind}</span>
            {/* perforation */}
            <span className="sw-perf absolute -right-[5px] inset-y-0 w-[10px]" aria-hidden />
          </motion.div>
          <div className="min-w-0 px-4 pb-3.5 pt-3">
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-[10.5px] font-semibold uppercase tracking-[0.12em] text-signal-ink">{type}</p>
                <motion.h3 layoutId={`name-${card.id}`} className="text-[18.5px] font-bold leading-[1.15] tracking-[-0.02em] text-ink">{card.name}</motion.h3>
                {address ? <p className="mt-0.5 truncate text-[12.5px] text-ink-3">{address}</p> : null}
              </div>
              <ArrowUpRight className="mt-1 size-5 shrink-0 text-ink-3 transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-ink" aria-hidden />
            </div>

            <div className="mt-3">
              {walk ? (
                <div className="flex items-center gap-2 text-[13px] text-ink-2">
                  <Footprints className="size-4 text-ink" aria-hidden />
                  <span className="num font-mono text-[15px] font-semibold text-ink"><CountUp value={walk.minutes} delay={0.3 + index * 0.09} /> min</span>
                  <span className="truncate text-ink-3">{walk.summary}</span>
                </div>
              ) : (
                <MiniBars card={card} delay={0.25 + index * 0.09} />
              )}
            </div>

            <ul className="mt-3 flex flex-col gap-1">
              {facts.map((f) => (
                <li key={f.label} className="flex items-center gap-2 text-[12.5px] leading-5">
                  <span className={cn("size-1.5 shrink-0 rounded-full", V_DOT[f.verdict])} aria-hidden />
                  <span className="shrink-0 text-ink-3">{f.label}</span>
                  <span className="min-w-0 truncate font-medium text-ink">{f.value}</span>
                  <span className={cn("ml-auto shrink-0 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]", V_TXT[f.verdict])}>{f.verdict}</span>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex items-center gap-2 border-t border-dashed border-line pt-2.5">
              <span className="flex items-center gap-1" aria-label="Verdict tally">
                {tally.map(([v, n]) => (
                  <span key={v} title={`${n} ${v}`} className={cn("num inline-flex h-5 items-center gap-1 rounded-full px-1.5 font-mono text-[10.5px] font-semibold", { confirmed: "bg-ok-bg text-ok", likely: "bg-likely-bg text-likely", forecast: "bg-fc-bg text-fc", unknown: "bg-unknown-bg text-unknown" }[v])}>
                    {n} {v.slice(0, 4)}
                  </span>
                ))}
              </span>
              <span className="ml-auto text-[12px] font-semibold text-ink transition-colors group-hover:text-signal-ink">All details</span>
            </div>
          </div>
        </div>
      </button>
    </motion.article>
  );
}
