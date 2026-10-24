"use client";

import { motion } from "motion/react";
import { Check, CloudSun, HelpCircle, Waves } from "lucide-react";
import type { Verdict } from "@/lib/plan-types";
import { cn } from "@/lib/utils";

const META: Record<Verdict, { label: string; cls: string; Icon: typeof Check }> = {
  confirmed: { label: "Confirmed", cls: "bg-ok-bg text-ok", Icon: Check },
  likely: { label: "Likely", cls: "bg-likely-bg text-likely", Icon: Waves },
  unknown: { label: "Unknown", cls: "bg-unknown-bg text-unknown", Icon: HelpCircle },
  forecast: { label: "Forecast", cls: "bg-fc-bg text-fc", Icon: CloudSun },
};

export function VerdictChip({ verdict, delay = 0, title, className }: { verdict: Verdict; delay?: number; title?: string; className?: string }) {
  const m = META[verdict] ?? META.unknown;
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.06, y: -1 }}
      transition={{ type: "spring", stiffness: 520, damping: 24, delay }}
      title={title}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full pl-1.5 pr-2 text-[12px] font-semibold leading-none",
        m.cls,
        className
      )}
    >
      <m.Icon aria-hidden className="size-3.5" strokeWidth={2.4} />
      {m.label}
    </motion.span>
  );
}
