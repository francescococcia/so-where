"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, ChevronDown, Minus, X } from "lucide-react";
import type { AgentStep } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { fmtSeconds } from "./format";

function StepIcon({ status }: { status: AgentStep["status"] }) {
  return (
    <span className="relative grid size-5 shrink-0 place-items-center" aria-hidden>
      <AnimatePresence mode="popLayout" initial={false}>
        {status === "running" ? (
          <motion.span key="run" className="block size-4 rounded-full border-2 border-control border-t-ink" animate={{ rotate: 360 }} exit={{ opacity: 0, scale: 0.5 }} transition={{ rotate: { repeat: Infinity, duration: 0.8, ease: "linear" } }} />
        ) : status === "done" ? (
          <motion.span key="done" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 600, damping: 22 }} className="grid size-5 place-items-center rounded-full bg-ok-bg text-ok">
            <Check className="size-3" strokeWidth={3} />
          </motion.span>
        ) : status === "failed" ? (
          <motion.span key="fail" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 600, damping: 22 }} className="grid size-5 place-items-center rounded-full bg-signal-soft text-signal-ink">
            <X className="size-3" strokeWidth={3} />
          </motion.span>
        ) : (
          <motion.span key="skip" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="grid size-5 place-items-center rounded-full bg-unknown-bg text-unknown">
            <Minus className="size-3" strokeWidth={3} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

function Rows({ steps }: { steps: AgentStep[] }) {
  return (
    <ol className="flex flex-col">
      <AnimatePresence initial={false}>
        {steps.map((s) => (
          <motion.li
            key={s.id}
            layout="position"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="flex items-start gap-2.5 py-1.5"
          >
            <StepIcon status={s.status} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className={cn("text-[13.5px] font-medium leading-5", s.status === "running" ? "text-ink" : "text-ink-2")}>{s.label}</span>
                {s.source && s.source !== "—" ? <span className="shrink-0 font-mono text-[11px] text-ink-3">{s.source}</span> : null}
              </div>
              {s.detail ? <p className="text-[12.5px] leading-[18px] text-ink-3">{s.detail}</p> : null}
            </div>
          </motion.li>
        ))}
      </AnimatePresence>
    </ol>
  );
}

/** Live rows while the planner runs; a one-line summary once it's done. */
export function AgentSteps({ steps, finished, elapsedMs }: { steps: AgentStep[]; finished: boolean; elapsedMs: number }) {
  const [open, setOpen] = useState(!finished);
  useEffect(() => setOpen(!finished), [finished]);
  if (!steps.length) return null;

  const checks = steps.filter((s) => s.status !== "running").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const ms = elapsedMs || steps.reduce((a, s) => a + (s.ms ?? 0), 0);

  return (
    <section aria-label="What the planner checked" aria-live="polite" className="rounded-[14px] border border-line bg-raised">
      {finished ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-h-11 w-full cursor-pointer items-center gap-2 px-3.5 text-left text-[13px] text-ink-2 transition-colors hover:text-ink">
          <span className="grid size-5 place-items-center rounded-full bg-ok-bg text-ok"><Check className="size-3" strokeWidth={3} /></span>
          <span className="num font-medium">
            {checks} checks · {fmtSeconds(ms)}
            {failed ? <span className="text-ink-3"> · {failed} couldn&apos;t</span> : null}
          </span>
          <ChevronDown className={cn("ml-auto size-4 transition-transform duration-200", open && "rotate-180")} aria-hidden />
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3.5 pt-3 text-[12px] font-semibold uppercase tracking-[0.06em] text-ink-3">
          <span className="relative flex size-2">
            <span className="absolute inset-0 animate-ping rounded-full bg-signal opacity-60 motion-reduce:hidden" />
            <span className="relative size-2 rounded-full bg-signal" />
          </span>
          Checking
        </div>
      )}
      <AnimatePresence initial={false}>
        {open ? (
          <motion.div key="rows" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            <div className="px-3.5 pb-2.5 pt-1">
              <Rows steps={steps} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
