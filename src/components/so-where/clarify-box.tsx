"use client";

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { ArrowRight, LocateFixed, MessageCircleQuestion } from "lucide-react";
import type { Clarify } from "@/lib/plan-types";

export function ClarifyBox({ clarify, onAnswer, onLocate, heard, listening, mic }: { clarify: Clarify; onAnswer: (answer: string) => void; onLocate?: () => void; heard?: string; listening?: boolean; mic?: ReactNode }) {
  const [text, setText] = useState("");
  // A spoken answer fills the box live and sends itself after a short pause.
  useEffect(() => { if (heard) setText(heard); }, [heard]);
  const send = (a: string) => a.trim() && onAnswer(a.trim());
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      aria-label="One question first"
      className="relative overflow-hidden rounded-[16px] bg-white/80 p-4 pt-5 shadow-e3 ring-1 ring-signal/25"
    >
      <span aria-hidden className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-[#ff9a3c] via-signal to-signal-strong" />
      <div className="flex items-start gap-2.5">
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-sky-soft text-sky-ink" aria-hidden><MessageCircleQuestion className="size-[18px]" /></span>
        <h2 className="pt-1 text-[17px] font-semibold leading-6 tracking-[-0.01em] text-ink">{clarify.question}</h2>
      </div>
      {onLocate ? (
        <motion.button type="button" whileHover={{ y: -1 }} whileTap={{ scale: 0.96 }} onClick={onLocate} className="sw-btn mt-3 min-h-11 rounded-full bg-hi px-4 text-[14px] font-semibold text-ink shadow-e2 hover:shadow-e3 transition-[box-shadow,background-color,color]">
          <LocateFixed className="size-4" aria-hidden /> Use my location, then ask again
        </motion.button>
      ) : null}
      {clarify.suggestions?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {clarify.suggestions.map((s, i) => (
            <motion.button
              key={s}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + i * 0.05 }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => send(s)}
              className="sw-chip min-h-11 px-4 text-[14px] font-medium text-ink hover:bg-sky-wash transition-[box-shadow,background-color,color]"
            >
              {s}
            </motion.button>
          ))}
        </div>
      ) : null}
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send(text);
        }}
      >
        <label className="sr-only" htmlFor="clarify-answer">Your answer</label>
        <input
          id="clarify-answer"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={listening ? "Listening…" : mic ? "Or type or say it…" : "Or type it…"}
          className="sw-field h-11 min-w-0 flex-1 px-3 text-[16px] text-ink caret-signal placeholder:text-ink-3 focus:bg-surface focus:shadow-[0_0_0_1.5px_var(--sw-signal),var(--sw-shadow-focus)] focus:outline-none"
        />
        {mic}
        <button type="submit" aria-label="Answer" className="sw-btn sw-btn-primary size-11 shrink-0 rounded-[12px]" disabled={!text.trim()}>
          <ArrowRight className="size-5" aria-hidden />
        </button>
      </form>
    </motion.section>
  );
}
