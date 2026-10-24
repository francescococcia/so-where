"use client";

// "Snap a poster": photo (camera / file / drag-drop / paste) → downscaled JPEG → POST /api/poster →
// "Found: <title> · <venue> · Sat 19:00" with Plan it / Edit. The photo stays on the device apart from
// that one request (the server doesn't keep it either).
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Camera, Check, ImageUp, Loader2, Pencil, RotateCcw, ScanLine, Sparkles, X } from "lucide-react";

type Extracted = {
  kind: "event" | "venue" | "menu" | "other";
  title: string | null;
  venueName: string | null;
  address: string | null;
  area: string | null;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  price: string | null;
  free: boolean | null;
  needsRegistration: boolean | null;
  url: string | null;
  confidence: number;
  notes: string | null;
};
type PosterResult = { extracted: Extracted; place?: { name: string; lat: number; lng: number; address: string | null }; suggestedQuery: string | null; message?: string };

export type PosterSnapProps = {
  /** Run the plan with this ask (send it as the /api/plan query). */
  onPlan: (query: string) => void;
  /** Put this ask in the input for the user to tweak. */
  onEdit: (query: string) => void;
  /** The user's earlier halfway ask, so the poster becomes "Meet halfway for …". */
  context?: { query: string } | null;
  className?: string;
};

const MAX_SIDE = 1600;
const MAX_BYTES = 4 * 1024 * 1024;

async function loadBitmap(file: Blob): Promise<{ w: number; h: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void; close: () => void }> {
  if ("createImageBitmap" in window) {
    try {
      const b = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { w: b.width, h: b.height, draw: (c, w, h) => c.drawImage(b, 0, 0, w, h), close: () => b.close() };
    } catch {
      /* fall through (HEIC on some browsers, old Safari) */
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode().catch(() => {
    URL.revokeObjectURL(url);
    throw new Error("That file isn't an image this browser can open. Try a JPEG or PNG.");
  });
  return { w: img.naturalWidth, h: img.naturalHeight, draw: (c, w, h) => c.drawImage(img, 0, 0, w, h), close: () => URL.revokeObjectURL(url) };
}

/** Longest side ≤ 1600 px, JPEG, ≤ 4 MB. */
async function downscale(file: Blob): Promise<Blob> {
  const bm = await loadBitmap(file);
  try {
    const k = Math.min(1, MAX_SIDE / Math.max(bm.w, bm.h));
    const w = Math.max(1, Math.round(bm.w * k));
    const h = Math.max(1, Math.round(bm.h * k));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't prepare the photo on this device.");
    ctx.fillStyle = "#fff"; // transparent PNGs → white, not black
    ctx.fillRect(0, 0, w, h);
    bm.draw(ctx, w, h);
    for (const q of [0.85, 0.72, 0.6]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= MAX_BYTES) return blob;
    }
    throw new Error("That photo is still too big after shrinking. Try a smaller one.");
  } finally {
    bm.close();
  }
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function whenLabel(x: Extracted): string | null {
  const d = x.date ? new Date(`${x.date}T12:00:00Z`) : null;
  const day = d ? `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}` : null;
  const t = x.startTime ? `${x.startTime}${x.endTime ? `–${x.endTime}` : ""}` : null;
  return [day, t].filter(Boolean).join(" ") || null;
}

type State =
  | { s: "idle" }
  | { s: "scanning"; preview: string }
  | { s: "found"; preview: string; r: PosterResult }
  | { s: "error"; preview?: string; msg: string };

export function PosterSnap({ onPlan, onEdit, context, className }: PosterSnapProps) {
  const [st, setSt] = useState<State>({ s: "idle" });
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const previewUrl = useRef<string | null>(null);
  const reduce = useReducedMotion();

  const setPreview = (blob: Blob | null) => {
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = blob ? URL.createObjectURL(blob) : null;
    return previewUrl.current ?? "";
  };
  useEffect(() => () => {
    abort.current?.abort();
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
  }, []);

  const reset = () => {
    abort.current?.abort();
    setPreview(null);
    setSt({ s: "idle" });
    if (input.current) input.current.value = "";
  };

  const handle = useCallback(
    async (file: File | Blob | null | undefined) => {
      if (!file) return;
      if (file.type && !file.type.startsWith("image/")) return setSt({ s: "error", msg: "That's not an image. Snap or pick a photo of the poster." });
      if (file.size > 25 * 1024 * 1024) return setSt({ s: "error", msg: "That file is too big. Try a smaller photo." });
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      let preview = "";
      try {
        const small = await downscale(file);
        preview = setPreview(small);
        setSt({ s: "scanning", preview });
        const fd = new FormData();
        fd.append("image", small, "poster.jpg");
        if (context?.query) fd.append("context", JSON.stringify({ query: context.query }));
        const res = await fetch("/api/poster", { method: "POST", body: fd, signal: AbortSignal.any ? AbortSignal.any([ac.signal, AbortSignal.timeout(20_000)]) : ac.signal });
        const j = (await res.json().catch(() => null)) as (PosterResult & { error?: string }) | null;
        if (ac.signal.aborted) return;
        if (!res.ok || !j || j.error) return setSt({ s: "error", preview, msg: j?.error ?? "Couldn't read that photo. Try again." });
        setSt({ s: "found", preview, r: j });
      } catch (e) {
        if (ac.signal.aborted) return;
        const timeout = e instanceof Error && e.name === "TimeoutError";
        setSt({ s: "error", preview: preview || undefined, msg: timeout ? "Reading the poster took too long. Try again." : e instanceof Error && e.message && !/fetch|network/i.test(e.message) ? e.message : "Couldn't reach the poster reader. Check your connection and try again." });
      }
    },
    [context?.query],
  );

  // Desktop: paste a screenshot / copied image anywhere (not while typing in a field).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, [contenteditable='true']"))) return;
      const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      void handle(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handle]);

  const busy = st.s === "scanning";
  const preview = st.s === "idle" ? null : st.preview;

  return (
    <section
      aria-label="Snap a poster"
      className={`relative overflow-hidden rounded-[16px] bg-white/80 p-3 shadow-e3 ring-1 ring-signal/25 backdrop-blur-md ${className ?? ""}`}
    >
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(e) => void handle(e.target.files?.[0])}
      />

      {!preview ? (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            void handle(e.dataTransfer.files?.[0]);
          }}
          className={`flex items-center gap-3 rounded-[12px] border border-dashed p-2.5 transition-colors ${drag ? "border-signal bg-signal-soft" : "border-signal/35"}`}
        >
          <motion.button
            type="button"
            whileTap={{ scale: 0.95 }}
            onClick={() => input.current?.click()}
            aria-label="Snap a poster: take or choose a photo of an event poster, venue sign or menu"
            className="sw-btn sw-btn-primary min-h-11 shrink-0 rounded-full px-4 text-[14px] font-semibold"
          >
            <Camera className="size-[18px]" aria-hidden /> Snap a poster
          </motion.button>
          <p className="min-w-0 text-[13px] leading-5 text-ink-3">
            <span className="hidden sm:inline"><ImageUp className="mr-1 inline size-4 align-[-3px]" aria-hidden />Drop or paste an image. </span>
            I&apos;ll read the event, venue and time.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <div className="relative h-24 w-[72px] shrink-0 overflow-hidden rounded-[10px] bg-sunk ring-1 ring-black/5">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="Your poster photo" className="size-full object-cover" />
            {busy ? (
              <>
                <span aria-hidden className="absolute inset-0 bg-gradient-to-b from-signal/10 via-transparent to-signal/10" />
                {!reduce ? (
                  <motion.span
                    aria-hidden
                    className="absolute inset-x-0 h-8 bg-gradient-to-b from-transparent via-signal/55 to-transparent"
                    initial={{ top: "-30%" }}
                    animate={{ top: ["-30%", "100%", "-30%"] }}
                    transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
                  />
                ) : null}
                <span aria-hidden className="absolute inset-0 grid place-items-center"><ScanLine className="size-6 text-white drop-shadow" /></span>
              </>
            ) : null}
          </div>

          <div className="min-w-0 flex-1" aria-live="polite" aria-busy={busy}>
            <AnimatePresence mode="wait" initial={false}>
              {busy ? (
                <motion.p key="scan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2 pt-1 text-[14px] font-medium text-ink">
                  <Loader2 className="size-4 animate-spin text-signal-strong motion-reduce:animate-none" aria-hidden />
                  <span className="sw-shimmer">Reading the poster…</span>
                </motion.p>
              ) : st.s === "found" ? (
                <Found key="found" r={st.r} onPlan={onPlan} onEdit={onEdit} />
              ) : st.s === "error" ? (
                <motion.div key="err" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} role="alert" className="pt-1">
                  <p className="text-[14px] font-medium leading-5 text-ink">{st.msg}</p>
                  <button type="button" onClick={() => input.current?.click()} className="sw-btn mt-2 min-h-11 rounded-full bg-signal-soft px-4 text-[14px] font-semibold text-signal-ink">
                    <RotateCcw className="size-4" aria-hidden /> Try another photo
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>

          <button type="button" onClick={reset} aria-label={busy ? "Cancel reading the poster" : "Clear the poster"} className="sw-btn grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-sunk hover:text-ink">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}

      {st.s === "error" && !preview ? (
        <p role="alert" className="mt-2 px-1 text-[13px] font-medium text-signal-ink">{st.msg}</p>
      ) : null}
    </section>
  );
}

function Found({ r, onPlan, onEdit }: { r: PosterResult; onPlan: (q: string) => void; onEdit: (q: string) => void }) {
  const x = r.extracted;
  const venue = r.place?.name ?? x.venueName ?? x.address ?? x.area;
  const bits = [x.kind === "event" ? x.title : null, venue, whenLabel(x)].filter(Boolean) as string[];
  const extra = [x.free ? "Free" : x.price, x.needsRegistration ? "Sign-up needed" : null].filter(Boolean).join(" · ");
  const q = r.suggestedQuery;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
      <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-signal-ink">
        <Sparkles className="size-3.5" aria-hidden /> Found
        {x.confidence < 0.5 ? <span className="font-medium normal-case tracking-normal text-ink-3">· not sure, check it</span> : null}
      </p>
      <p className="mt-0.5 text-[15px] font-semibold leading-5 text-ink">{bits.length ? bits.join(" · ") : "Nothing I could plan from"}</p>
      {extra ? <p className="mt-0.5 text-[13px] text-ink-3">{extra}</p> : null}
      {r.message ? <p className="mt-1 text-[13px] leading-5 text-ink-2">{r.message}</p> : null}
      {q ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <motion.button type="button" whileTap={{ scale: 0.96 }} onClick={() => onPlan(q)} aria-label={`Plan it: ${q}`} className="sw-btn sw-btn-primary min-h-11 rounded-full px-4 text-[14px] font-semibold">
            <Check className="size-4" aria-hidden /> Plan it
          </motion.button>
          <motion.button type="button" whileTap={{ scale: 0.96 }} onClick={() => onEdit(q)} aria-label="Edit the ask before planning" className="sw-chip min-h-11 px-4 text-[14px] font-medium text-ink">
            <Pencil className="size-4" aria-hidden /> Edit
          </motion.button>
        </div>
      ) : null}
    </motion.div>
  );
}
