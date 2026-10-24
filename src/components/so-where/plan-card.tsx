"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Footprints, Navigation } from "lucide-react";
import type { PlanCard as Card, Verdict } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { VerdictChip } from "./verdict-chip";
import { fmtAsOf, gmapsDirections } from "./format";

const WHO = { you: "You", them: "Them" } as const;
const ROUTE = { you: "var(--sw-route-you)", them: "var(--sw-route-them)" } as const;

function FairnessBars({ card }: { card: Card }) {
  const max = Math.max(30, ...card.legs.map((l) => l.minutes));
  return (
    <div className="flex flex-col gap-1.5">
      {card.legs.map((l, i) => (
        <div key={l.who + i} className="grid grid-cols-[44px_1fr_auto] items-center gap-2.5">
          <span className="text-[12.5px] font-medium text-ink-2">{WHO[l.who]}</span>
          <div className="relative h-2 overflow-hidden rounded-full bg-sunk">
            <motion.span
              className="absolute inset-y-0 left-0 rounded-full"
              style={{ background: ROUTE[l.who] }}
              initial={{ width: 0 }}
              animate={{ width: `${(l.minutes / max) * 100}%` }}
              transition={{ duration: 0.7, delay: 0.15 + i * 0.12, ease: [0.22, 1, 0.36, 1] }}
            />
          </div>
          <span className="num font-mono text-[13px] font-medium text-ink">{l.minutes} min</span>
        </div>
      ))}
    </div>
  );
}

function verdictTally(card: Card) {
  const order: Verdict[] = ["confirmed", "likely", "forecast", "unknown"];
  return order.map((v) => [v, card.facts.filter((f) => f.verdict === v).length] as const).filter(([, n]) => n > 0);
}

export function PlanCard({ card, index, selected, onSelect }: { card: Card; index: number; selected: boolean; onSelect: () => void }) {
  const leg = card.legs.find((l) => l.who === "you") ?? card.legs[0];
  const twoWay = card.legs.length > 1;

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32, delay: 0.06 * index, ease: [0.22, 1, 0.36, 1], layout: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } }}
      className={cn(
        "rounded-[14px] border bg-surface transition-colors duration-200",
        selected ? "border-ink shadow-[0_0_0_1px_var(--sw-ink)]" : "border-line hover:border-control"
      )}
    >
      <button type="button" onClick={onSelect} aria-expanded={selected} className="flex w-full cursor-pointer items-start gap-3 p-4 pb-3 text-left">
        <span className={cn("num mt-0.5 grid size-7 shrink-0 place-items-center rounded-full font-mono text-[13px] font-semibold text-white transition-colors", selected ? "bg-ink" : "bg-signal")}>
          {index + 1}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[17px] font-semibold leading-6 tracking-[-0.01em] text-ink">{card.name}</span>
          <span className="block text-[13px] leading-5 text-ink-3">{card.subtitle}</span>
          {!twoWay && leg ? (
            <span className="mt-1 flex items-center gap-1.5 text-[13px] text-ink-2">
              <Footprints className="size-3.5" aria-hidden />
              <span className="num font-mono font-medium text-ink">{leg.minutes} min</span>
              <span className="truncate">· {leg.summary}</span>
            </span>
          ) : null}
        </span>
        {!selected ? (
          <span className="mt-1 flex shrink-0 gap-1" aria-label="Verdicts">
            {verdictTally(card).map(([v, n]) => (
              <span key={v} className={cn("num grid h-5 min-w-5 place-items-center rounded-full px-1.5 font-mono text-[11px] font-semibold", { confirmed: "bg-ok-bg text-ok", likely: "bg-likely-bg text-likely", forecast: "bg-fc-bg text-fc", unknown: "bg-unknown-bg text-unknown" }[v])} title={`${n} ${v}`}>
                {n}
              </span>
            ))}
          </span>
        ) : null}
      </button>

      <AnimatePresence initial={false}>
        {selected ? (
          <motion.div key="body" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className="flex flex-col gap-3 px-4 pb-4">
              {twoWay ? (
                <div className="rounded-[10px] bg-raised p-3">
                  <FairnessBars card={card} />
                  <p className="mt-2 text-[12.5px] leading-[18px] text-ink-3">
                    {card.legs.map((l) => `${WHO[l.who]}: ${l.summary}`).join(" · ")}
                  </p>
                </div>
              ) : null}

              <dl className="flex flex-col divide-y divide-rule">
                {card.facts.map((f, i) => (
                  <div key={f.label + i} className="grid grid-cols-[92px_1fr_auto] items-start gap-x-3 py-2">
                    <dt className="pt-0.5 text-[12.5px] leading-5 text-ink-3">{f.label}</dt>
                    <dd className="min-w-0">
                      <span className="block text-[14px] leading-5 text-ink">{f.value}</span>
                      <span className="num block font-mono text-[11px] leading-4 text-ink-3">
                        {f.source}
                        {f.asOf ? ` · as of ${fmtAsOf(f.asOf)}` : ""}
                      </span>
                    </dd>
                    <VerdictChip verdict={f.verdict} delay={0.12 + i * 0.05} title={`${f.source}${f.asOf ? `, as of ${fmtAsOf(f.asOf)}` : ""}`} />
                  </div>
                ))}
              </dl>

              {card.why ? <p className="text-[13.5px] leading-5 text-ink-2">{card.why}</p> : null}

              <div className="flex gap-2">
                <a href={gmapsDirections(card.location.lat, card.location.lng)} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 cursor-pointer items-center gap-1.5 rounded-[10px] border border-line px-3.5 text-[14px] font-medium text-ink transition-colors hover:border-ink">
                  <Navigation className="size-4" aria-hidden /> Directions
                </a>
                {card.url ? (
                  <a href={card.url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 cursor-pointer items-center gap-1 rounded-[10px] px-3 text-[14px] font-medium text-ink-2 transition-colors hover:text-ink">
                    Website <ArrowUpRight className="size-4" aria-hidden />
                  </a>
                ) : null}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.article>
  );
}
