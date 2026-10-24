"use client";

import { motion } from "motion/react";
import { Clock, MapPin, PiggyBank, Shuffle, Sparkles, Volume1 } from "lucide-react";
import type { Intent } from "@/lib/plan-types";

const MEET = [
  { label: "Cheaper", Icon: PiggyBank, ask: "somewhere cheaper" },
  { label: "Closer to me", Icon: MapPin, ask: "closer to me, I don't mind them travelling a bit more" },
  { label: "Quieter", Icon: Volume1, ask: "somewhere quieter where we can talk" },
  { label: "Later time", Icon: Clock, ask: "an hour later" },
  { label: "Another area", Icon: Shuffle, ask: "a different area from last time" },
];
const NEAR = [
  { label: "Free only", Icon: PiggyBank, ask: "free only" },
  { label: "Closer", Icon: MapPin, ask: "within 15 minutes" },
  { label: "Quieter", Icon: Volume1, ask: "somewhere quieter" },
  { label: "Later time", Icon: Clock, ask: "two hours later" },
  { label: "Something else", Icon: Shuffle, ask: "something different" },
];

/** Steer the agent after a result: each chip re-asks /api/plan with a natural-language refinement. */
export function FollowUps({ intent, onRefine, disabled }: { intent: Intent; onRefine: (extra: string) => void; disabled?: boolean }) {
  const items = intent === "near_me" ? NEAR : MEET;
  return (
    <section aria-label="Refine the plan" className="rounded-[16px] bg-sky-wash p-3 ring-1 ring-sky/15">
      <p className="flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">
        <Sparkles className="size-3.5 text-sky" aria-hidden /> <span className="text-sky-ink">Steer the agent</span>
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.map((it, i) => (
          <motion.button
            key={it.label}
            type="button"
            disabled={disabled}
            initial={{ opacity: 0, y: 8, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ delay: 0.6 + i * 0.05, type: "spring", stiffness: 420, damping: 24 }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.93 }}
            onClick={() => onRefine(it.ask)}
            className="sw-chip group min-h-9 px-3 text-[13px] font-semibold text-ink hover:bg-signal-soft hover:text-signal-ink max-lg:min-h-11 transition-[box-shadow,background-color,color]"
          >
            <it.Icon className="size-3.5 text-signal transition-transform duration-200 group-hover:scale-110 group-active:scale-90" aria-hidden />
            {it.label}
          </motion.button>
        ))}
      </div>
    </section>
  );
}
