"use client";

import { useEffect, useRef } from "react";
import { animate, useInView, useMotionValue, useReducedMotion, useSpring, useTransform } from "motion/react";

/** Counts up to `value` once visible. Respects reduced motion. */
export function CountUp({ value, delay = 0, duration = 0.9, className }: { value: number; delay?: number; duration?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true });
  const reduced = useReducedMotion();
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (reduced) {
      node.textContent = String(value);
      return;
    }
    if (!inView) return;
    const c = animate(0, value, { duration, delay, ease: [0.22, 1, 0.36, 1], onUpdate: (v) => (node.textContent = String(Math.round(v))) });
    return () => c.stop();
  }, [value, inView, reduced, delay, duration]);
  return <span ref={ref} className={className}>{reduced ? value : 0}</span>;
}

/** Pointer-follow tilt for cards: returns motion values + handlers. */
export function useTilt(max = 5) {
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 260, damping: 22 });
  const sy = useSpring(y, { stiffness: 260, damping: 22 });
  const rotateX = useTransform(sy, [-0.5, 0.5], [max, -max]);
  const rotateY = useTransform(sx, [-0.5, 0.5], [-max, max]);
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    if (reduced || e.pointerType !== "mouse") return;
    const r = e.currentTarget.getBoundingClientRect();
    x.set((e.clientX - r.left) / r.width - 0.5);
    y.set((e.clientY - r.top) / r.height - 0.5);
  };
  const onPointerLeave = () => {
    x.set(0);
    y.set(0);
  };
  return { style: { rotateX, rotateY, transformPerspective: 900 }, onPointerMove, onPointerLeave };
}

// TfL line colours, used to paint line names in journey summaries.
export const TFL_LINES: Record<string, string> = {
  bakerloo: "#B36305", central: "#E32017", circle: "#FFD300", district: "#00782A", "hammersmith & city": "#F3A9BB", jubilee: "#A0A5A9",
  metropolitan: "#9B0056", northern: "#000000", piccadilly: "#003688", victoria: "#0098D4", "waterloo & city": "#95CDBA", elizabeth: "#6950a1",
  overground: "#EE7C0E", dlr: "#00A4A7", "london overground": "#EE7C0E", tram: "#84B817", bus: "#e1251b", windrush: "#EE7C0E", mildmay: "#EE7C0E",
  lioness: "#EE7C0E", suffragette: "#EE7C0E", weaver: "#EE7C0E", liberty: "#EE7C0E",
};

export function lineColour(text: string): string | null {
  const t = text.toLowerCase();
  for (const [k, v] of Object.entries(TFL_LINES)) if (t.includes(k)) return v;
  return null;
}
