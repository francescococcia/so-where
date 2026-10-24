"use client";

import type { PlanCard as Card } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import type { Blurb } from "./use-plan";

/** Never show template placeholders ("[their area]") or the separators they leave behind. */
export function noPlaceholder(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/\[[^\]]*\]?/g, "")
    .replace(/\s*·\s*(?=·|$)/g, "")
    .replace(/^\s*·\s*/, "")
    .replace(/\b(?:from|near|in|at)\s+(?=[,.)]|$)/gi, "")
    .replace(/\s+([,.)])/g, "$1")
    .replace(/,\s*(?=[,.])/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The venue's own area ("South Bank · near Waterloo"), server4 `card.area`; "" when absent. */
export const cardArea = (c: Card) => noPlaceholder((c as Card & { area?: string | null }).area ?? "");

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** "Best for a cosy date": orange tint (our take on the reference's green pill). */
export function BestFor({ text, className }: { text: string; className?: string }) {
  return <span className={cn("inline-flex min-h-[22px] max-w-full items-center rounded-full bg-signal-soft px-2.5 text-[12px] font-semibold leading-4 text-signal-ink ring-1 ring-signal/20", className)}>{text}</span>;
}

/** Small source pill: initial "favicon" + hostname, linked to the page the description came from. */
export function SourcePill({ source, className }: { source: Blurb["source"]; className?: string }) {
  const h = host(source.url) || source.name;
  const initial = (source.name || h).trim().charAt(0).toUpperCase();
  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      title={`Source: ${source.name}`}
      className={cn("inline-flex h-[22px] max-w-[200px] items-center gap-1.5 rounded-full bg-white/80 pl-[3px] pr-2 align-[2px] text-[11.5px] font-medium leading-none text-ink-2 no-underline ring-1 ring-line transition-colors hover:bg-white hover:text-ink", className)}
    >
      <span aria-hidden className="grid size-4 shrink-0 place-items-center rounded-full bg-ink text-[9.5px] font-bold text-white">{initial}</span>
      <span className="truncate">{h}</span>
    </a>
  );
}

/** Placeholder lines while blurbs are on their way (≤ 3 s). */
export function BlurbShimmer({ lines = 1, className }: { lines?: number; className?: string }) {
  return (
    <span aria-hidden className={cn("flex flex-col gap-1.5", className)}>
      <span className="sw-skel block h-[18px] w-[46%] rounded-full" />
      {Array.from({ length: lines }, (_, i) => <span key={i} className={cn("sw-skel block h-3 rounded-full", i === lines - 1 ? "w-[78%]" : "w-full")} />)}
    </span>
  );
}

/** Optional server field on refine answers ("when should I leave?"). Read defensively; plan-types.ts stays unchanged. */
export type LeaveBy = { you?: string; them?: string; arriveBy: string; date?: string };
const clock = (v: unknown): string => {
  if (typeof v !== "string" || !v.trim()) return "";
  if (/T\d{2}:\d{2}/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
  }
  return v.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/)?.[0] ?? "";
};
export function leaveByOf(r: unknown): LeaveBy | null {
  const lb = (r as { leaveBy?: unknown } | null)?.leaveBy as Record<string, unknown> | undefined;
  if (!lb || typeof lb !== "object") return null;
  const arriveBy = clock(lb.arriveBy);
  const you = clock(lb.you);
  const them = clock(lb.them);
  if (!arriveBy || (!you && !them)) return null;
  return { arriveBy, ...(you ? { you } : {}), ...(them ? { them } : {}), ...(typeof lb.date === "string" ? { date: lb.date } : {}) };
}

/** "Leave by 11:14 → arrive 12:00" (+ "them 11:20" for a halfway plan). Orange for you, sky for them. */
export function LeaveByChip({ lb, className }: { lb: LeaveBy; className?: string }) {
  return (
    <span className={cn("num inline-flex min-h-7 flex-wrap items-center gap-x-1.5 rounded-full bg-signal-soft px-2.5 py-1 text-[12.5px] font-semibold leading-4 text-signal-ink ring-1 ring-signal/25", className)}>
      {lb.you ? <span>Leave by {lb.you}</span> : null}
      {lb.them ? <span className="text-[#1478a3]">{lb.you ? "· them " : "They leave by "}{lb.them}</span> : null}
      <span aria-hidden>→</span>
      <span className="sr-only">to</span>
      <span>arrive {lb.arriveBy}</span>
    </span>
  );
}
