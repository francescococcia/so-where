"use client";

import { Bus, Footprints, TrainFront, TramFront } from "lucide-react";
import type { Leg } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { TFL_LINES } from "./motion-bits";

/** One stretch of a journey. Built from structured leg data when the server sends it, else read from the summary text. */
export type Mode = "walk" | "tube" | "bus" | "dlr" | "overground" | "elizabeth" | "rail" | "tram";
export type Segment = { mode: Mode; line?: string; from?: string; to?: string; minutes?: number; est?: boolean; join?: "then" | "or" };

const MODE_WORD: Record<Mode, string> = { walk: "walk", tube: "Tube", bus: "bus", dlr: "DLR", overground: "Overground", elizabeth: "Elizabeth line", rail: "train", tram: "tram" };

function modeOf(text: string): Mode {
  const t = text.toLowerCase();
  if (/\bwalk|on foot|walking/.test(t)) return "walk";
  if (/\bbus\b|^\d{1,3}[a-z]?$/.test(t)) return "bus";
  if (/\bdlr\b/.test(t)) return "dlr";
  if (/overground|windrush|mildmay|lioness|suffragette|weaver|liberty/.test(t)) return "overground";
  if (/elizabeth/.test(t)) return "elizabeth";
  if (/tram/.test(t)) return "tram";
  if (/national rail|\brail\b|thameslink|southern|southeastern|\btrain\b/.test(t)) return "rail";
  return "tube";
}

const clean = (s?: string) => s?.replace(/\s*\((?:direct|estimate)\)\s*/gi, "").replace(/\b(underground )?station\b/gi, "").replace(/\s{2,}/g, " ").trim() || undefined;

function fromStructured(raw: unknown): Segment[] | null {
  if (!Array.isArray(raw) || !raw.length) return null;
  const out: Segment[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const modeTxt = String(r.mode ?? r.modeName ?? r.type ?? "");
    const line = (r.lineName ?? r.line ?? r.route) as string | undefined;
    out.push({
      mode: modeOf(`${modeTxt} ${line ?? ""}`.trim() || "tube"),
      line: typeof line === "string" ? line : undefined,
      from: clean(typeof r.from === "string" ? r.from : (r.from as { name?: string } | undefined)?.name),
      to: clean(typeof r.to === "string" ? r.to : (r.to as { name?: string } | undefined)?.name),
      minutes: typeof r.minutes === "number" ? r.minutes : typeof r.duration === "number" ? r.duration : undefined,
      join: out.length ? "then" : undefined,
    });
  }
  return out.length ? out : null;
}

function fromSummary(summary: string): Segment[] {
  const out: Segment[] = [];
  // "Walk, or bus 394 · 13 min" / "Jubilee line to Waterloo, then Northern line (direct) · then ~4 min walk (estimate)"
  const tokens = summary.split(/\s*·\s*|,\s*(?=then\b|or\b)|\s+(?=then\b)/i).map((s) => s.trim()).filter(Boolean);
  for (let tok of tokens) {
    let join: Segment["join"] = out.length ? "then" : undefined;
    const j = tok.match(/^(then|or)\s+/i);
    if (j) {
      join = j[1].toLowerCase() as "then" | "or";
      tok = tok.slice(j[0].length);
    }
    tok = tok.replace(/,\s*direct$/i, "").trim();
    const est = /estimate|~/.test(tok);
    const minM = tok.match(/~?(\d+)\s*min/i) ?? tok.match(/(?:walk|on foot)\s+(\d+)\b/i);
    const minutes = minM ? +minM[1] : undefined;
    // A bare "13 min" belongs to the stretch before it.
    if (/^~?\d+\s*min$/i.test(tok) && out.length) {
      out[out.length - 1].minutes = minutes;
      continue;
    }
    const mode = modeOf(tok);
    let line: string | undefined;
    let from: string | undefined;
    let to: string | undefined;
    const ft = tok.match(/\bfrom\s+(.+?)\s+to\s+(.+)$/i);
    const toM = tok.match(/\bto\s+(.+?)(?:\s+towards\s+.*)?$/i);
    if (ft) {
      from = clean(ft[1]);
      to = clean(ft[2]);
    } else if (toM) to = clean(toM[1]);
    if (mode !== "walk") {
      const head = clean(tok.replace(/\b(from|to|towards)\s+.*$/i, "").replace(/~?\d+\s*min/i, ""));
      if (mode === "bus") {
        const n = tok.match(/\bbus\s+([a-z]?\d+[a-z]?)/i) ?? tok.match(/^([a-z]?\d+[a-z]?)\b/i);
        line = n ? `Bus ${n[1].toUpperCase()}` : undefined;
      } else if (head && !/^(tube|underground|train|rail)$/i.test(head)) line = head.replace(/^london\s+/i, "").replace(/^(\w)/, (c) => c.toUpperCase());
    }
    out.push({ mode, line, from, to, minutes, est, join });
  }
  return out.length ? out : [{ mode: "tube" }];
}

export function segmentsOf(leg: Leg): Segment[] {
  const l = leg as Leg & { segments?: unknown; parts?: unknown; steps?: unknown };
  return fromStructured(l.segments ?? l.parts ?? l.steps) ?? fromSummary(leg.summary ?? "");
}

export function lineHex(seg: Segment): string | null {
  if (seg.mode === "bus") return "#DC241F";
  const t = `${seg.line ?? ""} ${seg.mode === "tube" ? "" : seg.mode}`.toLowerCase();
  for (const [k, v] of Object.entries(TFL_LINES)) if (t.includes(k)) return v;
  return null;
}

function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.18 ? "#15171c" : "#ffffff";
}

export function ModeIcon({ mode, className, style }: { mode: Mode; className?: string; style?: React.CSSProperties }) {
  const I = mode === "walk" ? Footprints : mode === "bus" ? Bus : mode === "tram" ? TramFront : TrainFront;
  return <I className={className} style={style} aria-hidden />;
}

/** The official-colour line pill: "[🚇 Jubilee line]". Falls back to the mode word when there's no line name. */
export function LinePill({ seg, small }: { seg: Segment; small?: boolean }) {
  const hex = lineHex(seg);
  const label = seg.line ?? MODE_WORD[seg.mode].replace(/^./, (c) => c.toUpperCase());
  return (
    <span
      className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded-[6px] align-[1px] font-semibold leading-none shadow-e1", small ? "h-[18px] px-1.5 text-[11.5px]" : "h-[22px] px-2 text-[13px]", !hex && "bg-sky-soft text-sky-ink")}
      style={hex ? { background: hex, color: inkOn(hex) } : undefined}
    >
      <ModeIcon mode={seg.mode} className={small ? "size-3" : "size-3.5"} />
      {label}
    </span>
  );
}

function SegText({ seg, small }: { seg: Segment; small?: boolean }) {
  if (seg.mode === "walk") {
    return (
      <span className="inline-flex items-baseline gap-1 whitespace-nowrap">
        <Footprints className={cn("self-center text-ink-3", small ? "size-3" : "size-3.5")} aria-hidden />
        {seg.minutes != null ? `${seg.est ? "~" : ""}${seg.minutes} min walk` : "walk"}
        {seg.to ? <span className="whitespace-normal"> to {seg.to}</span> : null}
      </span>
    );
  }
  return (
    <span>
      <LinePill seg={seg} small={small} />
      {seg.from ? <> from <b className="font-semibold text-ink">{seg.from}</b></> : null}
      {seg.to ? <> to <b className="font-semibold text-ink">{seg.to}</b></> : null}
      {seg.minutes != null ? <span className="text-ink-3"> ({seg.minutes} min)</span> : null}
    </span>
  );
}

/** One plain sentence: "6 min walk" or "18 min: [Jubilee line] from London Bridge to Waterloo, then 4 min walk". */
const ACTIVE_SEG = "bg-signal-soft shadow-[0_0_0_3px_var(--color-signal-soft)]";

export function JourneySentence({ leg, small, className, active }: { leg: Leg; small?: boolean; className?: string; active?: number | null }) {
  const segs = segmentsOf(leg);
  const onlyWalk = segs.length === 1 && segs[0].mode === "walk";
  if (onlyWalk) {
    const s = segs[0];
    return (
      <span className={className}>
        <span className={cn("inline-flex items-baseline gap-1 rounded-[6px] transition-[background-color,box-shadow] duration-300", active === 0 && ACTIVE_SEG)}>
          <Footprints className={cn("self-center", small ? "size-3.5" : "size-4")} aria-hidden />
          <b className="num font-semibold text-ink">{leg.minutes} min walk</b>
          {s.to ? <> to {s.to}</> : null}
        </span>
      </span>
    );
  }
  return (
    <span className={cn("leading-[1.7]", className)}>
      <b className="num font-semibold text-ink">{leg.minutes} min</b>
      {": "}
      {segs.map((s, i) => (
        <span key={i}>
          {i ? (s.join === "or" ? ", or " : ", then ") : null}
          <span className={cn("rounded-[6px] transition-[background-color,box-shadow] duration-300", active === i && ACTIVE_SEG)} data-active={active === i || undefined}>
            <SegText seg={s} small={small} />
          </span>
        </span>
      ))}
    </span>
  );
}

// ---------- Map geometry: one coloured stretch per segment ----------

type LL = { lat: number; lng: number };
const isLL = (p: unknown): p is LL => !!p && typeof (p as LL).lat === "number" && typeof (p as LL).lng === "number";

export const BUS_RED = "#DC241F";
export const WALK_GREY = "#7d8087";

/** One coloured piece of a leg on the map. `seg` indexes segmentsOf(leg) so the map can highlight the journey row. */
export type MapStretch = { coords: [number, number][]; kind: "rail" | "bus" | "walk"; color: string; label: string; mode: Mode; seg: number };

function styleOf(seg: Segment): Omit<MapStretch, "coords" | "seg"> {
  if (seg.mode === "walk") return { kind: "walk", color: WALK_GREY, label: "", mode: "walk" };
  if (seg.mode === "bus") return { kind: "bus", color: BUS_RED, label: (seg.line ?? "").replace(/^bus\s+/i, ""), mode: "bus" };
  return { kind: "rail", color: lineHex(seg) ?? "#4a4d55", label: "", mode: seg.mode };
}

/** Cumulative planar length (metres-ish) along [lng,lat] coords. */
export function cumLen(c: [number, number][]): number[] {
  const out = [0];
  for (let i = 1; i < c.length; i++) {
    const k = Math.cos(((c[i][1] + c[i - 1][1]) / 2) * (Math.PI / 180));
    out.push(out[i - 1] + Math.hypot((c[i][0] - c[i - 1][0]) * k, c[i][1] - c[i - 1][1]) * 111_320);
  }
  return out;
}

/** Point at fraction f (0..1) of a polyline, given its cumulative lengths. */
export function pointAt(c: [number, number][], cum: number[], f: number): [number, number] {
  const total = cum[cum.length - 1];
  if (!total || c.length < 2) return c[0];
  const d = Math.min(Math.max(f, 0), 1) * total;
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const span = cum[i] - cum[i - 1] || 1;
  const t = (d - cum[i - 1]) / span;
  return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * t, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * t];
}

/** Sub-polyline between fractions a..b. */
function slicePath(c: [number, number][], cum: number[], a: number, b: number): [number, number][] {
  const total = cum[cum.length - 1] || 1;
  const out: [number, number][] = [pointAt(c, cum, a)];
  for (let i = 1; i < c.length - 1; i++) if (cum[i] / total > a && cum[i] / total < b) out.push(c[i]);
  out.push(pointAt(c, cum, b));
  return out;
}

/**
 * When the server only sends one leg path (fixtures, older plans), cut it into the "then" chain of segments by
 * rough distance: walking ~80 m/min, transit ~6x that. Unknown minutes: 4 min per walk, the rest shared by transit.
 */
function splitBySegments(path: [number, number][], segs: Segment[], minutes: number): MapStretch[] | null {
  const chain: Segment[] = [];
  for (const sg of segs) {
    if (chain.length && sg.join === "or") break;
    chain.push(sg);
  }
  if (chain.length < 2) return null;
  const known = chain.reduce((n, sg) => n + (sg.minutes ?? (sg.mode === "walk" ? 4 : 0)), 0);
  const unknownT = chain.filter((sg) => sg.minutes == null && sg.mode !== "walk").length;
  const share = unknownT ? Math.max(2, (minutes - known) / unknownT) : 0;
  const w = chain.map((sg) => (sg.minutes ?? (sg.mode === "walk" ? 4 : share)) * (sg.mode === "walk" ? 1 : 6));
  const W = w.reduce((a, b) => a + b, 0);
  if (!W) return null;
  const cum = cumLen(path);
  let acc = 0;
  return chain.map((sg, i) => {
    const a = acc / W;
    acc += w[i];
    return { coords: slicePath(path, cum, a, acc / W), ...styleOf(sg), seg: i };
  });
}

/**
 * Stretches for the map. Uses per-segment geometry when the server sends it (path, or straight lines between
 * stop coordinates; walks without geometry are bridged between neighbours); otherwise the leg path cut by segment.
 */
export function legStretches(leg: Leg): MapStretch[] {
  const l = leg as Leg & { segments?: unknown; parts?: unknown; steps?: unknown };
  const raw = (l.segments ?? l.parts ?? l.steps) as Record<string, unknown>[] | undefined;
  const segs = segmentsOf(leg);
  const toXY = (p: LL): [number, number] => [p.lng, p.lat];
  const path = (leg.path ?? []).filter(isLL).map(toXY);
  if (Array.isArray(raw) && raw.length) {
    const pts: ([number, number][] | null)[] = raw.map((r) => {
      let p: LL[] = [];
      if (Array.isArray(r?.path) && (r.path as unknown[]).length && (r.path as unknown[]).every(isLL)) p = r.path as LL[];
      else if (Array.isArray(r?.stops) && (r.stops as unknown[]).some(isLL)) p = (r.stops as unknown[]).filter(isLL);
      else {
        const a = isLL(r?.from) ? r.from : isLL(r?.fromCoord) ? r.fromCoord : null;
        const b = isLL(r?.to) ? r.to : isLL(r?.toCoord) ? r.toCoord : null;
        if (a && b) p = [a as LL, b as LL];
      }
      return p.length >= 2 ? p.map(toXY) : null;
    });
    if (pts.some(Boolean)) {
      const out: MapStretch[] = [];
      pts.forEach((p, i) => {
        const seg = segs[i] ?? { mode: "tube" as Mode };
        let c = p;
        if (!c) {
          // Bridge a geometry-less segment (usually a walk) between its neighbours / the leg ends.
          const prev = pts.slice(0, i).reverse().find(Boolean);
          const next = pts.slice(i + 1).find(Boolean);
          const a = prev ? prev[prev.length - 1] : path[0];
          const b = next ? next[0] : path[path.length - 1];
          if (a && b && (a[0] !== b[0] || a[1] !== b[1])) c = [a, b];
        }
        if (c) out.push({ coords: c, ...styleOf(seg), seg: i });
      });
      if (out.length) return out;
    }
  }
  if (path.length < 2) return [];
  const split = splitBySegments(path, segs, leg.minutes ?? 0);
  if (split) return split;
  const mi = Math.max(0, segs.findIndex((s) => s.mode !== "walk"));
  return [{ coords: path, ...styleOf(segs[mi] ?? segs[0]), seg: mi }];
}
