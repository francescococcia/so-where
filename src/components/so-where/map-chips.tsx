"use client";
// Glanceable map overlays: one weather chip, one transport chip. Sources and full text live in a tap/hover popover.
import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bus, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, Sun, TrainFront } from "lucide-react";
import type { Fact, PlanCard, PlanResult } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { fmtAsOf } from "./format";
import { lineHex, segmentsOf, type Segment } from "./journey";

type Level = "good" | "minor" | "severe";
const DOT: Record<Level, string> = { good: "bg-ok", minor: "bg-amber", severe: "bg-[#d4351c]" };

// ---------- weather ----------
export function readWeather(value: string) {
  const temp = value.match(/(-?\d{1,2})\s*°\s*C/i)?.[1];
  const pct = Number(value.match(/(\d{1,3})\s*%\s*(?:chance of\s*)?(?:rain|precip)/i)?.[1] ?? NaN);
  const words: [RegExp, string, typeof Sun][] = [
    [/thunder|storm/i, "Storms", CloudLightning],
    [/snow|sleet/i, "Snow", CloudSnow],
    [/heavy rain|\brain\b(?!\s*\d)(?!,)|showers?/i, "Rain", CloudRain],
    [/drizzle/i, "Drizzle", CloudDrizzle],
    [/fog|mist/i, "Fog", CloudFog],
    [/sunny|clear/i, "Sunny", Sun],
    [/overcast|cloudy|cloud/i, "Cloudy", Cloud],
  ];
  const hit = words.find(([re]) => re.test(value.replace(/\d+\s*%\s*(chance of\s*)?rain/i, "")));
  let cond = hit?.[1];
  let Icon = hit?.[2];
  if (!cond) {
    if (pct >= 50) [cond, Icon] = ["Rain likely", CloudRain];
    else if (pct >= 20) [cond, Icon] = ["Maybe showers", CloudSun];
    else if (Number.isFinite(pct)) [cond, Icon] = ["Dry", Sun];
    else [cond, Icon] = ["Forecast", CloudSun];
  }
  const wet = /Rain|Drizzle|Storms|Snow|showers/i.test(cond) || pct >= 50;
  const t = temp != null ? Number(temp) : NaN;
  const hint = wet ? "Indoor picks" : t >= 17 ? "Terrace weather" : t <= 7 ? "Wrap up" : "";
  return { temp: Number.isFinite(t) ? `${t}°C` : null, cond, Icon: Icon!, wet, hint };
}

// ---------- transport ----------
type LineStatus = { name: string; status: string; level: Level; bus: boolean; hex: string | null; detail?: string };

const norm = (s: string) => s.toLowerCase().replace(/\b(line|bus|route)\b/g, "").replace(/[^a-z0-9&]/g, "");

function parseStatus(facts: Fact[]): LineStatus[] {
  const out: LineStatus[] = [];
  for (const f of facts) {
    // Split on " · " outside brackets.
    const parts: string[] = [];
    let depth = 0, cur = "";
    for (let i = 0; i < f.value.length; i++) {
      const ch = f.value[i];
      if (ch === "(") depth++;
      if (ch === ")") depth = Math.max(0, depth - 1);
      if (depth === 0 && f.value.startsWith(" · ", i)) { parts.push(cur); cur = ""; i += 2; continue; }
      cur += ch;
    }
    parts.push(cur);
    for (const p of parts) {
      const m = p.match(/^\s*([^:]+?)\s*:\s*([^(]+?)\s*(?:\((.*)\))?\s*(?:·.*)?$/);
      if (!m) continue;
      const name = m[1].replace(/\s+line$/i, "").trim();
      const status = m[2].replace(/ now.*$/i, "").replace(/\s*,\s*as of.*$/i, "").trim();
      const level: Level = /good service|no issues|running well/i.test(status) ? "good" : /severe|closure|closed|suspend|no service/i.test(status) ? "severe" : "minor";
      const bus = /^\d+[a-z]?$/i.test(name) || /^n\d+$/i.test(name) || /^bus\b/i.test(name);
      const seg: Segment = { mode: bus ? "bus" : "tube", line: name };
      out.push({ name: bus ? name.replace(/^bus\s*/i, "") : name, status: status.replace(/^(\w)(.*)$/, (_, a, b) => a.toUpperCase() + b.toLowerCase()), level, bus, hex: lineHex(seg), detail: m[3] });
    }
  }
  return out;
}

function usedLines(cards: PlanCard[]) {
  const set = new Set<string>();
  for (const c of cards) for (const l of c.legs) for (const s of segmentsOf(l)) if (s.mode !== "walk" && s.line) set.add(norm(s.line));
  return set;
}

function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? "#15171c" : "#fff";
}

function LineBadge({ l }: { l: LineStatus }) {
  const hex = l.bus ? "#DC241F" : l.hex;
  return (
    <span className={cn("inline-flex h-[20px] items-center gap-1 rounded-[5px] px-1.5 text-[11.5px] font-bold leading-none", !hex && "bg-sky-soft text-sky-ink")} style={hex ? { background: hex, color: inkOn(hex) } : undefined}>
      {l.bus ? <Bus className="size-3" aria-hidden /> : <TrainFront className="size-3" aria-hidden />}
      {l.name}
    </span>
  );
}

// ---------- shared chip shell ----------
function Chip({ i, label, children, pop }: { i: number; label: string; children: React.ReactNode; pop: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <motion.div
      className="pointer-events-auto relative"
      initial={{ opacity: 0, y: -10, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.96 }}
      transition={{ delay: 0.6 + i * 0.08, type: "spring", stiffness: 380, damping: 26 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <motion.button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.97 }}
        className="sw-map-chip flex cursor-pointer items-center gap-2 rounded-[14px] py-1.5 pl-1.5 pr-3 text-left"
      >
        {children}
      </motion.button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="tooltip"
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ type: "spring", stiffness: 480, damping: 32 }}
            className="sw-map-chip absolute right-0 top-[calc(100%+6px)] z-40 w-[min(300px,80vw)] rounded-[14px] p-3 text-[12.5px] leading-[18px] text-ink-2"
          >
            {pop}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

const srcLine = (f: Fact) => `${f.source.split(" · ")[0]}${f.asOf ? ` · ${fmtAsOf(f.asOf)}` : ""}`;

export function MapChips({ result, cardId }: { result: PlanResult | null; cardId: string | null }) {
  if (!result) return null;
  const card = result.cards.find((c) => c.id === cardId) ?? result.cards[0];
  const facts = card?.facts ?? [];
  const wFact = facts.find((f) => /weather|forecast/i.test(f.label)) ?? null;
  const sFacts = facts.filter((f) => /train|line|status|tube|bus/i.test(f.label) && f.verdict !== "unknown");
  const all = parseStatus(sFacts);
  const used = usedLines(card ? [card] : []);
  const rel = used.size ? all.filter((l) => used.has(norm(l.name)) || [...used].some((u) => u === norm(l.name) || (l.bus && u === norm(l.name)))) : all;
  const lines = (rel.length ? rel : all).filter((l, i, a) => a.findIndex((x) => x.name === l.name) === i);
  const bad = lines.filter((l) => l.level !== "good");
  const w = wFact ? readWeather(wFact.value) : null;

  return (
    <div className="flex flex-col items-end gap-1.5 max-sm:gap-1">
      <AnimatePresence>
        {w && wFact ? (
          <Chip key="wx" i={0} label={`Weather: ${w.temp ?? ""} ${w.cond}${w.hint ? `, ${w.hint}` : ""}`} pop={<><p className="font-semibold text-ink">{wFact.value}</p><p className="num mt-1 font-mono text-[11px] text-ink-3">{srcLine(wFact)}</p></>}>
            <span className={cn("grid size-8 shrink-0 place-items-center rounded-[10px] max-sm:size-7", w.wet ? "bg-sky-soft text-sky-ink" : "bg-hi-soft text-likely")}>
              <w.Icon className="size-[18px]" strokeWidth={2.2} aria-hidden />
            </span>
            <span className="flex flex-col leading-tight">
              <span className="num whitespace-nowrap text-[13.5px] font-bold text-ink">{[w.temp, w.cond].filter(Boolean).join(" · ")}</span>
              {w.hint ? <span className="whitespace-nowrap text-[11.5px] font-medium text-ink-3">{w.hint}</span> : null}
            </span>
          </Chip>
        ) : null}
        {lines.length ? (
          <Chip
            key="tfl"
            i={1}
            label={bad.length ? bad.map((l) => `${l.name}: ${l.status}`).join(", ") : "Lines running well"}
            pop={
              <>
                <ul className="flex flex-col gap-1.5">
                  {all.map((l) => (
                    <li key={l.name} className="flex items-start gap-2">
                      <span className={cn("mt-[6px] size-2 shrink-0 rounded-full", DOT[l.level])} aria-hidden />
                      <span><b className="font-semibold text-ink">{l.name}</b>: {l.status}{l.detail ? <span className="text-ink-3"> · {l.detail}</span> : null}</span>
                    </li>
                  ))}
                </ul>
                <p className="num mt-2 border-t border-rule pt-1.5 font-mono text-[11px] text-ink-3">{sFacts.map(srcLine).filter((v, i, a) => a.indexOf(v) === i).join(" · ")}</p>
              </>
            }
          >
            {bad.length ? (
              <span className="flex flex-col gap-1 py-0.5 pl-1">
                {bad.map((l) => (
                  <span key={l.name} className="flex items-center gap-1.5 whitespace-nowrap">
                    <span className={cn("size-2 rounded-full", DOT[l.level])} aria-hidden />
                    <LineBadge l={l} />
                    <span className="text-[12.5px] font-semibold text-ink">{l.status}</span>
                  </span>
                ))}
              </span>
            ) : (
              <>
                <span className="relative ml-1 flex size-2.5" aria-hidden>
                  <span className="absolute inset-0 animate-ping rounded-full bg-ok opacity-50 [animation-duration:2.4s] motion-reduce:hidden" />
                  <span className="relative size-2.5 rounded-full bg-ok" />
                </span>
                <span className="flex gap-1">{lines.slice(0, 3).map((l) => <LineBadge key={l.name} l={l} />)}</span>
                <span className="whitespace-nowrap text-[12.5px] font-semibold text-ink">Lines running well</span>
              </>
            )}
          </Chip>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
