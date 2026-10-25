"use client";
// <LiveVoiceButton>: the mic, upgraded to a live spoken conversation (Gemini Live via useLiveVoice).
// Tap to talk, tap again (or End) to stop. If Live can't connect it silently hands over to `onFallback`
// (wire it to the existing Web Speech mic). Nothing is ever sent for the user; drafts only open the dialog.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Loader2, Mic, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useLiveVoice, type LiveCaptions, type LiveState } from "@/lib/live-session";
import type { LiveToolHandler } from "@/lib/live-config";

export type { LiveToolCall, LiveToolHandler } from "@/lib/live-config";

export type LiveVoiceButtonProps = {
  /** Runs a tool the model asked for and returns one or two short sentences for it to speak from. */
  onTool: LiveToolHandler;
  /** Live failed to connect: start the existing Web Speech mic instead (called once per failed tap, no toast). */
  onFallback?: () => void;
  /** True while that fallback mic is listening, so the button keeps showing "on". */
  fallbackListening?: boolean;
  /** Optional one-line context sent silently when a session starts (never read out). */
  context?: () => string | null | undefined;
  size?: "md" | "sm";
  className?: string;
  disabled?: boolean;
  /** Notified on every state change (e.g. to dim the composer while live). */
  onStateChange?: (s: LiveState) => void;
};

const LABEL: Record<LiveState, string> = {
  idle: "Tap to talk",
  connecting: "Connecting…",
  listening: "Listening",
  thinking: "Thinking…",
  speaking: "Speaking",
};

/** Frosted orange orb. Level-driven scale via rAF (no React re-render); static under reduced motion. */
export function VoiceOrb({ state, getLevel, size = 56 }: { state: LiveState; getLevel?: () => number; size?: number }) {
  const reduced = useReducedMotion();
  const core = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reduced || !getLevel) return;
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      smooth = smooth * 0.75 + getLevel() * 0.25;
      if (core.current) core.current.style.transform = `scale(${1 + smooth * 0.32})`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reduced, getLevel]);

  const busy = state === "thinking" || state === "connecting";
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-hidden>
      {!reduced && state === "listening" ? (
        <motion.span
          className="absolute inset-0 rounded-full bg-[#ff6b2c]/25"
          animate={{ scale: [1, 1.35], opacity: [0.55, 0] }}
          transition={{ duration: 1.6, repeat: Infinity, ease: "easeOut" }}
        />
      ) : null}
      {busy ? (
        <motion.span
          className="absolute inset-[-3px] rounded-full"
          style={{ background: "conic-gradient(from 0deg, rgba(255,107,44,0) 0deg, rgba(255,107,44,.9) 120deg, rgba(255,184,120,.2) 240deg, rgba(255,107,44,0) 360deg)" }}
          animate={reduced ? { opacity: [0.5, 1, 0.5] } : { rotate: 360 }}
          transition={{ duration: reduced ? 2 : 1.1, repeat: Infinity, ease: "linear" }}
        />
      ) : null}
      <div
        ref={core}
        className={cn(
          "relative size-full rounded-full shadow-[0_8px_24px_-6px_rgba(255,107,44,.65),inset_0_1px_1px_rgba(255,255,255,.6)] ring-1 ring-white/50 transition-[filter] duration-300 will-change-transform",
          state === "idle" && "saturate-50",
        )}
        style={{ background: "radial-gradient(circle at 35% 30%, #ffd2b0 0%, #ff8a4c 38%, #ff6b2c 62%, #e5530f 100%)" }}
      >
        <span className="absolute inset-[18%] rounded-full bg-white/25 blur-[6px]" />
      </div>
    </div>
  );
}

function Captions({ c }: { c: LiveCaptions }) {
  if (!c.you && !c.agent) return null;
  return (
    <div className="mt-1.5 space-y-1 text-[13px] leading-[18px]" aria-live="polite">
      {c.you ? <p className="line-clamp-2 text-ink-2"><span className="font-semibold text-ink-3">You · </span>{c.you}</p> : null}
      {c.agent ? <p className="line-clamp-2 text-ink"><span className="font-semibold text-signal-ink">So where · </span>{c.agent}</p> : null}
    </div>
  );
}

/** Floating frosted panel shown while a live session runs (portalled so transformed parents can't clip it). */
export function LiveVoicePanel({ state, captions, getLevel, onEnd }: { state: LiveState; captions: LiveCaptions; getLevel?: () => number; onEnd: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  // The app renders one voice dock (reply card above, this bar below) so the two never overlap; fall back to a fixed bar.
  const slot = document.getElementById("sw-live-slot");
  return createPortal(
    <AnimatePresence>
      {state !== "idle" ? (
        <motion.div
          key="sw-live"
          role="dialog"
          aria-label="Live voice"
          initial={{ opacity: 0, y: 16, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 420, damping: 34 }}
          className={cn(
            slot ? "pointer-events-auto relative w-full max-w-[440px]" : "fixed inset-x-3 bottom-[max(12px,env(safe-area-inset-bottom))] z-[60] mx-auto w-auto max-w-[440px]",
            "rounded-[22px] bg-white/72 p-3 pr-3.5 shadow-[0_18px_48px_-12px_rgba(20,20,30,.35)] ring-1 ring-black/[.06] backdrop-blur-2xl backdrop-saturate-150",
          )}
        >
          <div className="flex items-center gap-3">
            <VoiceOrb state={state} getLevel={getLevel} size={52} />
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 text-[15px] font-semibold text-ink">
                {LABEL[state]}
                {state === "connecting" ? <Loader2 className="size-3.5 animate-spin text-ink-3" aria-hidden /> : null}
              </p>
              <p className="text-[12px] text-ink-3">Voice isn&apos;t saved.</p>
            </div>
            <button
              type="button"
              onClick={onEnd}
              className="sw-btn inline-flex min-h-10 items-center gap-1.5 rounded-full bg-[#ff6b2c] px-3.5 text-[14px] font-semibold text-white shadow-[0_6px_16px_-6px_rgba(255,107,44,.8)] hover:bg-[#e5530f]"
            >
              <X className="size-4" aria-hidden /> End
            </button>
          </div>
          <Captions c={captions} />
        </motion.div>
      ) : null}
    </AnimatePresence>,
    slot ?? document.body,
  );
}

export function LiveVoiceButton({ onTool, onFallback, fallbackListening = false, context, size = "md", className, disabled, onStateChange }: LiveVoiceButtonProps) {
  const live = useLiveVoice({ onTool, context, onFallback: () => onFallback?.() });
  const reduced = useReducedMotion();
  useEffect(() => onStateChange?.(live.state), [live.state, onStateChange]);
  const on = live.active || fallbackListening;

  return (
    <>
      <motion.button
        type="button"
        disabled={disabled}
        onClick={() => (fallbackListening ? onFallback?.() : live.toggle())}
        aria-pressed={on}
        aria-label={on ? "End voice" : "Talk to So where"}
        data-live-state={fallbackListening ? "fallback" : live.state}
        whileTap={{ scale: 0.9 }}
        className={cn(
          "sw-btn relative shrink-0 rounded-full transition-colors",
          size === "md" ? "size-11" : "size-10",
          on ? "bg-[linear-gradient(180deg,#ff8a4c,#ff6b2c)] text-white shadow-[0_6px_16px_-6px_rgba(255,107,44,.8)]" : "text-ink-2 hover:bg-white/80 hover:text-ink",
          className,
        )}
      >
        {live.state === "connecting" ? (
          <Loader2 className="mx-auto size-[18px] animate-spin" aria-hidden />
        ) : on ? (
          <span className="flex h-4 items-center justify-center gap-[3px]" aria-hidden>
            {[0, 1, 2, 3].map((i) =>
              reduced ? (
                <span key={i} className="h-2.5 w-[3px] rounded-full bg-white" />
              ) : (
                <motion.span
                  key={i}
                  className="w-[3px] rounded-full bg-white"
                  animate={{ height: live.state === "thinking" ? [6, 8, 6] : [5, 15, 7, 12, 5] }}
                  transition={{ duration: live.state === "thinking" ? 0.6 : 0.9, repeat: Infinity, delay: i * 0.12, ease: "easeInOut" }}
                />
              ),
            )}
          </span>
        ) : (
          <Mic className="mx-auto size-[18px]" aria-hidden />
        )}
      </motion.button>
      <LiveVoicePanel state={live.state} captions={live.captions} getLevel={live.getLevel} onEnd={live.stop} />
    </>
  );
}
