"use client";

import { motion, useReducedMotion } from "motion/react";

type Drift = {
  id: string;
  className: string;
  x: number[];
  y: number[];
  duration: number;
};

const BLOBS: Drift[] = [
  {
    id: "blue",
    className: "left-[-16%] top-[-24%] h-[64vh] w-[58vw] bg-[#d9e8ff]",
    x: [0, 72, -28, 0],
    y: [0, 40, 78, 0],
    duration: 32,
  },
  {
    id: "lavender",
    className: "right-[-18%] top-[4%] h-[56vh] w-[52vw] bg-[#e8e0ff]",
    x: [0, -80, 24, 0],
    y: [0, 56, -18, 0],
    duration: 38,
  },
  {
    id: "mint",
    className: "bottom-[-26%] left-[8%] h-[52vh] w-[64vw] bg-[#d7f6ea]",
    x: [0, 48, -36, 0],
    y: [0, -52, 16, 0],
    duration: 36,
  },
  {
    id: "white",
    className: "top-[22%] left-[28%] h-[42vh] w-[40vw] bg-white",
    x: [0, -30, 40, 0],
    y: [0, 28, -24, 0],
    duration: 44,
  },
];

const BEAM_GRADIENT =
  "repeating-linear-gradient(108deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.95) 7%, rgba(219,234,254,0.35) 14%, rgba(237,233,254,0.7) 22%, rgba(255,255,255,0) 31%, rgba(209,250,229,0.55) 43%, rgba(255,255,255,0) 54%, rgba(224,242,254,0.75) 66%, rgba(255,255,255,0) 78%)";

export function AnimatedBackground() {
  const prefersReducedMotion = useReducedMotion();
  const animate = prefersReducedMotion === false;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-[#fafaf7]"
    >
      <motion.div
        className="absolute -inset-x-[18%] -inset-y-[12%] opacity-60 blur-2xl"
        style={{ backgroundImage: BEAM_GRADIENT, backgroundSize: "180% 100%" }}
        animate={animate ? { x: ["-6%", "7%", "-6%"] } : undefined}
        transition={animate ? { duration: 46, repeat: Infinity, ease: "easeInOut" } : undefined}
      />
      {BLOBS.map((blob) => (
        <motion.div
          key={blob.id}
          className={`absolute rounded-full opacity-70 blur-3xl ${blob.className}`}
          animate={animate ? { x: blob.x, y: blob.y } : undefined}
          transition={
            animate ? { duration: blob.duration, repeat: Infinity, ease: "easeInOut" } : undefined
          }
        />
      ))}
      <div className="absolute inset-0 bg-gradient-to-b from-[#fafaf7]/40 via-white/30 to-[#fafaf7]/60" />
    </div>
  );
}
