"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createPortal } from "react-dom";
import { AnimatePresence, LayoutGroup, MotionConfig, motion, useReducedMotion } from "motion/react";
import { ArrowRight, ArrowUp, CalendarDays, Camera, Check, CheckCircle2, Coffee, DoorOpen, FlaskConical, GitCommitHorizontal, HelpCircle, Info, Languages, LocateFixed, Loader2, Mic, Navigation, PencilLine, Repeat2, Send, ShieldCheck, Sparkles, X } from "lucide-react";
import type { PlanResultWithAgent } from "@/lib/plan-types";
import { translateDemo, type FixtureId } from "@/lib/plan-fixture";
import type { VerifyInfo } from "@/lib/verify";
import { cn } from "@/lib/utils";
import { AgentSteps } from "./agent-steps";
import { SnapSheet, type SnapMode, type SnapView } from "./place-snap";
import { ClarifyBox } from "./clarify-box";
import { LeaveByChip, leaveByOf, type LeaveBy } from "./blurb";
import { PlanCard } from "./plan-card";
import { DetailPanel } from "./place-detail";
import { FollowUps } from "./follow-ups";
import { SendPlanDialog } from "./send-plan-dialog";
import { Mark } from "./mark";
import { VerdictChip } from "./verdict-chip";
import { fmtAsOf, fmtWhen, gmapsDirections } from "./format";
import { usePlan, type Translated } from "./use-plan";
import { useTranslateMic, type HeardTranslation } from "./use-translate-mic";
import { useSpeech } from "./use-speech";
import { LiveVoiceButton } from "./live-voice";
import { BCP47, VoiceCardSlot, primeVoice, type VoiceReply } from "./voice-card";
import { useLiveTools } from "./live-tools";

/** Live voice (Gemini Live). Off unless NEXT_PUBLIC_LIVE_VOICE=1; the Web Speech mic stays the fallback. */
const LIVE_VOICE = process.env.NEXT_PUBLIC_LIVE_VOICE !== "0";
import { MapChips } from "./map-chips";
import { friendlyDraft } from "./draft";
import { CountUp } from "./motion-bits";
import type { MapPadding, ScanFocus } from "./plan-map";

const PlanMap = dynamic(() => import("./plan-map"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 bg-ground" aria-hidden />,
});

const CHIPS = [
  { id: "meet", label: "Meet halfway", Icon: GitCommitHorizontal, ask: "Date on Thursday at 7. I'm at Old Street, she's around Clapham. A pub halfway, about £40 for two." },
  { id: "coffee", label: "Coffee with a friend", Icon: Coffee, ask: "Coffee with Sam tomorrow morning. I'm at King's Cross." },
  { id: "near", label: "What's on near me", Icon: CalendarDays, ask: "It's Saturday, what's on near me?" },
  { id: "walkin", label: "No-registration events", Icon: DoorOpen, ask: "It's Saturday, what's on near me that I can just walk into?" },
] as const;

const INTENT_LABEL = { meet_halfway: "Meet halfway", near_me: "Near you" } as const;

function Header({ example, reason, className }: { example: boolean; reason?: string | null; className?: string }) {
  return (
    <header className={cn("flex items-center gap-2.5", className)}>
      <span className="shrink-0"><Mark /></span>
      <span className="shrink-0 whitespace-nowrap text-[19px] font-bold tracking-[-0.02em] text-ink">So where?</span>
      <span className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
        <AnimatePresence>
          {example ? (
            <motion.span
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8 }}
              title={reason && reason !== "demo link" ? `Example data: the planner didn't respond (${reason})` : "Example data, not a live answer"}
              className="inline-flex h-6 items-center gap-1 rounded-full bg-likely-bg px-2 text-[12px] font-semibold text-likely"
            >
              <FlaskConical className="size-3.5" aria-hidden /> Example data
            </motion.span>
          ) : null}
        </AnimatePresence>
      </span>
    </header>
  );
}

function Filters({ f }: { f: PlanResultWithAgent["filters"] }) {
  const items: { label: string; on: boolean }[] = [];
  if (f.walkIn != null) items.push({ label: "No sign-up", on: f.walkIn });
  if (f.maxMinutes != null) items.push({ label: `Within ${f.maxMinutes} min`, on: true });
  if (f.free != null) items.push({ label: "Free only", on: f.free });
  if (f.budgetGBP != null) items.push({ label: `~£${f.budgetGBP} for two`, on: true });
  if (f.category) items.push({ label: f.category[0].toUpperCase() + f.category.slice(1), on: true });
  if (!items.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="What we filtered on">
      {items.map((it, i) => (
        <motion.li
          key={it.label}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15 + i * 0.04 }}
          className={cn("inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12.5px] font-medium", it.on ? "bg-signal-soft text-signal-ink ring-1 ring-signal/25" : "border border-dashed border-control text-ink-3")}
        >
          {it.on ? <Check className="size-3.5" strokeWidth={2.6} aria-hidden /> : null}
          {it.label}
        </motion.li>
      ))}
    </ul>
  );
}

const LEGEND = [
  { v: "confirmed", text: "Live or official source" },
  { v: "likely", text: "Our data, not checked lately" },
  { v: "forecast", text: "A prediction" },
  { v: "unknown", text: "Couldn't check" },
] as const;

/** The verdict legend, tucked behind a small (i). */
function InfoTip() {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label="How we label facts" aria-expanded={open} onClick={() => setOpen((o) => !o)} onBlur={() => setOpen(false)} className="grid size-6 cursor-pointer place-items-center rounded-full text-ink-3 transition-colors hover:bg-white/70 hover:text-ink">
        <Info className="size-4" aria-hidden />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            role="tooltip"
            initial={{ opacity: 0, y: 4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4 }}
            transition={{ type: "spring", stiffness: 480, damping: 32 }}
            className="sw-glass absolute left-1/2 top-8 z-40 w-[260px] -translate-x-1/2 rounded-[14px] p-3 text-left"
          >
            <ul className="flex flex-col gap-1.5">
              {LEGEND.map((l) => (
                <li key={l.v} className="grid grid-cols-[86px_1fr] items-center gap-2">
                  <VerdictChip verdict={l.v} size="sm" />
                  <span className="text-[12.5px] leading-4 text-ink-2">{l.text}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 border-t border-rule pt-2 text-[11.5px] leading-4 text-ink-3">Their location is rounded to ~500 m. Nothing is sent for you.</p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </span>
  );
}

function Blind({ result, photo = false }: { result: PlanResultWithAgent; photo?: boolean }) {
  const words = result.headline.split(" ");
  return (
    <div className="sw-blind relative overflow-hidden rounded-[16px] bg-tint/80 py-3 pb-4 pl-5 pr-4 text-ink shadow-e2 ring-1 ring-line/70 [perspective:600px]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-1.5 bg-signal" />
      <p className="num font-mono text-[11.5px] font-semibold uppercase tracking-[0.08em] text-signal-ink">
        {fmtWhen(result.when)} · {INTENT_LABEL[result.intent] ?? result.intent}
        {photo ? (
          <span className="ml-2 inline-flex translate-y-[-1px] items-center gap-1 rounded-full bg-signal-soft px-2 py-0.5 align-middle font-sans text-[11px] font-semibold normal-case tracking-normal text-signal-ink ring-1 ring-signal/25">
            <Camera className="size-3" aria-hidden /> From your photo
          </span>
        ) : null}
      </p>
      <h2 className="relative mt-1.5 text-[24px] font-bold leading-[1.15] tracking-[-0.02em] text-balance">
        {words.map((w, i) => {
          // Only journey minutes count up ("you 11 min, her 14."), never dates ("Fri 23 Oct") or other numbers.
          const prev = (words[i - 1] ?? "").replace(/[^\w]/g, "");
          const next = words[i + 1] ?? "";
          const minutes = /^min/i.test(next) || (/^(you|her|him|them|[A-Z][a-z]+)$/.test(prev) && !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)/.test(prev) && !/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/.test(next));
          const m = minutes ? /^(\D*)(\d{1,3})(\D*)$/.exec(w) : null;
          return (
            <motion.span key={i + w} className="inline-block origin-[50%_0%]" initial={{ opacity: 0, rotateX: -95, y: -4 }} animate={{ opacity: 1, rotateX: 0, y: 0 }} transition={{ delay: 0.08 + i * 0.045, type: "spring", stiffness: 380, damping: 22 }}>
              {m ? (
                <>
                  {m[1]}
                  <CountUp value={Number(m[2])} delay={0.25 + i * 0.045} duration={1.1} className="num text-signal-ink" />
                  {m[3]}
                </>
              ) : (
                w
              )}
              {i < words.length - 1 ? "\u00a0" : ""}
            </motion.span>
          );
        })}
      </h2>
      <ArgonRow verify={(result as PlanResultWithAgent & { verify?: VerifyInfo }).verify} top={result.cards[0]?.name} />
    </div>
  );
}

/** server14/ui25: the planner's pick → check → re-pick loop, on the card. Only what verify.ts recorded: the swap
 * reason is the check that failed, "verified" lists what the top card actually passed (its own hours / TfL legs /
 * weather fact). No model text is shown as a fact. */
function ArgonRow({ verify, top }: { verify?: VerifyInfo; top?: string }) {
  const [why, setWhy] = useState(false);
  if (!verify || !top) return null;
  const argon = /argon/i.test(verify.model);
  const who = argon ? "Argon" : verify.model === "rules" ? "Our checks" : verify.model;
  const sw = verify.swapped[0];
  const picks = verify.proposed?.length ?? 0;
  const passed = (verify.passed ?? []).slice(0, 3);
  const secs = verify.ms ? `${(verify.ms / 1000).toFixed(1)} s` : null;
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.35 }} className="mt-2.5 rounded-[12px] bg-white/65 px-2.5 py-2 ring-1 ring-white/80 backdrop-blur-md" data-testid="argon-row">
      <p className="flex items-start gap-1.5 text-[12.5px] leading-[18px] text-ink-2" data-testid={sw ? "argon-swap" : "argon-verified"}>
        {sw ? <Repeat2 className="mt-px size-3.5 shrink-0 text-signal-ink" aria-hidden /> : <ShieldCheck className="mt-px size-3.5 shrink-0 text-signal-ink" aria-hidden />}
        {sw ? (
          <span>
            <span className="font-semibold text-ink">{argon && picks ? `Argon checked ${picks} pick${picks === 1 ? "" : "s"}` : `${who} re-checked`}</span>
            <span className="text-ink-3"> · </span>Repicked: {sw.from}
            {sw.reason ? <span className="text-ink-3"> ({sw.reason})</span> : null} <span aria-label="for">→</span> <span className="font-semibold text-ink">{sw.to}</span>
            {verify.swapped.length > 1 ? <span className="text-ink-3"> · +{verify.swapped.length - 1} more</span> : null}
          </span>
        ) : (
          <span>
            <span className="font-semibold text-ink">{argon ? "Argon verified" : verify.model === "rules" ? "Checked" : `Verified (${who})`}</span>{" "}
            {top}
            {passed.length ? <span className="text-ink-3">: {passed.join(" · ")}</span> : null}
          </span>
        )}
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1.5 pl-5 text-[11.5px] leading-4 text-ink-3">
        <span>
          {verify.checked ?? "Its"} option{verify.checked === 1 ? "" : "s"} checked{verify.checks?.length ? `: ${verify.checks.slice(0, 3).join(", ")}` : ""}
          {verify.rounds > 1 ? " · 2 rounds" : ""}
          {secs && argon ? ` · ${secs}` : ""}
        </span>
        {argon ? (
          <button type="button" aria-expanded={why} onClick={() => setWhy((w) => !w)} className="cursor-pointer font-semibold text-signal-ink underline decoration-signal/40 underline-offset-2 hover:decoration-signal">
            Why Argon
          </button>
        ) : null}
      </p>
      <AnimatePresence initial={false}>
        {why ? (
          <motion.p key="why" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden pl-5 text-[11.5px] leading-4 text-ink-2">
            <span className="block pt-1">One model, Argon, reads your photo or poster and weighs your ask, the TfL travel times, the forecast and the venues together to pick. Our checks then test the pick; if it fails, Argon re-picks.</span>
          </motion.p>
        ) : null}
      </AnimatePresence>
    </motion.div>
  );
}

const HERO = "Where shall we meet?".split(" ");

function Hero() {
  return (
    <div className="relative mb-4 isolate">
      <div aria-hidden className="pointer-events-none absolute -inset-x-5 -top-6 bottom-[-12px] -z-10 overflow-hidden rounded-[22px]">
        <div className="sw-mesh" />
      </div>
      <h1 className="text-[28px] font-bold leading-[1.1] tracking-[-0.025em] text-ink" aria-label="Where shall we meet?">
        {HERO.map((w, i) => (
          <motion.span key={w + i} aria-hidden className="inline-block" initial={{ opacity: 0, y: 18, filter: "blur(4px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ delay: 0.25 + i * 0.07, type: "spring", stiffness: 320, damping: 24 }}>
            {i === HERO.length - 1 ? <span className="text-signal-ink">{w}</span> : w}
            {i < HERO.length - 1 ? "\u00a0" : ""}
          </motion.span>
        ))}
      </h1>
      <motion.p initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.6, duration: 0.45, ease: [0.22, 1, 0.36, 1] }} className="mt-1.5 flex items-center gap-1 text-[14.5px] leading-[22px] text-ink-2">
        Ask like you&apos;d text a friend. <InfoTip />
      </motion.p>
    </div>
  );
}

/** Loading: a little route being traced between two stops while the planner works. */
function RouteScan() {
  return (
    <div className="flex flex-col gap-2.5" aria-hidden>
      <div className="sw-glint relative h-[88px] overflow-hidden rounded-[16px] bg-white/60 shadow-e1 ring-1 ring-white/70">
        <svg viewBox="0 0 360 88" className="sw-scanroute absolute inset-0 h-full w-full" preserveAspectRatio="none">
          <path d="M24 64 C 90 64, 110 22, 180 24 S 270 66, 336 30" fill="none" stroke="var(--sw-control)" strokeWidth="3" strokeLinecap="round" />
          <path className="trace" d="M24 64 C 90 64, 110 22, 180 24 S 270 66, 336 30" fill="none" stroke="var(--sw-signal)" strokeWidth="3" strokeLinecap="round" />
          <circle cx="24" cy="64" r="6" fill="var(--sw-route-you)" stroke="#fff" strokeWidth="2.5" />
          <circle cx="336" cy="30" r="6" fill="var(--sw-route-them)" stroke="#fff" strokeWidth="2.5" />
        </svg>
        <span className="dot absolute left-0 top-0 size-3 rounded-full bg-signal shadow-[0_0_0_4px_rgba(255,107,44,.25)]" style={{ offsetPath: "path('M24 64 C 90 64, 110 22, 180 24 S 270 66, 336 30')" } as React.CSSProperties} />
      </div>
      <div className="sw-skel h-20 opacity-80" />
      <div className="sw-skel h-20 opacity-60" />
    </div>
  );
}

type Toast = { id: number; text: string };
type Turn = { id: number; role: "user" | "agent"; text: string; leaveBy?: LeaveBy | null };


/** Spoken line for a fresh plan: the top pick, its travel time and its "why here", kept short for the voice card. */
function planReply(next: PlanResultWithAgent) {
  const top = next.cards[0];
  if (!top) return next.headline;
  const them = top.legs.find((l) => l.who === "them")?.minutes;
  const you = top.legs.find((l) => l.who === "you")?.minutes;
  const mins = them != null && you != null ? ` You're ${you} minutes away, they're ${them}.` : you != null ? ` ${you} minutes from you.` : "";
  const why = top.why ? ` ${top.why.trim().replace(/([^.!?])$/, "$1.")}` : "";
  const more = next.cards.length > 1 ? ` I found ${next.cards.length} options; this is the best fit.` : "";
  return `${top.name}.${why}${mins}${more}`;
}

function agentReply(prev: PlanResultWithAgent | null, next: PlanResultWithAgent) {
  const top = next.cards[0];
  if (!top) return "Nothing matched that. Try another tweak.";
  const them = top.legs.find((l) => l.who === "them")?.minutes;
  const you = top.legs.find((l) => l.who === "you")?.minutes;
  const mins = them != null && you != null ? ` · you ${you}, them ${them} min` : you != null ? ` · ${you} min` : "";
  if (prev?.cards[0]?.id === top.id) return `Still ${top.name}: best fit${mins}.`;
  return `New top pick: ${top.name}${mins}.`;
}

/** Mic toggle. Hidden when the browser has no speech recognition. */
function MicButton({ listening, onClick, className, size = "md", busy, label }: { listening: boolean; onClick: () => void; className?: string; size?: "md" | "sm"; busy?: boolean; label?: string }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={busy}
      aria-busy={busy}
      aria-pressed={listening}
      aria-label={busy ? "Translating" : listening ? "Stop voice input" : label ?? "Speak your ask"}
      title={label}
      whileTap={{ scale: 0.9 }}
      className={cn(
        "sw-btn relative shrink-0 rounded-full transition-colors",
        size === "md" ? "size-11" : "size-10",
        listening ? "sw-mic-on bg-[linear-gradient(180deg,var(--sw-cta-a),var(--sw-cta-b))] text-white" : "text-ink-2 hover:bg-white/80 hover:text-ink",
        className
      )}
    >
      {busy ? (
        <Loader2 className="size-[18px] animate-spin text-signal-ink" aria-hidden />
      ) : listening ? (
        <span className="flex h-4 items-center gap-[3px]" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <motion.span key={i} className="w-[3px] rounded-full bg-white" animate={{ height: [5, 15, 7, 12, 5] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.12, ease: "easeInOut" }} />
          ))}
        </span>
      ) : (
        <Mic className="size-[18px]" aria-hidden />
      )}
    </motion.button>
  );
}

/** Opens the snap sheet ("Snap a place" | "Snap a poster"). Same footprint as the mic. */
function CameraButton({ open, onClick, size = "md" }: { open: boolean; onClick: () => void; size?: "md" | "sm" }) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-expanded={open}
      aria-label="Snap a place or poster"
      title="Snap a place or poster"
      whileTap={{ scale: 0.9 }}
      className={cn("sw-btn relative shrink-0 rounded-full transition-colors", size === "md" ? "size-11" : "size-10", open ? "bg-signal-soft text-signal-ink" : "text-ink-2 hover:bg-white/80 hover:text-ink")}
    >
      <Camera className="size-[18px]" aria-hidden />
    </motion.button>
  );
}

/** "Sending in a moment" after a voice ask, with a cancel. */
function PendingSend({ onCancel, ms }: { onCancel: () => void; ms: number }) {
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 4 }} className="mt-2 flex items-center gap-2 text-[12.5px] font-semibold text-ink-2">
      <span className="relative h-1.5 w-20 overflow-hidden rounded-full bg-sunk">
        <motion.span className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,var(--sw-cta-a),var(--sw-cta-b))]" initial={{ width: "0%" }} animate={{ width: "100%" }} transition={{ duration: ms / 1000, ease: "linear" }} />
      </span>
      Sending…
      <button type="button" onClick={onCancel} className="rounded-full px-2 py-0.5 text-ink underline-offset-2 hover:underline">Cancel</button>
    </motion.div>
  );
}

/** Light chat trail: what you asked, what changed. */
function Trail({ turns, typing }: { turns: Turn[]; typing?: boolean }) {
  if (!turns.length && !typing) return null;
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Conversation">
      <AnimatePresence initial={false}>
        {turns.slice(-6).map((t) => (
          <motion.li
            key={t.id}
            layout
            initial={{ opacity: 0, y: 10, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className={cn("flex", t.role === "user" ? "justify-end" : "justify-start")}
          >
            {t.role === "user" ? (
              <span className="max-w-[85%] rounded-[16px] rounded-br-[6px] bg-[linear-gradient(180deg,#fff1e4,#ffe3cc)] px-3 py-1.5 text-[13.5px] font-medium leading-5 text-[#4a2408] shadow-e1 ring-1 ring-[#ff9a3c]/25 whitespace-pre-line">{t.text}</span>
            ) : (
              <span className="flex max-w-[90%] items-start gap-1.5 rounded-[16px] rounded-bl-[6px] bg-white/85 px-3 py-1.5 text-[13.5px] leading-5 text-ink-2 shadow-e1 ring-1 ring-white/80">
                <Sparkles className="mt-[3px] size-3.5 shrink-0 text-signal" aria-hidden />
                <span className="min-w-0 whitespace-pre-line [overflow-wrap:anywhere]">
                  {t.text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim()}
                  {t.leaveBy ? <LeaveByChip lb={t.leaveBy} className="mt-1.5 flex w-fit whitespace-normal" /> : null}
                </span>
              </span>
            )}
          </motion.li>
        ))}
        {typing ? (
          <motion.li key="typing" layout initial={{ opacity: 0, y: 8, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.15 } }} transition={{ type: "spring", stiffness: 420, damping: 30 }} className="flex justify-start">
            <span role="status" aria-label="Agent is thinking" className="sw-typing inline-flex h-8 items-center gap-1 rounded-[16px] rounded-bl-[6px] bg-white/85 px-3.5 shadow-e1 ring-1 ring-white/80">
              <i /><i /><i />
            </span>
          </motion.li>
        ) : null}
      </AnimatePresence>
    </ol>
  );
}

/** Language picker next to the location chip. "auto" = typed text in any language is detected (English skips it);
 * "any" = the mic records and gemini-3.5-live-translate-preview translates; a named language sets the browser mic to it. */
const LANGS = [
  { id: "auto", label: "Auto", short: "Auto" },
  { id: "any", label: "Any language · voice translate", short: "Any language" },
  { id: "en", label: "English", short: "EN" },
  { id: "it", label: "Italiano", short: "IT" },
  { id: "es", label: "Español", short: "ES" },
  { id: "fr", label: "Français", short: "FR" },
  { id: "de", label: "Deutsch", short: "DE" },
  { id: "pt", label: "Português", short: "PT" },
  { id: "zh", label: "中文", short: "中文" },
  { id: "ja", label: "日本語", short: "日本語" },
] as const;
function LangPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const cur = LANGS.find((l) => l.id === value) ?? LANGS[0];
  return (
    <label className={cn("sw-chip relative min-h-9 shrink-0 cursor-pointer px-3 text-[12.5px] font-semibold max-lg:min-h-11", value !== "auto" && "bg-signal-soft")} title="Speak or type in your language">
      <Languages className={cn("size-3.5", value !== "auto" ? "text-signal-ink" : "text-ink-3")} aria-hidden />
      <span>{cur.short}</span>
      <select aria-label="Your language" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0">
        {LANGS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
      </select>
    </label>
  );
}
/** Client twin of the server's cheap check: a short follow-up like "Greenwich" needs no translation hint. */
const looksPlain = (t: string) => t.trim().split(/\s+/).length <= 2 && !/[^\x00-\x7f]/.test(t);
/** Web Speech wants zh-CN, not the TTS cmn-CN tag. */
const recogLang = (code?: string) => (code === "zh" ? "zh-CN" : (code && BCP47[code]) || "en-GB");

export function SoWhereApp() {
  const reduced = !!useReducedMotion();
  const { state, submit, showFixture } = usePlan();
  const [query, setQuery] = useState("");
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [you, setYou] = useState<{ lat: number; lng: number } | null>(null);
  const [locating, setLocating] = useState<"idle" | "busy" | "denied">("idle");
  const [sendOpen, setSendOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const [padding, setPadding] = useState<MapPadding>({ top: 90, right: 80, bottom: 90, left: 500 });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typeTimer = useRef<number | null>(null);
  const pulseTimer = useRef<number | null>(null);
  const [typing, setTyping] = useState(false);
  const [refining, setRefining] = useState(false);
  const [shown, setShown] = useState<PlanResultWithAgent | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  // Floating voice card for the latest follow-up reply (the chat trail keeps the text bubble too).
  const [voice, setVoice] = useState<VoiceReply | null>(null);
  // Any language: the picker, the language the conversation is in (sticky across follow-ups), and the demo reply.
  const [lang, setLangState] = useState<string>("auto");
  useEffect(() => {
    const v = window.localStorage.getItem("sw-lang");
    if (v && LANGS.some((l) => l.id === v)) setLangState(v);
  }, []);
  const setLang = useCallback((v: string) => {
    setLangState(v);
    try { window.localStorage.setItem("sw-lang", v); } catch {}
  }, []);
  const talkLang = useRef<(Translated & { heardBy?: string }) | null>(null);
  const [talkCode, setTalkCode] = useState<string | null>(null);
  const demoReply = useRef<string | null>(null);
  const voiceSeq = useRef(0);
  const langHint = lang === "any" ? "auto" : lang;
  const focusName = useRef<string | undefined>(undefined);
  const [wide, setWide] = useState(false);
  // Mobile voice card floats above the composer dock. It lives in a portal (fixed to the viewport):
  // nested inside the dock, whose backdrop blur makes it a backdrop root, the sheet text showed through.
  const dockRef = useRef<HTMLDivElement>(null);
  const [dockGap, setDockGap] = useState(150);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  useEffect(() => {
    if (wide || !voice) return;
    const el = dockRef.current;
    if (!el) return;
    const measure = () => setDockGap(Math.max(80, Math.round(window.innerHeight - el.getBoundingClientRect().top + 10)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => { ro.disconnect(); window.removeEventListener("scroll", measure); window.removeEventListener("resize", measure); };
  }, [wide, voice]);
  const liveStates = useRef<Record<string, string>>({});
  const [liveOn, setLiveOn] = useState(false);
  const liveState = useMemo(() => {
    const mk = (k: string) => (s: string) => {
      liveStates.current[k] = s;
      setLiveOn(Object.values(liveStates.current).some((v) => v !== "idle"));
    };
    return { ask: mk("ask"), chat: mk("chat") };
  }, []);
  const [chat, setChat] = useState("");
  // Poster snap: which composer it opened from, and the ask it produced (for the "From your photo" chip).
  const [snap, setSnap] = useState<null | "ask" | "chat">(null);
  const [photoAsk, setPhotoAsk] = useState<string | null>(null);
  // Snap a place: which tab the sheet shows, the matched place (map + detail), the friend draft, demo id.
  const [snapMode, setSnapMode] = useState<SnapMode>("place");
  const [placeSnap, setPlaceSnap] = useState<SnapView | null>(null);
  const [friendOpen, setFriendOpen] = useState(false);
  const [snapDemo, setSnapDemo] = useState<string | null>(null);
  const snapRef = useRef<HTMLDivElement>(null);
  // Bring the poster panel into view when it opens (it sits below the fold on phones).
  useEffect(() => {
    if (!snap) return;
    const show = () => snapRef.current?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
    const t = window.setTimeout(show, 280);
    // …and again when it grows (scanning → found card), so the next step is never below the fold.
    let h = 0;
    const ro = new ResizeObserver(([e]) => {
      const nh = Math.round(e.contentRect.height);
      if (h && nh > h + 8) show();
      h = nh;
    });
    const el = snapRef.current;
    if (el) ro.observe(el);
    return () => {
      window.clearTimeout(t);
      ro.disconnect();
    };
  }, [snap, reduced]);
  const [pending, setPending] = useState<null | "ask" | "chat" | "clarify">(null);
  const pendingTimer = useRef<number | null>(null);
  const baseAsk = useRef("");
  const awaitingReply = useRef(false);
  const toastTimer = useRef<number | null>(null);
  const say = useCallback((text: string) => {
    setToast({ id: Date.now(), text });
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  /** Show (and speak) a reply, in the conversation's language when the ask wasn't English. Venue names stay as-is;
   * drafts to the friend are untouched (English). Falls back to the English reply if translation fails. */
  const voiceOut = useCallback((v: VoiceReply, turnId?: number) => {
    const my = ++voiceSeq.current;
    const tr = talkLang.current;
    if (!tr || tr.lang === "en") return setVoice(v);
    const done = (text: string, model: string) => {
      if (voiceSeq.current !== my) return;
      setVoice({ ...v, text, english: v.text, lang: tr.lang, langName: tr.langName, model, heardBy: tr.heardBy ?? tr.model });
      if (turnId != null) setTurns((t) => t.map((x) => (x.id === turnId ? { ...x, text } : x)));
    };
    if (demoReply.current) return done(demoReply.current, tr.model);
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 5000);
    fetch("/api/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: v.text, to: tr.lang }), signal: ac.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { text?: string; model?: string } | null) => (j?.text && j.model ? done(j.text, j.model) : voiceSeq.current === my && setVoice(v)))
      .catch(() => voiceSeq.current === my && setVoice(v))
      .finally(() => window.clearTimeout(timer));
  }, []);

  // Glow while text is going in (typed by hand or by a suggestion chip).
  const pulse = useCallback(() => {
    setTyping(true);
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
    pulseTimer.current = window.setTimeout(() => setTyping(false), 700);
  }, []);

  const stopTyping = useCallback(() => {
    if (typeTimer.current) window.clearInterval(typeTimer.current);
    typeTimer.current = null;
  }, []);

  // Suggestion chips type their ask into the box (instant with reduced motion).
  const typeIn = useCallback(
    (text: string) => {
      stopTyping();
      inputRef.current?.focus();
      if (reduced) {
        setQuery(text);
        return;
      }
      let i = 0;
      const step = Math.max(2, Math.ceil(text.length / 38));
      setQuery("");
      typeTimer.current = window.setInterval(() => {
        i = Math.min(text.length, i + step);
        setQuery(text.slice(0, i));
        pulse();
        if (i >= text.length) stopTyping();
      }, 16);
    },
    [reduced, stopTyping, pulse]
  );

  useEffect(() => () => {
    stopTyping();
    if (pulseTimer.current) window.clearTimeout(pulseTimer.current);
  }, [stopTyping]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  // Grow the ask box with its text (max ~5 lines).
  useEffect(() => {
    const ta = inputRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 132)}px`;
  }, [query]);

  const { result, status } = state;

  useEffect(() => {
    const demo = new URLSearchParams(window.location.search).get("demo");
    if (demo === "meet" || demo === "saturday" || demo === "repick") {
      showFixture(demo as FixtureId);
      setQuery(demo === "saturday" ? CHIPS[3].ask : CHIPS[0].ask);
      setActiveChip(demo === "saturday" ? "walkin" : "meet");
    } else if (demo === "place" || demo === "place-candidates" || demo === "place-nomatch" || demo === "place-landmark") {
      setSnapDemo(demo);
      setSnapMode("place");
      setSnap("ask");
    } else if (demo === "translate") {
      // Italian ask on the meet fixture: translate step, Italian voice card, all offline (example data).
      demoReply.current = translateDemo.reply;
      showFixture("meet", { display: translateDemo.display, lead: translateDemo.lead, translated: translateDemo.translated });
      setQuery(translateDemo.display);
    } else if (demo === "clarify") {
      setQuery(CHIPS[1].ask);
      setActiveChip("coffee");
      submit(CHIPS[1].ask);
    }
    const onResize = () => {
      const wide = window.innerWidth >= 1024;
      setMobile(window.innerWidth < 768);
      setWide(wide);
      setPadding(wide ? { top: 110, right: 90, bottom: 90, left: 500 } : { top: 110, right: 56, bottom: 36, left: 36 });
    };
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [showFixture, submit]);

  useEffect(() => {
    // The server's own failure fallback (no cards) never replaces a plan on screen; the error effect reports it.
    if (result && !result.cards.length && /^Sorry, I couldn.t plan/i.test(result.headline)) return;
    setSelectedId(result?.cards[0]?.id ?? null);
    setDetailId(null);
    if (result) {
      // Conversation language: a fresh ask sets it; a follow-up keeps it unless the server translated a new language.
      if (state.translated) talkLang.current = { ...state.translated, heardBy: talkLang.current?.lang === state.translated.lang && talkLang.current.heardBy && !awaitingReply.current ? talkLang.current.heardBy : state.translated.model };
      else if (!awaitingReply.current) talkLang.current = null;
      setTalkCode(talkLang.current?.lang ?? null);
      if (awaitingReply.current) {
        awaitingReply.current = false;
        const text = state.reply || agentReply(shown, result);
        const id = Date.now();
        setTurns((t) => [...t, { id, role: "agent", text, leaveBy: leaveByOf(result) }]);
        voiceOut({ id, text, leaveBy: leaveByOf(result), place: focusName.current, autoplay: true }, id);
      } else if (result.cards.length) {
        // Every fresh answer gets the voice card too, not just follow-ups.
        voiceOut({ id: Date.now(), text: planReply(result), leaveBy: leaveByOf(result), place: result.cards[0]?.name, autoplay: true });
      }
      setShown(result);
      if (refining) say("Picks updated");
    }
    if (status !== "running") setRefining(false);
    // A new plan only (resultSeq), not late blurbs merged into the same one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.resultSeq]);
  // Late blurbs fill in the plan on screen without resetting the selection or open detail.
  useEffect(() => {
    if (result && status === "result" && result.cards.length) setShown(result);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);
  useEffect(() => {
    if (status === "clarify" || status === "idle" || status === "error") setRefining(false);
    if (status === "error" && awaitingReply.current) {
      awaitingReply.current = false;
      setTurns((t) => [...t, { id: Date.now(), role: "agent", text: "Sorry, that didn't go through. The plan above is unchanged; try again." }]);
    }
    if (status === "clarify" && state.translated) {
      talkLang.current = state.translated;
      setTalkCode(state.translated.lang);
    }
    if (status === "clarify" && awaitingReply.current) {
      awaitingReply.current = false;
      if (state.reply) {
        const id = Date.now();
        setTurns((t) => [...t, { id, role: "agent", text: state.reply! }]);
        voiceOut({ id, text: state.reply, autoplay: true }, id);
      }
    }
    else if (status === "clarify" && state.clarify?.question) voiceOut({ id: Date.now(), text: state.clarify.question, autoplay: true });
  }, [status]);

  const ask = useCallback(
    (q: string, heard?: HeardTranslation) => {
      stopTyping();
      const text = q.trim();
      if (!text) return;
      demoReply.current = null;
      if (!heard) talkLang.current = null;
      setRefining(false);
      setShown(null);
      setTurns([]);
      setVoice(null);
      setPhotoAsk(null);
      setPlaceSnap(null);
      awaitingReply.current = false;
      if (heard && heard.lang !== "en") {
        // Spoken in another language: plan the English, keep their words on screen.
        baseAsk.current = heard.original;
        talkLang.current = { lang: heard.lang, langName: heard.langName, model: heard.model, heardBy: heard.model };
        submit(heard.english, undefined, you ?? undefined, { display: heard.original, translated: { lang: heard.lang, model: heard.model, ms: heard.ms } });
        return;
      }
      baseAsk.current = heard ? heard.english : text;
      // English and "Auto" send exactly what they always did; a picked language rides along as a hint.
      submit(heard ? heard.english : text, undefined, you ?? undefined, langHint !== "auto" ? { lang: langHint } : undefined);
    },
    [submit, you, stopTyping, langHint]
  );

  // While a question is open, text typed in the main box ("greenwich") answers it, keeping the original ask
  // (previous:{query, answer}); a rewritten full ask still starts fresh.
  const answerClarify = useCallback(
    (answer: string) => submit(answer, { query: state.ask || state.query, answer }, you ?? undefined, { display: baseAsk.current || state.query, ...(langHint !== "auto" ? { lang: langHint } : talkLang.current ? { lang: talkLang.current.lang } : {}) }),
    [submit, state.ask, state.query, you, langHint]
  );
  const askOrAnswer = useCallback(
    (q: string) => {
      const text = q.trim();
      const base = baseAsk.current.trim();
      if (status === "clarify" && state.clarify && text && base && text !== base && !text.startsWith(base) && !base.startsWith(text)) {
        stopTyping();
        answerClarify(text);
        setQuery(base);
        return;
      }
      ask(q);
    },
    [status, state.clarify, answerClarify, ask, stopTyping]
  );

  const snapPlan = useCallback(
    (q: string) => {
      setSnap(null);
      setQuery(q);
      setActiveChip(null);
      ask(q);
      setPhotoAsk(q.trim());
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      if (window.innerWidth < 1024) window.scrollTo({ top: 0, behavior: "smooth" });
    },
    [ask]
  );
  // A matched place: fly there, light the building, open the detail (any plan detail closes).
  const onPlaceMatch = useCallback((v: SnapView) => {
    setDetailId(null);
    setPlaceSnap(v);
    if (window.innerWidth < 768) window.scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  }, [reduced]);
  // "Meet here": the suggested ask goes through the normal plan flow; if there's no friend info, the planner asks.
  const meetHere = useCallback((nearby?: boolean) => {
    if (!placeSnap) return;
    const q = nearby === true ? placeSnap.nearbyQuery : placeSnap.query;
    setSnap(null);
    setSnapDemo(null);
    setQuery(q);
    setActiveChip(null);
    ask(q);
    setPhotoAsk(q);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [placeSnap, ask]);
  const snapEdit = useCallback((q: string) => {
    setSnap(null);
    setQuery(q);
    setActiveChip(null);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.setTimeout(() => {
      const ta = inputRef.current;
      ta?.focus();
      ta?.setSelectionRange(q.length, q.length);
    }, 60);
  }, []);

  const locate = useCallback(() => {
    if (you) {
      setYou(null);
      return;
    }
    if (!("geolocation" in navigator)) return setLocating("denied");
    setLocating("busy");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        // Rounded to ~100 m before it leaves this function; sent with the ask, never stored.
        const r = (n: number) => Math.round(n * 1000) / 1000;
        setYou({ lat: r(p.coords.latitude), lng: r(p.coords.longitude) });
        setLocating("idle");
        say("Location on · rounded to ~100 m");
      },
      () => setLocating("denied"),
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
    );
  }, [you, say]);

  const refine = useCallback(
    (extra: string, label?: string, heard?: HeardTranslation) => {
      const text = extra.trim();
      if (!text) return;
      if (!baseAsk.current) baseAsk.current = state.query || query;
      // Server refine mode: send only the short refinement + the accumulated query from the last result.
      const prev = state.ask || state.result?.query || baseAsk.current;
      if (!prev) return;
      // Focus = the place the follow-up is about: the open detail card, else the top card.
      const cards = (state.result ?? shown)?.cards ?? [];
      const fc = cards.find((c) => c.id === detailId) ?? cards[0];
      const focus = fc ? { id: fc.id, name: fc.name, lat: fc.location.lat, lng: fc.location.lng } : undefined;
      setRefining(true);
      setDetailId(null);
      setVoice(null);
      focusName.current = fc?.name;
      primeVoice(); // inside the user's send, so the spoken reply may autoplay
      setTurns((t) => [...t, { id: Date.now(), role: "user", text: label ?? text }]);
      awaitingReply.current = true;
      const any = heard && heard.lang !== "en" ? { translated: { lang: heard.lang, model: heard.model, ms: heard.ms } } : langHint !== "auto" ? { lang: langHint } : talkLang.current && !looksPlain(text) ? { lang: talkLang.current.lang } : {};
      if (heard && heard.lang !== "en") talkLang.current = { lang: heard.lang, langName: heard.langName, model: heard.model, heardBy: heard.model };
      submit(text, undefined, you ?? undefined, { refine: prev, display: baseAsk.current, focus, result: state.result ?? shown, ...any });
      scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    },
    [state.query, state.ask, state.result, shown, detailId, query, submit, you, langHint]
  );

  // Voice: fill the box live; after a final result, send after a short pause unless cancelled.
  const voiceTarget = useRef<"ask" | "chat" | "clarify">("ask");
  const [clarifyHeard, setClarifyHeard] = useState("");
  const cancelPending = useCallback(() => {
    if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
    pendingTimer.current = null;
    setPending(null);
  }, []);
  const PENDING_MS = 1600;
  const speech = useSpeech({
    onText: (t) => (voiceTarget.current === "chat" ? setChat(t) : voiceTarget.current === "clarify" ? setClarifyHeard(t) : setQuery(t)),
    onFinal: (t) => {
      const target = voiceTarget.current;
      setPending(target);
      if (pendingTimer.current) window.clearTimeout(pendingTimer.current);
      pendingTimer.current = window.setTimeout(() => {
        setPending(null);
        if (target === "chat") {
          setChat("");
          refine(t);
        } else if (target === "clarify") {
          setClarifyHeard("");
          answerClarify(t);
        } else askOrAnswer(t);
      }, PENDING_MS);
    },
    onError: (m) => say(m),
    // Follows the picker, else the language the conversation is in (Auto), else English.
    lang: lang !== "auto" && lang !== "any" ? recogLang(lang) : recogLang(talkCode ?? "en"),
  });
  // "Any language": one spoken ask → gemini-3.5-live-translate-preview → English plan, their words on screen.
  const tmicTarget = useRef<"ask" | "chat">("ask");
  const tmic = useTranslateMic({
    onResult: (r) => {
      if (tmicTarget.current === "chat") {
        refine(r.english, r.original, r);
      } else {
        setQuery(r.original);
        setActiveChip(null);
        primeVoice();
        ask(r.english, r);
      }
    },
    onError: (m) => say(m),
  });
  const translateMic = (target: "ask" | "chat") => () => {
    cancelPending();
    speech.stop();
    tmicTarget.current = target;
    if (tmic.state === "idle") say("Speak in any language…");
    tmic.toggle();
  };
  const mic = (target: "ask" | "chat" | "clarify") => () => {
    cancelPending();
    voiceTarget.current = target;
    speech.toggle();
  };
  useEffect(() => () => { if (pendingTimer.current) window.clearTimeout(pendingTimer.current); }, []);

  const openDetail = useCallback((id: string) => {
    setSelectedId(id);
    setDetailId(id);
    // Phones: bring the map back into view above the sheet.
    if (window.innerWidth < 768) window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  const closeDetail = useCallback(() => setDetailId(null), []);

  const select = useCallback((id: string) => openDetail(id), [openDetail]);

  const change = () => {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    window.scrollTo({ top: 0, behavior: "smooth" });
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  // While a follow-up chip re-asks, keep the previous picks on screen (dimmed) so new results can animate into place.
  // A failed follow-up keeps the plan that was on screen (shown); a failed new ask has none (ask() clears it).
  const view = status === "result" ? result : refining ? shown : status === "error" && shown?.cards.length ? shown : null;
  // A halfway plan on screen: the poster becomes "meet halfway for <event>" with the same two people.
  const snapContext = view && view.intent === "meet_halfway" && view.middle ? { query: state.ask || view.query || baseAsk.current } : null;
  const selected = result?.cards.find((c) => c.id === selectedId) ?? result?.cards[0];
  const detail = result?.cards.find((c) => c.id === detailId) ?? null;
  const finished = status === "result" || status === "clarify";
  const mapResult = placeSnap?.result ?? result ?? (refining ? shown : null);
  const panelOpen = !!(placeSnap || detail);
  // ui24: the loading radar flies to the places named in a fresh ask (bundled station list, in the browser only); the
  // server's English replaces the first guess when it arrives. Follow-ups keep the map where it is.
  const [scanFocus, setScanFocus] = useState<ScanFocus | null>(null);
  const scanSrc = status === "running" && !refining && !placeSnap ? state.scanText ?? state.ask ?? state.query : "";
  useEffect(() => {
    if (!scanSrc) return setScanFocus(null);
    let live = true;
    import("@/lib/scan-places").then(({ scanPlaces, scanMiddle }) => {
      if (!live) return;
      const places = scanPlaces(scanSrc);
      // Keep the first guess if the English names fewer places (never fly away to nothing).
      setScanFocus((prev) => (places.length || !prev ? { places, middle: scanMiddle(places) } : prev));
    }).catch(() => {});
    return () => {
      live = false;
    };
  }, [scanSrc]);
  const liveTools = useLiveTools({ state, view: view ?? result ?? null, selectedId: detailId ?? selectedId, ask: askOrAnswer, refine, openDetail, openSend: () => { setSendOpen(true); say("Draft ready · nothing is sent"); } });

  return (
    <MotionConfig reducedMotion="user">
      <main className={cn("relative min-h-dvh bg-ground lg:h-dvh lg:overflow-hidden", panelOpen && !mobile && "sw-detail-open")}>
        <Header example={state.example || !!placeSnap?.example} reason={state.exampleReason} className="sticky top-0 z-20 bg-ground/75 px-4 py-3 backdrop-blur-xl backdrop-saturate-150 lg:hidden" />

        {/* Map: on top on phones, full-bleed behind the panel on desktop */}
        <div className="relative h-[46svh] min-h-[300px] overflow-hidden lg:absolute lg:inset-0 lg:h-auto">
          <PlanMap result={mapResult} selectedId={placeSnap ? placeSnap.card.id : selectedId} hoverId={hoverId} focusId={placeSnap ? placeSnap.card.id : detailId} scanning={status === "running" && !placeSnap} scanFocus={scanFocus} onSelect={placeSnap ? () => {} : select} onHover={setHoverId} padding={panelOpen && !mobile ? { ...padding, right: 420 } : padding} reduced={reduced} deviceYou={you} />
          <div className={cn("pointer-events-none absolute right-3 top-3 z-10 transition-[right] duration-500 max-sm:right-2 max-sm:top-2 max-sm:origin-top-right max-sm:scale-[.92] lg:right-4 lg:top-4", panelOpen && !mobile && "md:right-[412px] lg:right-[412px]")}>
            <MapChips result={mapResult} cardId={placeSnap ? placeSnap.card.id : detailId ?? selectedId} />
          </div>
          {state.example ? (
            <div className="pointer-events-none absolute bottom-4 left-[476px] z-10 hidden lg:block">
              <span className="sw-glass-chip inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-[12px] font-semibold text-likely shadow-e3 ring-1 ring-white/70">
                <FlaskConical className="size-3.5" aria-hidden /> Example<span className="max-sm:hidden"> data</span> · not live
              </span>
            </div>
          ) : null}
        </div>

        {/* Plan panel */}
        <motion.aside
          initial={{ opacity: 0, x: -28, scale: 0.985 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          transition={{ type: "spring", stiffness: 220, damping: 28, delay: 0.05 }}
          className="sw-glass relative z-10 -mt-5 flex flex-col rounded-t-[22px] lg:absolute lg:bottom-4 lg:left-4 lg:top-4 lg:mt-0 lg:w-[444px] lg:rounded-[22px]"
        >
          <div ref={scrollRef} className="flex-1 px-4 pb-6 pt-4 lg:overflow-y-auto lg:px-5 lg:pt-5">
            <Header example={state.example || !!placeSnap?.example} reason={placeSnap?.example ? "demo link" : state.exampleReason} className="mb-5 hidden lg:flex" />

            {status === "idle" ? <Hero /> : null}

            {/* Ask */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                askOrAnswer(query);
              }}
            >
              <div className="-mx-1 mb-2.5 flex flex-wrap gap-1.5 px-1" role="group" aria-label="Quick starts">
                {CHIPS.map((c, ci) => {
                  const on = activeChip === c.id;
                  return (
                    <motion.button
                      key={c.id}
                      initial={{ opacity: 0, y: 10, scale: 0.92 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ delay: 0.35 + ci * 0.06, type: "spring", stiffness: 420, damping: 26 }}
                      type="button"
                      disabled={status === "running"}
                      onClick={() => {
                        setActiveChip(c.id);
                        typeIn(c.ask);
                      }}
                      aria-pressed={on}
                      className="sw-chip min-h-9 px-3 text-[13px] font-medium max-lg:min-h-11"
                    >
                      {on ? <motion.span layoutId="chip-on" className="absolute inset-0 -z-10 rounded-full bg-signal-soft" transition={{ type: "spring", stiffness: 500, damping: 36 }} /> : null}
                      <c.Icon className={cn("size-4 transition-colors", on ? "text-signal-ink" : "text-ink-3")} aria-hidden />
                      <span>{c.label}</span>
                    </motion.button>
                  );
                })}
                <motion.button
                  initial={{ opacity: 0, y: 10, scale: 0.92 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ delay: 0.35 + CHIPS.length * 0.06, type: "spring", stiffness: 420, damping: 26 }}
                  type="button"
                  disabled={status === "running"}
                  onClick={() => {
                    setSnapMode("place");
                    setSnap((v) => (v === "ask" && snapMode === "place" ? null : "ask"));
                  }}
                  aria-expanded={snap === "ask"}
                  className={cn("sw-chip min-h-9 px-3 text-[13px] font-medium max-lg:min-h-11", snap === "ask" && "bg-signal-soft")}
                >
                  <Camera className={cn("size-4 transition-colors", snap === "ask" ? "text-signal-ink" : "text-ink-3")} aria-hidden />
                  <span>Snap a place</span>
                </motion.button>
              </div>
              <motion.div layout="size" className={cn("sw-field flex items-end gap-2 p-1.5 pl-3.5", typing && "is-typing")}>
                <label htmlFor="ask" className="sr-only">Your ask</label>
                <textarea
                  id="ask"
                  ref={inputRef}
                  value={query}
                  rows={2}
                  onChange={(e) => {
                    stopTyping();
                    setQuery(e.target.value);
                    setActiveChip(null);
                    pulse();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      askOrAnswer(query);
                    }
                  }}
                  placeholder="Date Thursday at 7, I'm at Old Street, she's around Clapham…"
                  className="min-h-[52px] flex-1 resize-none bg-transparent py-2 text-[16px] leading-6 text-ink caret-signal transition-[height] duration-200 placeholder:text-ink-3 focus:outline-none"
                />
                <CameraButton open={snap === "ask"} onClick={() => setSnap((v) => (v === "ask" ? null : "ask"))} />
                {lang === "any" && tmic.supported ? <MicButton listening={tmic.state === "listening" && tmicTarget.current === "ask"} busy={tmic.state === "translating" && tmicTarget.current === "ask"} label="Speak in any language" onClick={translateMic("ask")} /> : lang !== "auto" && lang !== "en" && lang !== "any" && speech.supported ? <MicButton listening={speech.listening && voiceTarget.current === "ask"} onClick={mic("ask")} /> : LIVE_VOICE ? <LiveVoiceButton onStateChange={liveState.ask} onTool={liveTools.onTool} context={liveTools.context} onFallback={speech.supported ? mic("ask") : undefined} fallbackListening={speech.listening && voiceTarget.current === "ask"} /> : speech.supported ? <MicButton listening={speech.listening && voiceTarget.current === "ask"} onClick={mic("ask")} /> : null}
                <motion.button
                  type="submit"
                  disabled={!query.trim() || status === "running"}
                  aria-busy={status === "running"}
                  aria-label="Plan it"
                  animate={{ scale: query.trim() || status === "running" ? 1 : 0.9 }}
                  whileHover={query.trim() && status !== "running" ? { scale: 1.06 } : undefined}
                  whileTap={{ scale: 0.92 }}
                  transition={{ type: "spring", stiffness: 520, damping: 26 }}
                  className="sw-btn sw-btn-primary size-11 shrink-0 rounded-[12px] transition-[box-shadow,background-color,color] "
                >
                  {status === "running" ? <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden /> : <ArrowRight className="size-5" aria-hidden />}
                </motion.button>
              </motion.div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={locate}
                  aria-pressed={!!you}
                  aria-busy={locating === "busy"}
                  className={cn("sw-chip min-h-9 shrink-0 px-3 text-[12.5px] font-semibold max-lg:min-h-11", you && "bg-signal-soft")}
                >
                  {locating === "busy" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <LocateFixed className={cn("size-3.5", you ? "text-signal-ink" : "text-ink-3")} aria-hidden />}
                  {you ? "Using your location · ~100 m" : "Use my location"}
                  {you ? <X className="size-3.5" aria-label="Stop using location" /> : null}
                </button>
                <LangPicker value={lang} onChange={setLang} />
                {locating === "denied" ? <span className="text-[11.5px] leading-4 text-ink-3">Location blocked: name a station.</span> : null}
              </div>
              <AnimatePresence>{pending === "ask" ? <PendingSend ms={PENDING_MS} onCancel={cancelPending} /> : null}</AnimatePresence>
            </form>
            <AnimatePresence initial={false}>
              {snap === "ask" ? (
                <motion.div key="snap-ask" ref={snapRef} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduced ? 0 : 0.25, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                  <SnapSheet className="mt-3" mode={snapMode} onMode={setSnapMode} poster={{ onPlan: snapPlan, onEdit: snapEdit, context: snapContext }} place={{ you, demo: snapDemo, onMatch: onPlaceMatch }} />
                </motion.div>
              ) : null}
            </AnimatePresence>

            {/* Live steps */}
            <div className="mt-4 flex flex-col gap-4">
              {/* Live timeline while working; once results are in, the strip moves below the cards (quiet). */}
              {state.steps.length && status !== "error" && !(finished && view) ? <AgentSteps steps={state.steps} finished={finished} elapsedMs={state.elapsedMs} /> : null}
              {/* ui24: never a silent wait: a "Starting" row until the first step arrives (stall → error box below). */}
              {status === "running" && !state.steps.length && !refining ? <AgentSteps steps={[{ id: "start", label: "Starting", status: "running", detail: scanFocus?.places.length ? `Looking around ${scanFocus.places.map((p) => p.name).join(" and ")}` : undefined }]} finished={false} elapsedMs={0} /> : null}

              {status === "clarify" && state.clarify ? <ClarifyBox clarify={state.clarify} onAnswer={answerClarify} onLocate={state.clarify.missing === "my_location" && !you ? locate : undefined} heard={clarifyHeard} listening={speech.listening && voiceTarget.current === "clarify"} mic={speech.supported ? <MicButton listening={speech.listening && voiceTarget.current === "clarify"} onClick={mic("clarify")} className="rounded-[12px] bg-white/70 ring-1 ring-black/5" /> : null} /> : null}

              {view ? <Trail turns={turns} typing={refining && status === "running"} /> : null}
              {view ? (
                <motion.div key="results" className="flex flex-col gap-4" initial={{ opacity: 0 }} animate={{ opacity: refining && status === "running" ? 0.55 : 1 }} transition={{ duration: 0.3 }} aria-busy={status === "running"}>
                  <Blind key={view.headline} result={view} photo={!!photoAsk && baseAsk.current === photoAsk} />
                  <Filters f={view.filters} />

                  <div ref={(n) => { if (n) cardRefs.current.set("__results", n); }} className="scroll-mt-20 lg:scroll-mt-4">
                    <LayoutGroup>
                      <motion.div key="list" layout className="flex flex-col gap-3">
                        {view.cards.slice(0, 3).map((c, i) => (
                          <PlanCard key={c.id} card={c} index={i} when={view.when} blurbPending={state.blurbsPending && status === "result"} selected={c.id === (detailId ?? selected?.id)} hovered={c.id === hoverId} onOpen={() => openDetail(c.id)} onHover={(on) => setHoverId(on ? c.id : null)} />
                        ))}
                        {!view.cards.length ? <p className="rounded-[14px] bg-tint p-4 text-[14px] text-ink-2 shadow-e1">Nothing matched. Try a wider area or a different time.</p> : null}
                      </motion.div>
                    </LayoutGroup>
                  </div>

                  <FollowUps intent={view.intent} onRefine={(ask, label) => refine(ask, label)} disabled={status === "running"} />

                  {view.unknowns.length ? (
                    <section aria-label="Couldn't check" className="rounded-[14px] border border-dashed border-control bg-raised/60 p-3.5">
                      <h3 className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-3">Couldn&apos;t check</h3>
                      <ul className="mt-1.5 flex flex-col gap-1">
                        {view.unknowns.map((u) => (
                          <li key={u} className="flex items-start gap-2 text-[13px] leading-5 text-ink-2">
                            <HelpCircle className="mt-0.5 size-3.5 shrink-0 text-unknown" aria-hidden />
                            {u}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ) : null}

                  {finished && state.steps.length ? <AgentSteps quiet steps={state.steps} finished elapsedMs={state.elapsedMs} /> : null}

                  <footer className="text-[11.5px] leading-[17px] text-ink-3">
                    <p className="num font-mono">
                      {view.sources.map((s) => `${s.name} ${fmtAsOf(s.asOf)}`).join(" · ")}
                    </p>
                    <p className="mt-1">Map data © OpenStreetMap contributors · tiles OpenFreeMap · Powered by TfL Open Data · Weather: Open-Meteo (CC BY 4.0)</p>
                  </footer>
                </motion.div>
              ) : null}

              {status === "error" && state.error && !view ? (
                <motion.div role="alert" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex items-start gap-3 rounded-[16px] bg-tint/80 p-4 shadow-e1 ring-1 ring-line/70">
                  <Info className="mt-0.5 size-4 shrink-0 text-signal-ink" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-[14.5px] font-semibold leading-5 text-ink">{state.error}</p>
                    <p className="mt-0.5 text-[12.5px] leading-[18px] text-ink-3">Nothing was saved or sent.</p>
                  </div>
                  <button type="button" onClick={() => ask(baseAsk.current || query)} className="sw-btn sw-btn-quiet min-h-10 shrink-0 rounded-[10px] px-3 text-[13.5px] font-semibold">
                    Try again
                  </button>
                </motion.div>
              ) : null}

              {status === "running" && !refining ? <RouteScan /> : null}
            </div>
          </div>

          {/* Composer + action bar */}
          <AnimatePresence>
            {view && !(panelOpen && mobile) ? (
              <motion.div
                key="dock"
                ref={dockRef}
                initial={{ y: 24, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: 24, opacity: 0 }}
                transition={{ delay: 0.3, duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
                className="sticky bottom-0 z-20 flex flex-col gap-2 border-t border-white/70 bg-white/85 px-4 py-3 shadow-[0_-10px_24px_-18px_rgba(74,52,30,0.35)] backdrop-blur-xl backdrop-saturate-150 lg:rounded-b-[22px] lg:px-5"
              >
                {!wide && hydrated
                  ? createPortal(
                      <div className="pointer-events-none fixed inset-x-3 z-[60] flex justify-center" style={{ bottom: dockGap }}>
                        <VoiceCardSlot reply={voice} live={liveOn} onClose={() => setVoice(null)} />
                      </div>,
                      document.body,
                    )
                  : null}
                <AnimatePresence initial={false}>
                  {snap === "chat" ? (
                    <motion.div key="snap-chat" ref={snapRef} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: reduced ? 0 : 0.25, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
                      <SnapSheet mode={snapMode} onMode={setSnapMode} poster={{ onPlan: snapPlan, onEdit: snapEdit, context: snapContext }} place={{ you, demo: snapDemo, onMatch: onPlaceMatch }} />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!chat.trim() || status === "running") return;
                    cancelPending();
                    refine(chat);
                    setChat("");
                  }}
                  className={cn("sw-field flex items-center gap-1 p-1 pl-3.5", speech.listening && voiceTarget.current === "chat" && "is-typing")}
                >
                  <label htmlFor="chat" className="sr-only">Refine the plan</label>
                  <input
                    id="chat"
                    value={chat}
                    onChange={(e) => { setChat(e.target.value); cancelPending(); }}
                    placeholder={speech.listening && voiceTarget.current === "chat" ? "Listening…" : "Cheaper, quieter, make it 8pm…"}
                    autoComplete="off"
                    enterKeyHint="send"
                    className="min-w-0 flex-1 bg-transparent py-2 text-[16px] leading-6 text-ink caret-signal placeholder:text-ink-3 focus:outline-none"
                  />
                  <CameraButton size="sm" open={snap === "chat"} onClick={() => setSnap((v) => (v === "chat" ? null : "chat"))} />
                  {lang === "any" && tmic.supported ? <MicButton size="sm" listening={tmic.state === "listening" && tmicTarget.current === "chat"} busy={tmic.state === "translating" && tmicTarget.current === "chat"} label="Speak in any language" onClick={translateMic("chat")} /> : lang !== "auto" && lang !== "en" && lang !== "any" && speech.supported ? <MicButton size="sm" listening={speech.listening && voiceTarget.current === "chat"} onClick={mic("chat")} /> : LIVE_VOICE ? <LiveVoiceButton size="sm" onStateChange={liveState.chat} onTool={liveTools.onTool} context={liveTools.context} onFallback={speech.supported ? mic("chat") : undefined} fallbackListening={speech.listening && voiceTarget.current === "chat"} /> : speech.supported ? <MicButton size="sm" listening={speech.listening && voiceTarget.current === "chat"} onClick={mic("chat")} /> : null}
                  <motion.button
                    type="submit"
                    disabled={!chat.trim() || status === "running"}
                    aria-label="Send to agent"
                    aria-busy={status === "running"}
                    whileTap={{ scale: 0.9 }}
                    className="sw-btn sw-btn-primary size-10 shrink-0 rounded-full"
                  >
                    {status === "running" ? <span className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white" aria-hidden /> : <ArrowUp className="size-[18px]" aria-hidden />}
                  </motion.button>
                </form>
                <AnimatePresence>{pending === "chat" ? <PendingSend ms={PENDING_MS} onCancel={cancelPending} /> : null}</AnimatePresence>
                {status === "result" && result && !detail ? (
                  <div className="flex gap-2">
                    <button type="button" onClick={() => { setSendOpen(true); say("Draft ready · nothing is sent"); }} className="sw-btn sw-btn-primary min-h-11 flex-1 whitespace-nowrap rounded-[12px] px-4 text-[15px] font-semibold">
                      <Send className="size-4" aria-hidden /> Send plan
                    </button>
                    {selected ? (
                      <a href={gmapsDirections(selected.location.lat, selected.location.lng)} target="_blank" rel="noopener noreferrer" className="sw-btn sw-btn-quiet min-h-11 gap-1.5 rounded-[12px] px-3.5 text-[15px] font-medium">
                        <Navigation className="size-4" aria-hidden /> <span className="max-sm:sr-only">Directions</span>
                      </a>
                    ) : null}
                    <button type="button" onClick={change} className="sw-btn sw-btn-ghost min-h-11 gap-1.5 rounded-[12px] px-3 text-[15px] font-medium">
                      <PencilLine className="size-4" aria-hidden /> Change
                    </button>
                  </div>
                ) : null}
              </motion.div>
            ) : null}
          </AnimatePresence>
          {/* micro confirmations */}
          <div className={cn("pointer-events-none absolute inset-x-0 z-30 flex justify-center", view ? "bottom-[150px]" : "bottom-[84px]")} role="status" aria-live="polite">
            <AnimatePresence>
              {toast ? (
                <motion.div
                  key={toast.id}
                  initial={{ opacity: 0, y: 14, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.95 }}
                  transition={{ type: "spring", stiffness: 480, damping: 30 }}
                  className="sw-glass-chip inline-flex max-w-[90%] items-center gap-2 rounded-full px-3.5 py-2 text-[13px] font-semibold text-ink shadow-e3 ring-1 ring-white/70"
                >
                  <CheckCircle2 className="size-4 shrink-0 text-signal-ink" aria-hidden />
                  <span className="truncate">{toast.text}</span>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </motion.aside>

        {wide ? (
          <div className={cn("pointer-events-none absolute bottom-6 left-[476px] right-4 z-30 flex justify-center transition-[right] duration-500", panelOpen && "right-[424px]", state.example && "bottom-14")}>
            <VoiceCardSlot reply={voice} live={liveOn} onClose={() => setVoice(null)} />
          </div>
        ) : null}

        {placeSnap ? (
          <DetailPanel
            card={placeSnap.card}
            mobile={mobile}
            result={placeSnap.result}
            example={placeSnap.example}
            onClose={() => setPlaceSnap(null)}
            onSend={() => setFriendOpen(true)}
            snap={{ open: placeSnap.open, onMeet: () => meetHere(), landmark: placeSnap.landmark, onNearby: () => meetHere(true), onFriend: () => { setFriendOpen(true); say("Draft ready · nothing is sent"); } }}
          />
        ) : result ? <DetailPanel card={detail} mobile={mobile} result={result} example={state.example} onClose={closeDetail} onSend={() => { setSendOpen(true); say("Draft ready · nothing is sent"); }} /> : null}
        {placeSnap ? <SendPlanDialog title="Send to a friend" open={friendOpen} onOpenChange={setFriendOpen} draft={placeSnap.draft} /> : null}
        {result ? <SendPlanDialog open={sendOpen} onOpenChange={setSendOpen} draft={friendlyDraft(result, detail ?? selected)} /> : null}
      </main>
    </MotionConfig>
  );
}
