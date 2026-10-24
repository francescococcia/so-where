"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Minus, X } from "lucide-react";
import type { AgentStep } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { fmtSeconds } from "./format";

const ease = [0.22, 1, 0.36, 1] as const;

function Node({ status }: { status: AgentStep["status"] }) {
  return (
    <span className="relative z-[1] grid size-6 shrink-0 place-items-center" aria-hidden>
      <AnimatePresence mode="popLayout" initial={false}>
        {status === "running" ? (
          <motion.span key="run" className="relative grid size-6 place-items-center rounded-full bg-sky shadow-e2" exit={{ opacity: 0, scale: 0.4 }}>
            <span className="absolute inset-0 animate-ping rounded-full bg-sky/40 motion-reduce:hidden" />
            <motion.span className="block size-3.5 rounded-full border-2 border-white/35 border-t-white" animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.7, ease: "linear" }} />
          </motion.span>
        ) : status === "done" ? (
          <motion.span key="done" initial={{ scale: 0.2, rotate: -90 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: "spring", stiffness: 600, damping: 20 }} className="grid size-6 place-items-center rounded-full bg-ok text-white">
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        ) : status === "failed" ? (
          <motion.span key="fail" initial={{ scale: 0.2 }} animate={{ scale: [1.3, 1] }} transition={{ duration: 0.35 }} className="grid size-6 place-items-center rounded-full bg-err text-white">
            <X className="size-3.5" strokeWidth={3} />
          </motion.span>
        ) : (
          <motion.span key="skip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid size-6 place-items-center rounded-full bg-sunk text-unknown">
            <Minus className="size-3.5" strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function Timeline({ steps }: { steps: AgentStep[] }) {
  const doneN = steps.filter((s) => s.status !== "running").length;
  const pct = steps.length ? doneN / steps.length : 0;
  return (
    <ol className="relative flex flex-col">
      {/* rail */}
      <span className="absolute bottom-3 left-[11px] top-3 w-0.5 rounded-full bg-line" aria-hidden />
      <motion.span className="absolute left-[11px] top-3 w-0.5 origin-top rounded-full bg-sky" style={{ height: "calc(100% - 24px)" }} initial={{ scaleY: 0 }} animate={{ scaleY: pct }} transition={{ duration: 0.5, ease }} aria-hidden />
      <AnimatePresence initial={false}>
        {steps.map((s) => (
          <motion.li key={s.id} layout="position" initial={{ opacity: 0, x: -14, filter: "blur(4px)" }} animate={{ opacity: 1, x: 0, filter: "blur(0px)" }} transition={{ duration: 0.35, ease }} className="flex items-start gap-3 py-1.5">
            <Node status={s.status} />
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className={cn("text-[13.5px] font-semibold leading-5", s.status === "running" ? "sw-shimmer text-ink" : s.status === "failed" ? "text-err" : "text-ink")}>{s.label}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {s.source && s.source !== "—" ? <span className="rounded-md bg-sky-wash px-1.5 ring-1 ring-sky/15 py-px font-mono text-[10px] font-medium text-sky-ink">{s.source}</span> : null}
                  {s.ms != null && s.status !== "running" ? <span className="num font-mono text-[10px] text-ink-3">{s.ms} ms</span> : null}
                </span>
              </div>
              <AnimatePresence initial={false}>
                {s.detail ? (
                  <motion.p key={s.detail} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} transition={{ duration: 0.3, ease }} className="overflow-hidden text-[12.5px] leading-[18px] text-ink-3">
                    {s.detail}
                  </motion.p>
                ) : null}
              </AnimatePresence>
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

function Ticker({ running }: { running: boolean }) {
  const [t0] = useState(() => performance.now());
  const [ms, setMs] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setMs(performance.now() - t0), 100);
    return () => clearInterval(id);
  }, [running, t0]);
  return <span className="num font-mono">{(ms / 1000).toFixed(1)} s</span>;
}

/** The agent at work: a live timeline while it runs, a compact replayable strip once done. */
/** `quiet`: the finished strip placed after the results, smaller and muted (provenance, not news). */
export function AgentSteps({ steps, finished, elapsedMs, quiet = false }: { steps: AgentStep[]; finished: boolean; elapsedMs: number; quiet?: boolean }) {
  const [open, setOpen] = useState(!finished);
  useEffect(() => setOpen(!finished), [finished]);
  if (!steps.length) return null;

  const checks = steps.filter((s) => s.status !== "running").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const ms = elapsedMs || steps.reduce((a, s) => a + (s.ms ?? 0), 0);

  return (
    <motion.section layout aria-label="What the planner checked" aria-live="polite" className={cn("overflow-hidden transition-shadow duration-300", quiet ? "rounded-[12px] ring-1 ring-line/50" : "rounded-[16px]", !quiet && (finished ? "bg-white/60 shadow-e1 ring-1 ring-line/70" : "bg-white/80 shadow-e3 ring-1 ring-signal/30"))}>
      {finished ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={cn("flex w-full cursor-pointer items-center text-left transition-colors", quiet ? "min-h-9 gap-2 px-3 text-[12px] text-ink-3 max-lg:min-h-11" : "min-h-11 gap-2.5 px-3.5 text-[13px] text-ink-2", "duration-200 hover:bg-sky-wash hover:text-ink focus-visible:outline-offset-[-2px] active:bg-sky-soft")}>
          <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
            {steps.map((s, k) => (
              <motion.span key={s.id} initial={{ scaleY: 0 }} animate={{ scaleY: 1 }} transition={{ delay: k * 0.04 }} className={cn(quiet ? "h-2.5 w-1" : "h-3.5 w-1.5", "rounded-full", s.status === "done" ? "bg-ok" : s.status === "failed" ? "bg-err" : "bg-control")} />
            ))}
          </span>
          <span className={cn("num min-w-0 truncate whitespace-nowrap", quiet ? "font-medium text-ink-3" : "font-semibold text-ink")}>
            {checks} checks · {fmtSeconds(ms)}
            {failed ? <span className="font-medium text-ink-3"> · {failed} couldn&apos;t</span> : null}
          </span>
          <span className={cn("ml-auto shrink-0 whitespace-nowrap font-medium text-ink-3", quiet ? "text-[11.5px]" : "text-[12px]")}>{open ? "Hide" : "How we got here"}</span>
          <ChevronDown className={cn(quiet ? "size-3.5" : "size-4", "transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </button>
      ) : (
        <div className="flex items-center gap-2 border-b border-sky/15 bg-sky-wash px-3.5 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-sky-ink">
          <span className="relative flex size-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-sky opacity-60 motion-reduce:hidden" />
            <span className="relative size-2 rounded-full bg-sky" />
          </span>
          Agent working
          <span className="ml-auto text-sky-ink/80"><Ticker running={!finished} /></span>
        </div>
      )}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div key="rows" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease }} className="overflow-hidden">
            <div className="px-3.5 pb-3 pt-2">
              <Timeline steps={steps} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.section>
  );
}
