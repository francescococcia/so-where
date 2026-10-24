"use client";

import { useSyncExternalStore } from "react";
import { cumLen, pointAt, type MapStretch } from "./journey";

/**
 * Journey vehicles: a bus badge, a line-coloured roundel or walking footsteps that travel each person's route,
 * segment by segment. Pure helpers + a tiny store so the detail panel can highlight the segment in motion.
 */

export type Who = "you" | "them";
export type Track = { parts: { st: MapStretch; cum: number[]; t0: number; t1: number }[]; run: number; cycle: number };

const RUN_MS = 5000; // whole journey ≈ 5 s
const PAUSE_MS = 900; // rest at the destination before looping
const MIN_PART_MS = 650; // short walks stay visible

/** Time-split a journey: proportional to stretch length, with a floor so a 2-minute walk doesn't flash past. */
export function buildTrack(st: MapStretch[]): Track | null {
  const parts = st.filter((s) => s.coords.length >= 2).map((s) => ({ st: s, cum: cumLen(s.coords), t0: 0, t1: 0 }));
  if (!parts.length) return null;
  const lens = parts.map((p) => p.cum[p.cum.length - 1]);
  const total = lens.reduce((a, b) => a + b, 0) || 1;
  const raw = lens.map((l) => Math.max(MIN_PART_MS, (l / total) * RUN_MS));
  const k = RUN_MS / raw.reduce((a, b) => a + b, 0);
  let t = 0;
  parts.forEach((p, i) => {
    p.t0 = t;
    t += raw[i] * k;
    p.t1 = t;
  });
  return { parts, run: t, cycle: t + PAUSE_MS };
}

const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Where the vehicle is at clock `ms`: position, which part, and a short trail behind it (for walking dots). */
export function sampleTrack(tr: Track, ms: number): { at: [number, number]; part: number; resting: boolean; trail: [number, number][] } {
  const t = ms % tr.cycle;
  if (t >= tr.run) {
    const last = tr.parts[tr.parts.length - 1];
    return { at: last.st.coords[last.st.coords.length - 1], part: tr.parts.length - 1, resting: true, trail: [] };
  }
  let i = 0;
  while (i < tr.parts.length - 1 && t >= tr.parts[i].t1) i++;
  const p = tr.parts[i];
  const f = ease((t - p.t0) / (p.t1 - p.t0 || 1));
  const at = pointAt(p.st.coords, p.cum, f);
  const trail: [number, number][] = [];
  if (p.st.kind === "walk") {
    const len = p.cum[p.cum.length - 1] || 1;
    for (let k = 1; k <= 3; k++) {
      const g = f - (k * 22) / len; // a dot every ~22 m behind
      if (g > 0) trail.push(pointAt(p.st.coords, p.cum, g));
    }
  }
  return { at, part: i, resting: false, trail };
}

/** Midpoint of each stretch, for the reduced-motion static icons. */
export function midpoints(tr: Track): { at: [number, number]; st: MapStretch }[] {
  return tr.parts.map((p) => ({ at: pointAt(p.st.coords, p.cum, 0.5), st: p.st }));
}

// ---------- Badge markup (hand-drawn lucide paths, so no React render in the loop) ----------

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const BUS = svg('<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>');
const TRAIN = svg('<path d="M8 3.1V7a4 4 0 0 0 8 0V3.1"/><path d="m9 15-1-1"/><path d="m15 15 1-1"/><path d="M9 19c-2.8 0-5-2.2-5-5v-4a8 8 0 0 1 16 0v4c0 2.8-2.2 5-5 5Z"/><path d="m8 19-2 3"/><path d="m16 19 2 3"/>');
const TRAM = svg('<rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16"/><path d="M12 3v8"/><path d="m8 19-2 3"/><path d="m18 22-2-3"/><path d="M8 15h.01"/><path d="M16 15h.01"/>');
const FEET = svg('<path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z"/><path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z"/><path d="M16 17h4"/><path d="M4 13h4"/>');

function inkOn(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  const L = (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
  return L > 0.62 ? "#15171c" : "#ffffff";
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Inner HTML + class for one stretch's badge. */
export function badge(st: MapStretch): { cls: string; html: string; style: string } {
  if (st.kind === "walk") return { cls: "is-walk", html: FEET, style: "" };
  if (st.kind === "bus") return { cls: "is-bus", html: BUS + (st.label ? `<b>${esc(st.label)}</b>` : ""), style: "" };
  return { cls: "is-rail", html: st.mode === "tram" ? TRAM : TRAIN, style: `--veh:${st.color};--veh-ink:${inkOn(st.color)}` };
}

// ---------- Active segment store (map → detail panel) ----------

type Active = { card: string | null; you: number | null; them: number | null };
let active: Active = { card: null, you: null, them: null };
const subs = new Set<() => void>();

export function setActiveSeg(card: string | null, who: Who, seg: number | null) {
  if (active.card === card && active[who] === seg) return;
  active = active.card === card ? { ...active, [who]: seg } : { card, you: null, them: null, [who]: seg };
  subs.forEach((f) => f());
}
export function clearActiveSeg() {
  if (active.card === null && active.you === null && active.them === null) return;
  active = { card: null, you: null, them: null };
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

/** Index (into segmentsOf(leg)) of the segment the map vehicle is on for this card + person, else null. */
export function useActiveSeg(card: string, who: Who): number | null {
  return useSyncExternalStore(subscribe, () => (active.card === card ? active[who] : null), () => null);
}
