"use client";
// Floating "voice card" for assistant follow-up replies (refine, is-open, leave-by…): an orange orb + waveform that
// moves with the real audio (AnalyserNode), the reply revealed word by word in step with the speech, and replay /
// mute / close. Speech comes from /api/speak (Gemini TTS, voice Aoede); without it, the browser's en-GB voice.
// Only the short reply is spoken (never the other person's area). Audio isn't saved; mute is remembered locally.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CalendarPlus, Flag, Footprints, Languages, RotateCcw, Volume2, VolumeX, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LeaveBy } from "./blurb";
import { VoiceOrb } from "./live-voice";
import { TFL_LINES } from "./motion-bits";

/** Any-language replies: `text` is in `lang` (spoken in it), `english` the original, `model` what really translated it. */
export type VoiceReply = { id: number; text: string; leaveBy?: LeaveBy | null; place?: string; autoplay?: boolean; lang?: string; langName?: string; english?: string; model?: string; heardBy?: string };
/** ISO 639-1 → BCP 47 for TTS / speechSynthesis. */
export const BCP47: Record<string, string> = { en: "en-GB", it: "it-IT", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-PT", nl: "nl-NL", pl: "pl-PL", ro: "ro-RO", tr: "tr-TR", ar: "ar-XA", hi: "hi-IN", bn: "bn-IN", ur: "ur-IN", zh: "cmn-CN", ja: "ja-JP", ko: "ko-KR", ru: "ru-RU", uk: "uk-UA", el: "el-GR", sv: "sv-SE" };
const bcp = (lang?: string) => (lang && BCP47[lang]) || "en-GB";
type Phase = "idle" | "loading" | "speaking" | "done";

// ---------------------------------------------------------------- audio (one shared context, unlocked on send)
let ctx: AudioContext | null = null;
function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}
/** Call from the send click: unlocks audio (iOS/Safari) so the reply can autoplay when it lands. */
export function primeVoice() {
  const c = audioCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  try {
    const b = c.createBuffer(1, 1, 22050);
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(c.destination);
    s.start(0);
  } catch {}
}

const MUTE_KEY = "sw-voice-muted";
export function useVoiceMuted() {
  const [muted, set] = useState(() => {
    try { return typeof window !== "undefined" && localStorage.getItem(MUTE_KEY) === "1"; } catch { return false; }
  });
  const setMuted = useCallback((m: boolean) => {
    set(m);
    try { localStorage.setItem(MUTE_KEY, m ? "1" : "0"); } catch {}
  }, []);
  return [muted, setMuted] as const;
}

// ---------------------------------------------------------------- text
const SENT = /[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g;
/** What gets spoken: the first sentences, ≤ 240 chars (the API takes 400). */
function spokenPrefix(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= 240) return t;
  let out = "";
  for (const s of t.match(SENT) ?? [t]) {
    if ((out + s).length > 240) break;
    out += s;
  }
  return (out || t.slice(0, 240).replace(/\s+\S*$/, "")).trim();
}
/** Symbols read badly aloud. */
const forSpeech = (t: string) =>
  t.replace(/\s*\+\s*/g, " and ").replace(/\s*·\s*/g, ", ").replace(/~\s?/g, "about ").replace(/→/g, " to ").replace(/[“”"]/g, "").replace(/\s+/g, " ").trim();

/** Leave-by in words, short enough to speak. */
function leaveLine(lb: LeaveBy, place: string | undefined, legs: Legs): string {
  const via = legs.lines.length ? ` on the ${legs.lines.map((l) => l.replace(/^Bus/, "bus")).join(", then the ")}` : legs.walk ? " on foot" : "";
  const you = lb.you ? `Leave at ${lb.you}${via}, to reach ${place ?? "it"} by ${lb.arriveBy}.` : `Aim to arrive at ${place ?? "it"} by ${lb.arriveBy}.`;
  return lb.them ? `${you} They leave at ${lb.them}.` : you;
}

// ---------------------------------------------------------------- leave-by parsing (from the reply text)
type Legs = { walk?: number; lines: string[]; minutes?: number; themMinutes?: number; day?: string; place?: string };
const LINE_RE = /\b(Bakerloo|Central|Circle|District|Hammersmith & City|Jubilee|Metropolitan|Northern|Piccadilly|Victoria|Waterloo & City|Elizabeth) line\b|\bDLR\b|\b(?:London )?Overground\b|\b(Windrush|Mildmay|Lioness|Suffragette|Weaver|Liberty)\b|\bbus(?:es)? ([A-Z]?\d{1,3}[A-Z]?)\b|\btram\b/gi;
function legsOf(text: string): Legs {
  const t = text.replace(/\s+/g, " ");
  const youClause = /\bYou: ([^;]+)/.exec(t)?.[1] ?? t.split(/,? so add\b/)[0];
  const lines: string[] = [];
  for (const m of youClause.matchAll(LINE_RE)) {
    const name = m[1] ? `${m[1]} line` : m[3] ? m[3] : m[4] ? `Bus ${m[4]}` : /dlr/i.test(m[0]) ? "DLR" : /tram/i.test(m[0]) ? "Tram" : "Overground";
    if (!lines.includes(name)) lines.push(name);
  }
  const walk = Number(/(\d+) min walk/.exec(youClause)?.[1]) || undefined;
  const mins = [...youClause.matchAll(/(\d+) min(?! walk)\b/g)].map((m) => Number(m[1]));
  const themMinutes = Number(/\b(?:her|him|them|they): leave by \d\d:\d\d \((\d+) min\)/i.exec(t)?.[1]) || undefined;
  const day = /\(((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]* \d{1,2} [A-Z][a-z]{2})\)/.exec(t)?.[1];
  const place = /\barrive at (.+?) by \d{1,2}:\d\d/.exec(t)?.[1];
  return { walk, lines, minutes: mins.length ? mins[mins.length - 1] : undefined, themMinutes, day, place };
}
const lineHex = (name: string) => {
  if (/^bus/i.test(name)) return "#DC241F";
  const k = name.toLowerCase();
  return TFL_LINES[k] ?? Object.entries(TFL_LINES).find(([n]) => k.includes(n))?.[1] ?? "#7d8087";
};
const dayOf = (date?: string) =>
  date && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`)).replace(",", "")
    : undefined;

// ---------------------------------------------------------------- .ics reminder (download only; nothing is sent)
function londonToUtc(date: string, hhmm: string): Date {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = hhmm.split(":").map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, h, mi));
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(guess).map((x) => [x.type, x.value]));
  const shown = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess.getTime() - (shown - guess.getTime()));
}
const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const icsText = (s: string) => s.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");
function downloadReminder(lb: LeaveBy, place: string | undefined, legs: Legs) {
  if (!lb.you) return;
  const date = lb.date && /^\d{4}-\d{2}-\d{2}$/.test(lb.date) ? lb.date : new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());
  const leave = londonToUtc(date, lb.you);
  const start = new Date(leave.getTime() - 10 * 60_000);
  const where = place ?? "your plan";
  const how = legs.lines.length ? ` ${legs.lines.join(", then ")}${legs.minutes ? `, ${legs.minutes} min` : ""}.` : "";
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//So where//Leave reminder//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:sw-leave-${start.getTime()}@so-where`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(start)}`,
    `DTEND:${icsStamp(leave)}`,
    `SUMMARY:${icsText(`Leave at ${lb.you} for ${where}`)}`,
    `DESCRIPTION:${icsText(`Leave at ${lb.you} to arrive by ${lb.arriveBy}.${how}`)}`,
    "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsText(`Leave at ${lb.you} for ${where}`)}`, "TRIGGER:PT0M", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `leave-${lb.you.replace(":", "")}-${where.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "plan"}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------- speech engine
type Engine = { progress: () => number; level: () => number; stop: () => void };

/** The audio plus the TTS model that really answered (X-TTS-Model), so the card can name it. */
async function fetchVoice(text: string, signal: AbortSignal, lang?: string): Promise<{ raw: ArrayBuffer; model: string | null } | null> {
  try {
    const r = await fetch("/api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(lang && lang !== "en" ? { text, lang } : { text }), signal });
    if (!r.ok) return null;
    return { model: r.headers.get("X-TTS-Model"), raw: await r.arrayBuffer() };
  } catch {
    return null;
  }
}

function playBuffer(buf: AudioBuffer, onEnd: () => void): Engine | null {
  const c = audioCtx();
  if (!c) return null;
  if (c.state === "suspended") void c.resume();
  const src = c.createBufferSource();
  src.buffer = buf;
  const an = c.createAnalyser();
  an.fftSize = 512;
  an.smoothingTimeConstant = 0.6;
  src.connect(an);
  an.connect(c.destination);
  const data = new Uint8Array(an.fftSize);
  const t0 = c.currentTime + 0.02;
  let stopped = false;
  src.onended = () => {
    if (!stopped) onEnd();
  };
  src.start(t0);
  return {
    progress: () => Math.max(0, Math.min(1, (c.currentTime - t0) / buf.duration)),
    level: () => {
      an.getByteTimeDomainData(data);
      let s = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        s += v * v;
      }
      return Math.min(1, Math.sqrt(s / data.length) * 4.5);
    },
    stop: () => {
      stopped = true;
      try { src.stop(); } catch {}
      src.disconnect();
      an.disconnect();
    },
  };
}

function speakBrowser(text: string, onEnd: () => void, lang?: string): Engine | null {
  const ss = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!ss || typeof SpeechSynthesisUtterance === "undefined") return null;
  ss.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang && lang !== "en" ? (bcp(lang) === "cmn-CN" ? "zh-CN" : bcp(lang)) : "en-GB";
  const pre = u.lang.slice(0, 2);
  const v = lang && lang !== "en"
    ? ss.getVoices().find((x) => x.lang.replace("_", "-") === u.lang) ?? ss.getVoices().find((x) => x.lang.toLowerCase().startsWith(pre))
    : ss.getVoices().find((x) => x.lang === "en-GB" && /female|libby|sonia|serena|kate|google uk english female/i.test(x.name)) ?? ss.getVoices().find((x) => x.lang === "en-GB");
  if (v) u.voice = v;
  u.rate = 1.03;
  let char = 0;
  let boundary = false;
  const started = performance.now();
  let stopped = false;
  u.onboundary = (e) => {
    boundary = true;
    char = e.charIndex;
  };
  u.onend = () => {
    if (!stopped) onEnd();
  };
  u.onerror = () => {
    if (!stopped) onEnd();
  };
  ss.speak(u);
  return {
    // No boundary events (some voices): ~15 chars a second.
    progress: () => Math.min(1, boundary ? char / text.length : (performance.now() - started) / 1000 / (text.length / 15)),
    level: () => 0.35 + 0.25 * Math.abs(Math.sin(performance.now() / 140)),
    stop: () => {
      stopped = true;
      ss.cancel();
    },
  };
}

// ---------------------------------------------------------------- waveform
function Waveform({ level, active, reduced, bars = 26 }: { level: () => number; active: boolean; reduced: boolean; bars?: number }) {
  const refs = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (reduced) return;
    let raf = 0;
    let smooth = 0;
    const tick = (now: number) => {
      const l = active ? level() : 0;
      smooth = smooth * 0.7 + l * 0.3;
      for (let i = 0; i < bars; i++) {
        const el = refs.current[i];
        if (!el) continue;
        const env = Math.sin((Math.PI * (i + 0.5)) / bars); // taller in the middle
        const idle = 0.16 + 0.1 * Math.sin(now / 520 + i * 0.55);
        const live = smooth * env * (0.55 + 0.45 * Math.abs(Math.sin(now / 95 + i * 1.7)));
        el.style.transform = `scaleY(${Math.max(0.12, Math.min(1, idle + live))})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [level, active, reduced, bars]);
  return (
    <div className="flex h-7 flex-1 items-center gap-[3px]" aria-hidden>
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          ref={(el) => { refs.current[i] = el; }}
          className="h-full w-[3px] flex-1 origin-center rounded-full bg-[linear-gradient(180deg,#ff9a3c,#e2560f)] will-change-transform"
          style={{ transform: `scaleY(${reduced ? 0.25 + 0.35 * Math.sin((Math.PI * (i + 0.5)) / bars) : 0.2})`, maxWidth: 4 }}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- leave hero
function Roundel({ color, className }: { color: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <circle cx="12" cy="12" r="7.6" fill="none" stroke={color} strokeWidth="4" />
      <rect x="1.5" y="9.6" width="21" height="4.8" rx="0.6" fill={color} />
    </svg>
  );
}

function LeaveHero({ lb, legs, place }: { lb: LeaveBy; legs: Legs; place?: string }) {
  const day = legs.day ?? dayOf(lb.date);
  return (
    <div className="mt-3">
      {lb.you ? (
        <div className="rounded-[18px] bg-[linear-gradient(160deg,var(--sw-cta-a),var(--sw-cta-b))] p-3 pb-2.5 text-white shadow-[var(--sw-cta-inner),0_10px_24px_-12px_rgba(226,86,15,.75)]">
          <p className="num text-[30px] font-bold leading-none tracking-[-0.02em] sm:text-[34px]">
            <span className="mr-2 text-[15px] font-semibold tracking-normal text-white/85">Leave</span>
            {lb.you}
          </p>
          {legs.walk || legs.lines.length || legs.minutes ? (
            <ul className="mt-2.5 flex flex-wrap items-center gap-1.5" aria-label="Your route">
              {legs.walk ? (
                <li className="inline-flex h-6 items-center gap-1 rounded-full bg-white/95 px-2 text-[12px] font-semibold text-ink">
                  <Footprints className="size-3.5 text-ink-3" aria-hidden />
                  {legs.walk} min
                </li>
              ) : null}
              {legs.lines.map((l) => (
                <li key={l} className="inline-flex h-6 items-center gap-1 rounded-full bg-white/95 pl-1 pr-2 text-[12px] font-semibold text-ink">
                  <Roundel color={lineHex(l)} className="size-4" />
                  {l.replace(/ line$/, "")}
                </li>
              ))}
              {legs.minutes ? <li className="num px-1 text-[12.5px] font-semibold text-white/90">{legs.minutes} min</li> : null}
            </ul>
          ) : null}
        </div>
      ) : null}
      <p className="num mt-2 flex items-center gap-1.5 text-[13.5px] font-semibold leading-5 text-ink">
        <Flag className="size-3.5 shrink-0 text-signal-ink" aria-hidden />
        <span className="min-w-0">
          Arrive {place ? <>{place} </> : null}
          {lb.arriveBy}
          {day ? <span className="font-medium text-ink-3"> · {day}</span> : null}
        </span>
      </p>
      {lb.them ? (
        <p className="num mt-1 flex items-center gap-1.5 text-[13.5px] font-semibold leading-5 text-[#1478a3]">
          <span className="ml-[3px] size-2 shrink-0 rounded-full bg-[#1478a3]" aria-hidden />
          Them {lb.them}
          {legs.themMinutes ? <span className="font-medium text-[#1478a3]/75"> · {legs.themMinutes} min</span> : null}
        </p>
      ) : null}
      {lb.you ? (
        <button
          type="button"
          onClick={() => downloadReminder(lb, place, legs)}
          className="sw-btn sw-btn-quiet mt-2.5 min-h-9 gap-1.5 rounded-full px-3 text-[13px] font-semibold"
        >
          <CalendarPlus className="size-4" aria-hidden /> Add reminder
          <span className="font-medium text-ink-3">· {minus10(lb.you)}</span>
        </button>
      ) : null}
    </div>
  );
}
const minus10 = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  const x = (((h * 60 + m - 10) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------------- card
export function VoiceCard({ reply, live, onClose, className }: { reply: VoiceReply; live?: boolean; onClose: () => void; className?: string }) {
  const reduced = !!useReducedMotion();
  const [muted, setMuted] = useVoiceMuted();
  const [phase, setPhase] = useState<Phase>("idle");
  const [shown, setShown] = useState(0);
  const engine = useRef<Engine | null>(null);
  const abort = useRef<AbortController | null>(null);
  const cache = useRef<{ text: string; buf: AudioBuffer; by: string | null } | null>(null);
  const [voiceBy, setVoiceBy] = useState<string | null>(null);
  const run = useRef(0);

  const foreign = !!reply.lang && reply.lang !== "en" && !!reply.english;
  const [showEnglish, setShowEnglish] = useState(false);
  const legs = useMemo(() => legsOf(reply.english ?? reply.text), [reply.english, reply.text]);
  const place = legs.place ?? reply.place;
  // Translated replies show (and speak) the translation as-is; the English leave line is only for English replies.
  const display = useMemo(
    () => (foreign ? (showEnglish ? reply.english! : reply.text).replace(/\s+/g, " ").trim() : reply.leaveBy ? leaveLine(reply.leaveBy, place, legs) : reply.text.replace(/\s+/g, " ").trim()),
    [reply, place, legs, foreign, showEnglish],
  );
  const speakLang = foreign && !showEnglish ? reply.lang : undefined;
  const prefix = useMemo(() => spokenPrefix(display), [display]);
  const words = useMemo(() => display.split(/\s+/).filter(Boolean), [display]);
  const spokenWords = prefix.split(/\s+/).filter(Boolean).length;
  // Each word's end, as a share of the spoken prefix (longer words and pauses take longer).
  const ends = useMemo(() => {
    const w = words.slice(0, spokenWords).map((x) => x.length + 1 + (/[.,;:!?]$/.test(x) ? 4 : 0));
    const total = w.reduce((a, b) => a + b, 0) || 1;
    let acc = 0;
    return w.map((x) => (acc += x) / total);
  }, [words, spokenWords]);

  const level = useCallback(() => engine.current?.level() ?? 0, []);

  const stop = useCallback(() => {
    run.current++;
    abort.current?.abort();
    abort.current = null;
    engine.current?.stop();
    engine.current = null;
  }, []);

  const play = useCallback(async () => {
    stop();
    const my = ++run.current;
    const text = forSpeech(prefix);
    setShown(0);
    setPhase("loading");
    const done = () => {
      if (run.current !== my) return;
      engine.current = null;
      setShown(words.length);
      setPhase("done");
    };
    let buf = cache.current?.text === text ? cache.current.buf : null;
    let by = buf ? cache.current?.by ?? null : null;
    if (!buf) {
      const ac = new AbortController();
      abort.current = ac;
      const timer = setTimeout(() => ac.abort(), 9000);
      const got = await fetchVoice(text, ac.signal, speakLang);
      clearTimeout(timer);
      if (run.current !== my) return;
      const c = audioCtx();
      if (got && c) {
        try {
          buf = await c.decodeAudioData(got.raw);
          by = got.model;
          cache.current = { text, buf, by };
        } catch {
          buf = null;
        }
      }
      if (run.current !== my) return;
    }
    const fromBuf = buf ? playBuffer(buf, done) : null;
    const e = fromBuf ?? speakBrowser(text, done, speakLang);
    if (!e) return done();
    setVoiceBy(fromBuf ? by : "browser voice");
    engine.current = e;
    setPhase("speaking");
    if (reduced) setShown(words.length);
  }, [prefix, words.length, stop, reduced, speakLang]);

  // Word-by-word reveal from the engine's progress.
  useEffect(() => {
    if (phase !== "speaking" || reduced) return;
    let raf = 0;
    let last = -1;
    const tick = () => {
      const p = engine.current?.progress() ?? 1;
      let n = 0;
      while (n < ends.length && ends[n] <= p + 0.02) n++;
      n = Math.max(n, 1);
      if (n !== last) {
        last = n;
        setShown(n);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, ends, reduced]);

  // New reply: speak it (after the user's own send), unless muted or live voice is already talking.
  useEffect(() => {
    if (reply.autoplay && !muted && !live) void play();
    else {
      setShown(words.length);
      setPhase("done");
    }
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reply.id]);
  useEffect(() => {
    if (live) {
      stop();
      setShown(words.length);
      setPhase("done");
    }
  }, [live, stop, words.length]);

  const toggleMute = () => {
    if (!muted) {
      stop();
      setShown(words.length);
      setPhase("done");
      setMuted(true);
    } else {
      setMuted(false);
      primeVoice();
      void play();
    }
  };
  const replay = () => {
    primeVoice();
    if (muted) setMuted(false);
    void play();
  };

  const speaking = phase === "speaking";
  const status = phase === "loading" ? "Getting voice…" : speaking ? "Speaking" : muted ? "Muted" : live ? "Live voice on" : "So where";
  const hidden = phase === "loading" ? 0 : speaking ? shown : words.length;

  return (
    <motion.section
      role="region"
      aria-label="Reply"
      data-voice-phase={phase}
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 18, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={reduced ? { opacity: 0 } : { opacity: 0, y: 12, scale: 0.98, transition: { duration: 0.18 } }}
      transition={{ type: "spring", stiffness: 380, damping: 32 }}
      className={cn(
        "sw-glass-chip sw-voice-card pointer-events-auto relative w-full max-w-[440px] overflow-hidden rounded-[24px] p-3.5 pt-3 shadow-[0_22px_56px_-16px_rgba(40,26,12,.42)] ring-1 ring-white/80",
        className,
      )}
    >
      <span className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-[radial-gradient(120%_100%_at_15%_0%,rgba(255,154,60,.22),transparent_70%)]" aria-hidden />
      <div className="relative flex items-center gap-2.5">
        <VoiceOrb state={phase === "loading" ? "thinking" : speaking ? "speaking" : "idle"} getLevel={speaking ? level : undefined} size={34} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11.5px] font-semibold uppercase tracking-[0.06em] text-ink-3" aria-live="polite">
            {status}
            {voiceBy && phase !== "loading" ? <span className="font-mono text-[10.5px] font-normal normal-case tracking-normal" title="Voice model that read this reply"> · {voiceBy}</span> : null}
          </p>
          <Waveform level={level} active={speaking} reduced={reduced} />
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button type="button" onClick={replay} aria-label="Replay" title="Replay" className="sw-btn grid size-9 place-items-center rounded-full text-ink-2 hover:bg-white/80 hover:text-ink">
            <RotateCcw className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            onClick={toggleMute}
            aria-pressed={muted}
            aria-label={muted ? "Unmute voice replies" : "Mute voice replies"}
            title={muted ? "Unmute" : "Mute"}
            className={cn("sw-btn grid size-9 place-items-center rounded-full hover:bg-white/80", muted ? "bg-signal-soft text-signal-ink" : "text-ink-2 hover:text-ink")}
          >
            {muted ? <VolumeX className="size-4" aria-hidden /> : <Volume2 className="size-4" aria-hidden />}
          </button>
          <button type="button" onClick={() => { stop(); onClose(); }} aria-label="Close reply" title="Close" className="sw-btn grid size-9 place-items-center rounded-full text-ink-2 hover:bg-white/80 hover:text-ink">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">{display}</p>
      <p className={cn("relative mt-2 text-[15.5px] font-medium leading-[22px] text-ink [overflow-wrap:anywhere]", reply.leaveBy && "text-[14.5px] leading-[21px] text-ink-2")} aria-hidden>
        {words.map((w, i) => (
          <span key={i} className={cn("transition-[opacity,filter] duration-300 ease-out", i < hidden ? "opacity-100" : "opacity-[.22] blur-[0.3px]")}>
            {w}{" "}
          </span>
        ))}
      </p>

      {foreign ? (
        <button
          type="button"
          onClick={() => { stop(); setShowEnglish((v) => !v); setShown(9999); setPhase("done"); }}
          aria-pressed={showEnglish}
          title={`${reply.heardBy ? `Heard by ${reply.heardBy} · ` : ""}reply translated by ${reply.model ?? "Gemini"}. Tap to ${showEnglish ? "switch back" : "see the English"}.`}
          className="relative mt-2 inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-full bg-white/80 px-2.5 text-[11.5px] font-semibold text-ink-2 ring-1 ring-black/5 hover:bg-white hover:text-ink"
        >
          <Languages className="size-3.5 shrink-0 text-signal-ink" aria-hidden />
          <span className="truncate">{showEnglish ? "English · tap for " + (reply.langName ?? "original") : `${reply.langName ?? reply.lang} · translated by Gemini`}</span>
        </button>
      ) : null}

      {reply.leaveBy ? <LeaveHero lb={reply.leaveBy} legs={legs} place={place} /> : null}
    </motion.section>
  );
}

export function VoiceCardSlot({ reply, live, onClose, className }: { reply: VoiceReply | null; live?: boolean; onClose: () => void; className?: string }) {
  return (
    <AnimatePresence mode="wait">
      {reply ? <VoiceCard key={reply.id} reply={reply} live={live} onClose={onClose} className={className} /> : null}
    </AnimatePresence>
  );
}
