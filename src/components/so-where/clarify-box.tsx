"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, MessageCircleQuestion } from "lucide-react";
import type { Clarify } from "@/lib/plan-types";

export function ClarifyBox({ clarify, onAnswer }: { clarify: Clarify; onAnswer: (answer: string) => void }) {
  const [text, setText] = useState("");
  const send = (a: string) => a.trim() && onAnswer(a.trim());
  return (
    <motion.section
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      aria-label="One question first"
      className="rounded-[14px] border border-line bg-surface p-4"
    >
      <div className="flex items-start gap-2.5">
        <MessageCircleQuestion className="mt-0.5 size-5 shrink-0 text-ink" aria-hidden />
        <h2 className="text-[17px] font-semibold leading-6 tracking-[-0.01em]">{clarify.question}</h2>
      </div>
      {clarify.suggestions?.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {clarify.suggestions.map((s, i) => (
            <motion.button
              key={s}
              type="button"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 + i * 0.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={() => send(s)}
              className="min-h-11 cursor-pointer rounded-full border border-line bg-raised px-4 text-[14px] font-medium text-ink transition-colors hover:border-ink"
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
          placeholder="Or type it…"
          className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-raised px-3 text-[16px] text-ink placeholder:text-ink-3 focus:border-ink focus:outline-none"
        />
        <button type="submit" aria-label="Answer" className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-[10px] bg-ink text-white transition-opacity hover:opacity-90 disabled:opacity-40" disabled={!text.trim()}>
          <ArrowRight className="size-5" aria-hidden />
        </button>
      </form>
    </motion.section>
  );
}
