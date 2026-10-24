"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { mentionedIn, nameRegex } from "@/lib/venue-match";
import { AnimatePresence, motion } from "motion/react";
import { BookOpenText, LoaderCircle, Map as MapIcon, MapPin, Mic, Send, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";

type SpeechResult = ArrayLike<{ transcript: string }>;
type SpeechEventLike = { results: ArrayLike<SpeechResult> };

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
type SpeechWindow = Window & {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
};

interface AskResponse {
  answer: string | null;
  sources: string[];
  error?: string;
}

const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<>\]|]+[^\s)<>\].,;:!?|])/g;

function linkLabel(label: string, url: string) {
  if (label !== url) return label;
  try {
    const u = new URL(url);
    return /(^|\.)(luma\.com|lu\.ma)$/i.test(u.hostname) ? "Register on Luma" : u.hostname.replace(/^www\./, "");
  } catch {
    return label;
  }
}

type Pick = (id: string) => void;
type Ctx = { places: AskVenue[]; onPick: Pick; used?: Set<string> };

/** Venue names in plain text become buttons that open the venue on the map. */
function withNames(text: string, key: string, ctx: Ctx): React.ReactNode[] {
  const res = ctx.places.map((p) => nameRegex(p.name, "")?.source).filter(Boolean);
  if (!res.length || !text) return [text];
  const re = new RegExp(res.join("|"), "giu");
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    const place = ctx.places.find((p) => nameRegex(p.name)?.test(m[0]));
    // Only the first mention of each place in a line is a button.
    if (!place || ctx.used?.has(place.id)) continue;
    ctx.used?.add(place.id);
    out.push(text.slice(last, at));
    out.push(
      <button key={`${key}-n${at}`} type="button" onClick={() => ctx.onPick(place.id)} title="Show on map" className="font-semibold text-[#5a3fd6] underline decoration-[#cfc4fb] decoration-dotted underline-offset-4 hover:decoration-[#7854f6]">
        {m[0]}
      </button>,
    );
    last = at + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function bold(text: string, key: string, ctx: Ctx) {
  return text.split(/(\*\*[^*]+\*\*)/g).flatMap((part, i) =>
    part.startsWith("**") && part.endsWith("**")
      ? [<strong key={`${key}-${i}`} className="font-semibold text-[#20202a]">{withNames(part.slice(2, -2), `${key}-${i}`, ctx)}</strong>]
      : withNames(part.replace(/[*_`]/g, ""), `${key}-${i}`, ctx),
  );
}

// Bold plus [label](url) and bare URLs as new-tab links.
function inline(raw: string, ctx: Ctx) {
  const text = raw.replace(/<(https?:\/\/[^>\s]+)>/g, "$1");
  const out: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    const at = m.index ?? 0;
    out.push(...bold(text.slice(last, at), `t${at}`, ctx));
    const url = m[2] ?? m[3];
    out.push(
      <a key={`a${at}`} href={url} target="_blank" rel="noopener noreferrer" className="font-medium !text-[#7854f6] !underline decoration-[#cfc4fb] underline-offset-2 hover:decoration-[#7854f6]">
        {linkLabel((m[1] ?? url).replace(/\*\*/g, ""), url)}
      </a>,
    );
    last = at + m[0].length;
  }
  out.push(...bold(text.slice(last), "end", ctx));
  return out;
}

function MapChip({ place, onPick }: { place: AskVenue; onPick: Pick }) {
  return (
    <button type="button" onClick={() => onPick(place.id)} aria-label={`Show ${place.name} on map`} className="ml-1.5 inline-flex translate-y-[-1px] items-center gap-1 rounded-full bg-[#f0ebff] px-2.5 py-0.5 align-middle text-[12px] font-semibold leading-5 text-[#5a3fd6] transition-colors hover:bg-[#7854f6] hover:!text-white">
      <MapPin className="h-3 w-3" aria-hidden="true" /> Show on map
    </button>
  );
}

function Answer({ text, places, onPick }: { text: string; places: AskVenue[]; onPick: Pick }) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const ctx = { places, onPick };
  return (
    <div className="space-y-3 text-[16px] leading-[1.8] text-[#34323d]">
      {lines.map((line, i) => (
        <motion.div key={i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(i * 0.06, 0.9), duration: 0.35, ease: "easeOut" }}>
          {renderLine(line, i, ctx)}
        </motion.div>
      ))}
    </div>
  );
}

function renderLine(line: string, i: number, shared: Ctx) {
  const ctx = { ...shared, used: new Set<string>() };
  if (/^\|?\s*:?-{3,}/.test(line)) return null;
  // A line can name the venue or only its session ("Co-Working Fridays"); both get a Show on map chip.
  const plain = line.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const named = ctx.places.flatMap((p) => [p.name, ...(Array.isArray(p.aliases) ? (p.aliases as string[]) : [])].map((name) => ({ name, p })));
  const place = mentionedIn(plain, named)[0]?.p;
  const chip = place ? <MapChip place={place} onPick={ctx.onPick} /> : null;
  const dot = <span className="mt-[11px] h-1.5 w-1.5 shrink-0 rounded-full bg-[#7854f6]" />;
  if (line.startsWith("|")) {
    const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
    return <p key={i} className="flex gap-2 pl-1">{dot}<span>{inline(cells.join(" · "), ctx)}{chip}</span></p>;
  }
  const heading = /^#{1,6}\s+/.exec(line);
  if (heading) return <p key={i} className="pt-1 font-semibold text-[#20202a]">{inline(line.slice(heading[0].length), ctx)}{chip}</p>;
  const bullet = /^(?:[-*\u2022]|\d+[.)])\s+/.exec(line);
  if (bullet) return <p key={i} className="flex gap-2 pl-1">{dot}<span>{inline(line.slice(bullet[0].length), ctx)}{chip}</span></p>;
  return <p key={i}>{inline(line, ctx)}{chip}</p>;
}

function cleanSources(sources: string[]) {
  const labels = sources.map((s) => {
    const doc = /document\s+([\w.-]+)/i.exec(s)?.[1] ?? "";
    const venue = /^venue-(-?\d+\.\d+)_(-?\d+\.\d+)/.exec(doc);
    if (venue) return `Venue record near ${Number(venue[1]).toFixed(3)}, ${Number(venue[2]).toFixed(3)}`;
    if (/^event/i.test(doc)) return "Community event record";
    if (doc) return doc.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return s.replace(/\(.*?\)/g, "").replace(/\b[0-9a-f-]{20,}\b/gi, "").replace(/[*_`#]/g, "").trim();
  });
  return Array.from(new Set(labels.filter((s) => s.length > 3))).slice(0, 6);
}

export type AskVenue = {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  capacity: number | null;
  status: string | null;
  reason: string | null;
  distance_m: number | null;
  [key: string]: unknown;
};

type Turn = { id: number; q: string; answer: string | null; sources: string[]; error?: string; venues: AskVenue[]; pending?: boolean };

const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

function stripMd(s: string) {
  return s.replace(/^#{1,6}\s+/, "").replace(/^(?:[-*\u2022]|\d+[.)])\s+/, "").replace(/[*_`]/g, "").trim();
}

async function extractVenues(answer: string): Promise<AskVenue[]> {
  const lines = answer.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const found: { name: string; address: string; postcode: string; details: string[] }[] = [];
  lines.forEach((raw, i) => {
    const line = stripMd(raw);
    const pc = POSTCODE.exec(line);
    if (!pc) return;
    // Markdown table row: first cell is the venue, the cell with the postcode is the address.
    if (raw.startsWith("|")) {
      const cells = raw.split("|").map((c) => stripMd(c).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[“”"]/g, "").trim()).filter(Boolean);
      const name = (cells[0] ?? "").split(/\s+[–—-]\s+/)[0].trim();
      const address = cells.find((c) => POSTCODE.test(c)) ?? "";
      const rowPc = POSTCODE.exec(address);
      if (name && rowPc && name.length <= 40 && !found.some((f) => f.name === name)) found.push({ name, address, postcode: rowPc[1].toUpperCase(), details: cells.slice(1).filter((c) => c !== address) });
      return;
    }
    const parts = line.split(/\s+[\u2013\u2014-]\s+|:\s+/);
    let name = parts.length > 1 ? parts[0] : line.split(",")[0];
    let address = parts.length > 1 ? parts.slice(1).join(", ") : line;
    // "Address: ..." under a heading line: the heading is the venue name.
    const isLabel = /^(address|location|where|venue|place)$/i.test(name.trim());
    if ((POSTCODE.test(name) || isLabel) && i > 0) {
      address = isLabel ? parts.slice(1).join(", ") : line;
      name = stripMd(lines[i - 1]).split(/\s+[\u2013\u2014-]\s+|[\u2013\u2014:(]/)[0];
    }
    const details: string[] = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
      const next = stripMd(lines[j]);
      if (POSTCODE.test(next)) break;
      details.push(next);
    }
    name = name.replace(/\s*\(.*$/, "").trim();
    if (!name || name.length > 40 || name.split(/\s+/).length > 6 || /\b(is|are|the nearer|lies)\b/i.test(name)) return;
    if (!found.some((f) => f.name === name)) found.push({ name: name.trim(), address: address.trim(), postcode: pc[1].toUpperCase(), details });
  });
  const geo = await Promise.all(
    found.slice(0, 8).map(async (v): Promise<AskVenue | null> => {
      try {
        const r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(v.postcode.replace(/\s+/g, ""))}`);
        const j = (await r.json()) as { result?: { latitude: number; longitude: number } };
        if (!j.result) return null;
        const detail = v.details.join(" · ");
        const cap = /capacity[^\d]*(\d+)/i.exec(detail) ?? /(\d+)\s*(?:attendees|people|guests)/i.exec(detail);
        return {
          id: `ask-${v.postcode.replace(/\s+/g, "")}-${v.name.slice(0, 12)}`,
          name: v.name,
          address: v.address,
          lat: j.result.latitude,
          lng: j.result.longitude,
          capacity: cap ? Number(cap[1]) : null,
          status: "suggested",
          reason: detail ? `Suggested by Ask Lumap · ${detail}` : "Suggested by Ask Lumap",
          distance_m: null,
        };
      } catch {
        return null;
      }
    }),
  );
  return geo.filter((v): v is AskVenue => v !== null);
}

export const ASK_VENUES_EVENT = "lumap:ask-venues";
export const FOCUS_VENUE_EVENT = "lumap:focus-venue";
export const FIT_VENUES_EVENT = "lumap:fit-venues";

/** Pins the venues; then opens one (focusId) or frames them all. */
function showOnMap(venues: AskVenue[], focusId?: string | null, fitIds?: string[]) {
  window.dispatchEvent(new CustomEvent(ASK_VENUES_EVENT, { detail: venues }));
  setTimeout(() => {
    if (focusId) window.dispatchEvent(new CustomEvent(FOCUS_VENUE_EVENT, { detail: focusId }));
    else if (fitIds?.length) window.dispatchEvent(new CustomEvent(FIT_VENUES_EVENT, { detail: fitIds }));
  }, 60);
}

const EXAMPLES = [
  "I need a coworking space for next week",
  "A birthday for 30 people on Saturday",
  "A meetup for 60 near Old Street on a Thursday",
  "Somewhere to work alongside other founders tomorrow",
];

type AskReply = AskResponse & { places?: AskVenue[] };

async function postAsk(payload: Record<string, unknown>): Promise<{ ok: boolean; data: AskReply }> {
  const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = (await res.json().catch(() => ({ answer: null, sources: [] }))) as AskReply;
  return { ok: res.ok, data };
}

/** Places from the server (known venues) plus any other postcodes in the text, geocoded. */
async function placesFor(data: AskReply, earlier: AskVenue[]): Promise<AskVenue[]> {
  const known = data.places ?? [];
  const answer = data.answer ?? "";
  const extra = answer ? (await extractVenues(answer)).filter((v) => !known.some((k) => k.name.toLowerCase() === v.name.toLowerCase() || mentionedIn(v.name, [k]).length)) : [];
  const out = [...known, ...extra];
  if (!out.length) return earlier.filter((v) => answer.toLowerCase().includes(v.name.toLowerCase()));
  return out;
}

export function AskPanel() {
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");
  const [speechSupported, setSpeechSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("lumap:ask-open", { detail: open }));
  }, [open]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns, loading]);

  useEffect(() => {
    const speechWindow = window as SpeechWindow;
    const Recognition = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Recognition) return;

    const recognition = new Recognition();
    recognition.lang = "en-GB";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .filter(Boolean)
        .join(" ");
      if (transcript) setQuestion((current) => [current, transcript].filter(Boolean).join(" "));
    };
    recognition.onerror = () => {
      setListening(false);
      setError("Voice input stopped. You can still type your question.");
    };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setSpeechSupported(true);

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
      recognitionRef.current = null;
    };
  }, []);

  function toggleListening() {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    setError("");
    if (listening) {
      recognition.stop();
      setListening(false);
      return;
    }

    try {
      recognition.start();
      setListening(true);
    } catch {
      setError("Voice input could not start. Please try typing instead.");
    }
  }

  const turnSeq = useRef(0);
  const turnsRef = useRef<Turn[]>([]);
  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  const pick = (id: string) => {
    const all = turnsRef.current.flatMap((t) => t.venues);
    const unique = all.filter((v, i) => all.findIndex((x) => x.id === v.id) === i);
    showOnMap(unique, id);
  };

  function pinTurn(venues: AskVenue[]) {
    if (!venues.length) return;
    const earlier = turnsRef.current.flatMap((t) => t.venues).filter((e) => !venues.some((v) => v.id === e.id));
    showOnMap([...venues, ...earlier], null, venues.map((v) => v.id));
  }

  // Two requests at once: an instant answer from what Lumap already knows, and the slower
  // community-memory answer, which replaces it when it arrives with places of its own.
  async function ask(prompt: string) {
    if (!prompt || loading) return;
    setLoading(true);
    setError("");
    setQuestion("");
    const id = ++turnSeq.current;
    const past = turnsRef.current;
    const history = past
      .filter((t) => t.answer)
      .slice(-2)
      .map((t) => `Q: ${t.q}\nA: ${(t.answer ?? "").slice(0, 700)}`)
      .join("\n\n");
    const full = history ? `Earlier in this conversation:\n${history}\n\nFollow-up question: ${prompt}` : prompt;
    const payload = { question: full, latest: prompt, previous: past.map((t) => t.q) };
    const earlier = past.flatMap((t) => t.venues);
    let shown = false;
    let settled = false;
    const update = (patch: Partial<Turn>) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));

    const quick = postAsk({ ...payload, mode: "quick" })
      .then(async ({ ok, data }) => {
        if (!ok || !data.answer || settled) return;
        const venues = await placesFor(data, earlier);
        if (settled) return;
        shown = true;
        setTurns((ts) => [...ts, { id, q: prompt, answer: data.answer, sources: [], venues, pending: true }]);
        setLoading(false);
        pinTurn(venues);
      })
      .catch(() => undefined);

    const memory = postAsk({ ...payload, mode: "memory" })
      .then(async ({ ok, data }) => {
        const venues = ok && data.answer ? await placesFor(data, earlier) : [];
        await quick;
        settled = true;
        if (ok && data.answer && (venues.length || !shown)) {
          if (shown) update({ answer: data.answer, sources: data.sources ?? [], venues, pending: false });
          else setTurns((ts) => [...ts, { id, q: prompt, answer: data.answer, sources: data.sources ?? [], venues }]);
          pinTurn(venues);
        } else if (shown) {
          update({ pending: false });
        } else {
          setTurns((ts) => [...ts, { id, q: prompt, answer: null, sources: [], venues: [], error: data.error ?? "I couldn't come up with an answer just now. Try adding an area, a date or how many people?" }]);
        }
      })
      .catch(async () => {
        await quick;
        settled = true;
        if (shown) update({ pending: false });
        else setTurns((ts) => [...ts, { id, q: prompt, answer: null, sources: [], venues: [], error: "I can't reach Lumap right now. Check your connection and try again." }]);
      });

    await Promise.race([quick.then(() => (shown ? undefined : memory)), memory]);
    setLoading(false);
  }

  function submitQuestion(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question.trim());
  }

  return (
    <>
      <AnimatePresence>
        {!open ? (
          <motion.button
            key="ask-fab"
            type="button"
            onClick={() => setOpen(true)}
            initial={{ opacity: 0, y: 16, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.9 }}
            whileHover={{ y: -2 }}
            whileTap={{ scale: 0.96 }}
            className="fixed right-6 bottom-10 z-40 inline-flex h-12 items-center gap-2 rounded-full bg-[#7854f6] px-5 font-medium text-white shadow-[0_12px_30px_rgba(120,84,246,0.35)]"
          >
            <Sparkles className="h-4 w-4" /> Ask Lumap
          </motion.button>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {open ? (
          <motion.aside
            key="ask-panel"
            role="dialog"
            aria-label="Ask Lumap"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 280, damping: 30 }}
            className="fixed right-4 bottom-8 z-40 flex max-h-[calc(100vh-7rem)] w-[min(100vw-2rem,440px)] flex-col overflow-auto rounded-[24px] border border-[#ecebf0] bg-white/95 p-5 text-[#20202a] shadow-[0_24px_60px_rgba(35,30,65,0.18)] backdrop-blur-md"
          >
            <button type="button" onClick={() => setOpen(false)} aria-label="Close Ask" className="absolute top-4 right-4 rounded-full p-1.5 text-[#85838f] hover:bg-[#f4f3f7] hover:text-[#20202a]">
              <X className="h-4 w-4" />
            </button>

          <div className="mb-5 flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-[#f0ebff] text-[#7854f6]">
              <Sparkles className="h-5 w-5" aria-hidden="true" />
            </span>
            <div>
              <h2 className="text-xl font-semibold tracking-[-0.03em]">Ask Lumap</h2>
              <p className="mt-0.5 text-sm text-[#6f6d78]">Tell me what you&apos;re planning and I&apos;ll find you a spot</p>
            </div>
          </div>

          {turns.length === 0 ? (
            <div className="mb-2">
              <p className="mb-3 text-[15px] leading-6 text-[#4a4853]">
                Hi! I know the London spaces organisers actually use: coworking days, rooms for meetups, places for a party. Try one of these, or ask in your own words.
              </p>
              <div className="flex flex-col items-start gap-2">
                {EXAMPLES.map((ex) => (
                  <button key={ex} type="button" onClick={() => void ask(ex)} disabled={loading} className="rounded-2xl border border-[#e4ddfc] bg-[#faf9ff] px-3.5 py-2 text-left text-[14px] leading-5 text-[#4b3aa8] transition-colors hover:border-[#7854f6] hover:bg-[#f0ebff] disabled:opacity-60">
                    {ex}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => { setTurns([]); setError(""); }} className="mb-3 self-start text-xs font-medium text-[#7854f6] hover:underline">Start over</button>
          )}

          <div aria-live="polite" className="space-y-5">
            {turns.map((turn) => (
              <motion.div key={turn.id} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-3">
                <div className="ml-auto w-fit max-w-[85%] rounded-2xl rounded-br-md bg-[#7854f6] px-4 py-2.5 text-[15px] leading-6 text-white">{turn.q}</div>
                {turn.error ? (
                  <p role="alert" className="rounded-xl border border-[#f2d6d3] bg-[#fff8f7] px-4 py-3 text-sm text-[#9e4038]">{turn.error}</p>
                ) : turn.answer ? (
                  <div className="rounded-2xl rounded-bl-md bg-[#faf9ff] p-5">
                    <Answer text={turn.answer} places={turn.venues} onPick={pick} />
                    {turn.pending ? (
                      <p className="mt-3 flex items-center gap-2 text-xs text-[#8a8894]">
                        <LoaderCircle className="h-3.5 w-3.5 animate-spin text-[#b9a7fb]" aria-hidden="true" /> Checking what other organisers have shared…
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="rounded-2xl bg-[#faf9ff] p-5 text-sm leading-6 text-[#6f6d78]">I couldn&apos;t find anything for that one. Try adding an area, a date or how many people?</p>
                )}
                {turn.venues.length > 1 ? (
                  <button type="button" onClick={() => showOnMap(turn.venues, null, turn.venues.map((v) => v.id))} className="inline-flex items-center gap-1.5 rounded-full bg-[#7854f6] px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-sm transition-colors hover:bg-[#6842eb]">
                    <MapIcon className="h-3.5 w-3.5" aria-hidden="true" /> Show all {turn.venues.length} on map
                  </button>
                ) : null}
                {cleanSources(turn.sources).length ? (
                  <details className="text-xs text-[#8a8894]">
                    <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-[#5a3fd6]"><BookOpenText className="h-3.5 w-3.5" aria-hidden="true" /> Where this comes from</summary>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {cleanSources(turn.sources).map((src, i) => (
                        <span key={i} className="rounded-full border border-[#ecebf0] px-2.5 py-1 text-xs text-[#6f6d78]">{src}</span>
                      ))}
                    </div>
                  </details>
                ) : null}
              </motion.div>
            ))}
            {loading ? (
              <div className="flex items-center gap-2 rounded-2xl bg-[#faf9ff] p-4 text-sm text-[#6f6d78]">
                <LoaderCircle className="h-4 w-4 animate-spin text-[#7854f6]" /> Having a look around…
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          {error && (
            <p role="alert" className="mt-4 rounded-xl border border-[#f2d6d3] bg-[#fff8f7] px-4 py-3 text-sm text-[#9e4038]">
              {error}
            </p>
          )}

          <form onSubmit={submitQuestion} className="sticky bottom-0 -mx-5 -mb-5 mt-5 space-y-3 bg-gradient-to-t from-white via-white to-white/80 px-5 pt-3 pb-5">
            <label htmlFor="question" className="sr-only">Your question</label>
            <div className="rounded-2xl border border-[#e7e5ed] bg-[#fdfdfc] p-3 transition-colors focus-within:border-[#b9a7fb] focus-within:ring-2 focus-within:ring-[#7854f6]/10">
              <textarea
                id="question"
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={turns.length ? "Anything else? e.g. something closer to Liverpool Street" : "e.g. a room for 80 people on Saturday near Old Street"}
                rows={turns.length ? 2 : 3}
                maxLength={1000}
                className="min-h-20 w-full resize-y bg-transparent px-2 py-1 text-base leading-7 text-[#30303a] outline-none placeholder:text-[#a3a1aa]"
              />
              <div className="flex items-center justify-between border-t border-[#efedf2] pt-3">
                <span className="px-2 text-xs text-[#92909b]">I only suggest places I actually know about.</span>
                <div className="flex items-center gap-2">
                  {speechSupported && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      aria-label={listening ? "Stop voice input" : "Start voice input"}
                      aria-pressed={listening}
                      onClick={toggleListening}
                      className={listening ? "h-11 w-11 rounded-xl border-[#e8e7ed] bg-[#f0ebff] text-[#7854f6]" : "h-11 w-11 rounded-xl border-[#e8e7ed] bg-white text-[#6f6d78]"}
                    >
                      <Mic className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    type="submit"
                    disabled={!question.trim() || loading}
                    className="h-11 gap-2 rounded-xl bg-[#7854f6] px-4 text-white hover:bg-[#6842eb]"
                  >
                    {loading ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
                    <span>{loading ? "Asking…" : turns.length ? "Follow up" : "Ask Lumap"}</span>
                  </Button>
                </div>
              </div>
            </div>
          </form>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </>
  );
}
