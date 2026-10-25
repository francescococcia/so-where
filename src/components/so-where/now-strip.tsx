"use client";
// "Right now" strip on the empty home screen: live line status, London weather and today's listed events, from
// GET /api/now. Real data only. A part that is missing or fails is simply not shown; nothing is filled in.
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { CalendarDays, CloudRain, CloudSun, Sun, TrainFront } from "lucide-react";
import { cn } from "@/lib/utils";

type Now = {
  lines: { ok: boolean; disrupted: { name: string; status: string }[]; total: number; via: string; asOf: string } | null;
  weather: { tempC: number; sky: string | null; rainPct: number | null; asOf: string } | null;
  events: { count: number; walkIn: number; source: string; asOf: string } | null;
};

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/London" });
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Europe/London" });

export default function NowStrip({ onPick }: { onPick: (ask: string) => void }) {
  const [now, setNow] = useState<Now | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => ctl.abort(), 6000);
    fetch("/api/now", { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Now | null) => d && setNow(d))
      .catch(() => {})
      .finally(() => window.clearTimeout(t));
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
  }, []);
  if (!now) return null;

  const cards: { id: string; Icon: typeof Sun; title: string; sub: string; ask: string; them?: boolean }[] = [];
  const l = now.lines;
  if (l) {
    const first = l.disrupted[0];
    cards.push({
      id: "lines",
      Icon: TrainFront,
      title: first ? `${first.name}: ${first.status.toLowerCase()}${l.disrupted.length > 1 ? ` · +${l.disrupted.length - 1} more` : ""}` : "Good service on all lines",
      sub: `live · ${l.via === "atlas-stream-processing" ? "Atlas stream" : "TfL"} · ${hhmm(l.asOf)}`,
      ask: "Friday at 7. I'm at Old Street, my friend is in Brixton. A pub halfway.",
      them: true,
    });
  }
  const w = now.weather;
  if (w) {
    const wet = (w.rainPct ?? 0) >= 50;
    cards.push({
      id: "weather",
      Icon: wet ? CloudRain : /clear/.test(w.sky ?? "") ? Sun : CloudSun,
      title: `${w.tempC}°C${w.sky ? ` · ${w.sky}` : ""}${w.rainPct != null && w.rainPct >= 30 ? ` · ${w.rainPct}% rain` : ""}`,
      sub: "London now · Open-Meteo",
      ask: wet ? "Tonight at 7. I'm at Old Street, my friend is in Brixton. A cosy pub halfway." : "Tonight at 7. I'm at Old Street, my friend is in Brixton. A pub with a beer garden halfway.",
    });
  }
  const e = now.events;
  if (e && e.count > 0) {
    cards.push({
      id: "events",
      Icon: CalendarDays,
      title: `${e.count} listed event${e.count === 1 ? "" : "s"} today`,
      sub: `${e.source.replace(/ seed\b/g, " listings")} · as of ${day(e.asOf)}`, // "seed" is jargon on camera
      ask: "What's on near me today?",
    });
  }
  if (!cards.length) return null;

  return (
    <section aria-label="Right now in London" className="mt-5">
      <p className="mb-2 flex items-center gap-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[.14em] text-ink-3">
        <span className="relative inline-flex size-1.5">
          <span className="absolute inset-0 animate-ping rounded-full bg-signal/60 motion-reduce:hidden" />
          <span className="relative size-1.5 rounded-full bg-signal" />
        </span>
        Right now in London
      </p>
      <div className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] lg:mx-0 lg:grid lg:grid-cols-1 lg:overflow-visible lg:px-0">
        {cards.map((c, i) => (
          <motion.button
            key={c.id}
            type="button"
            onClick={() => onPick(c.ask)}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.06, duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            title="Use this as a starting ask"
            className="sw-now-card group flex min-w-[220px] shrink-0 snap-start items-center gap-3 rounded-[16px] px-3 py-2.5 text-left lg:min-w-0"
          >
            <span className={cn("grid size-9 shrink-0 place-items-center rounded-[11px]", c.them ? "bg-[#1478a3]/10 text-[#1478a3]" : "bg-signal-soft text-signal-ink")}>
              <c.Icon className="size-[18px]" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13.5px] font-semibold leading-5 text-ink">{c.title}</span>
              <span className="block truncate font-mono text-[10.5px] leading-4 text-ink-3">{c.sub}</span>
            </span>
          </motion.button>
        ))}
      </div>
    </section>
  );
}
