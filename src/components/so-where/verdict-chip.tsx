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

export function VerdictChip({ verdict, delay = 0, title, className, size = "md" }: { verdict: Verdict; delay?: number; title?: string; className?: string; size?: "sm" | "md" }) {
  const m = META[verdict] ?? META.unknown;
  return (
    <motion.span
      initial={{ opacity: 0, scale: 0.7 }}
      animate={{ opacity: 1, scale: 1 }}
      whileHover={{ scale: 1.06, y: -1 }}
      transition={{ type: "spring", stiffness: 520, damping: 24, delay }}
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center rounded-full font-semibold leading-none",
        size === "sm" ? "h-[18px] gap-0.5 pl-1 pr-1.5 text-[10.5px]" : "h-6 gap-1 pl-1.5 pr-2 text-[12px]",
        m.cls,
        className
      )}
    >
      <m.Icon aria-hidden className={size === "sm" ? "size-2.5" : "size-3.5"} strokeWidth={2.6} />
      {m.label}
    </motion.span>
  );
}
