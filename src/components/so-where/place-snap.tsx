"use client";

// "Snap a place": point the camera at a pub / café front → POST /api/place-snap → the place on the map with
// "Open now until 23:00", why here, and "Meet here" / "Send to a friend". The photo is only sent for that one
// request and never stored (the data URL lives in memory until the panel is cleared). Faces are blurred on the
// device first (lib/face-blur.ts): the preview and the upload are the blurred copy, never the original.
// Certainty (lib/snap-certainty.ts): high → show the place; medium → "Is this X, Area?" Yes / Not this one;
// low → say what was unclear ("Too blurry to read the sign") with Retake / Type the name. Never a guessed name.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Camera, Check, ChevronRight, FlaskConical, HelpCircle, ImageUp, Keyboard, Loader2, MapPin, RotateCcw, ScanLine, Search, ShieldCheck, Store, X } from "lucide-react";
import { blurFaces, warmFaceBlur, type FaceBlur } from "@/lib/face-blur";
import { FaceChip } from "./face-chip";
import type { Fact, LatLng, PlanCard, PlanResultWithAgent } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import type { Blurb } from "./use-plan";
import { TONE_CLASS, type OpenTone } from "./answers";
import { PosterSnap, type PosterSnapProps } from "./poster-snap";
import { useCameraSnap } from "./camera-viewfinder";

// ---------- Response contract (read defensively) ----------
export type SnapCertainty = "high" | "medium" | "low";
export type SnapExtracted = { name: string | null; kind: string | null; signText: string | null; cuisine?: string | null; confidence: number; certainty?: SnapCertainty; issue?: string | null };
export type SnapPlace = {
  id?: string;
  name: string;
  lat?: number;
  lng?: number;
  location?: LatLng;
  address?: string | null;
  area?: string | null;
  subtitle?: string;
  kind?: string | null;
  openAtPlan?: boolean | null;
  closesAt?: string | null;
  opensAt?: string | null;
  closingSoon?: boolean | null;
  hoursKnown?: boolean | null;
  blurb?: Blurb | null;
  url?: string;
  facts?: Fact[];
  [k: string]: unknown;
};
export type PlaceSnapResponse = { extracted: SnapExtracted; place?: SnapPlace | null; candidates?: SnapPlace[] | null; message?: string | null; suggestedQuery?: string | null; nearbyQuery?: string | null; certainty?: SnapCertainty; reason?: string | null; typed?: boolean };

/** What the app needs to show a matched place: a one-card result for the map + detail panel. */
export type SnapView = { result: PlanResultWithAgent & { snapOnly: true; youKnown: boolean }; card: PlanCard; place: SnapPlace; query: string; draft: string; open: { text: string; tone: OpenTone }; example: boolean; landmark: boolean; nearbyQuery: string };

const cap = (s: string) => s.replace(/^\w/, (c) => c.toUpperCase());
const clock = (t: string) => (/^(00|24):00$/.test(t) ? "midnight" : t);
const hhmm = (v: unknown) => (typeof v === "string" ? v.match(/\b([01]?\d|2[0-4]):[0-5]\d\b/)?.[0] : undefined);

const coords = (p: SnapPlace): LatLng | null => {
  const lat = p.location?.lat ?? p.lat;
  const lng = p.location?.lng ?? p.lng;
  return typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
};

/** Landmarks (a university, a monument) have no opening hours worth showing. */
export const isLandmark = (p: SnapPlace) => p.kind === "landmark";

/** "Open now until 23:00" / "Closes soon · 23:00" / "Closed now · opens 12:00" / "Hours not listed". */
export function openNow(p: SnapPlace): { text: string; tone: OpenTone } {
  const closes = hhmm(p.closesAt);
  const opens = hhmm(p.opensAt);
  if (p.openAtPlan === true) {
    if (p.closingSoon) return { text: closes ? `Closes soon · ${clock(closes)}` : "Closes soon", tone: "soon" };
    return { text: closes ? `Open now until ${clock(closes)}` : "Open now", tone: "ok" };
  }
  if (p.openAtPlan === false) return { text: `Closed now${opens ? ` · opens ${opens}` : ""}`, tone: "closed" };
  return { text: "Hours not listed", tone: "unknown" };
}

function placeKind(p: SnapPlace, x: SnapExtracted) {
  return cap((p.kind || x.kind || "Place").toString().replace(/_/g, " ")).replace(/^Cafe$/, "Café");
}

export function snapView(r: PlaceSnapResponse, p: SnapPlace, you: LatLng | null, example = false): SnapView | null {
  const loc = coords(p);
  if (!loc || !p.name) return null;
  const kind = placeKind(p, r.extracted);
  const subtitle = typeof p.subtitle === "string" && p.subtitle ? p.subtitle : [kind, p.address].filter(Boolean).join(" · ");
  const landmark = isLandmark(p);
  const open = landmark ? { text: "", tone: "unknown" as OpenTone } : openNow(p);
  const facts: Fact[] = Array.isArray(p.facts) && p.facts.length
    ? p.facts
    : landmark || p.hoursKnown === false || p.openAtPlan == null
      ? []
      : [{ label: "Open now", value: p.openAtPlan ? (hhmm(p.closesAt) ? `Open until ${hhmm(p.closesAt)}` : "Open now") : "Closed now", verdict: "likely", source: "OSM" }];
  const card: PlanCard = { ...(p as object), id: p.id || `snap-${p.name.toLowerCase().replace(/\W+/g, "-")}`, kind: "venue", name: p.name, subtitle, location: loc, legs: [], facts, why: p.blurb?.text ?? "", url: typeof p.url === "string" ? p.url : undefined } as PlanCard;
  const now = new Date().toISOString();
  const query = (r.suggestedQuery || `Meet at ${p.name}`).trim();
  const area = typeof p.area === "string" && p.area.trim() && !/[[\]]/.test(p.area) ? p.area.trim() : "";
  const draft = `Found this place: ${p.name}${area ? ` (${area})` : ""}. Fancy it?\nhttps://maps.google.com/?q=${loc.lat.toFixed(5)},${loc.lng.toFixed(5)}`;
  const result = {
    intent: "near_me", query, headline: `${p.name}`, when: now, you: you ?? loc, filters: {}, cards: [card], unknowns: [],
    sources: [{ name: "Your photo", asOf: now }], draftMessage: draft, steps: [], snapOnly: true as const, youKnown: !!you,
  } as SnapView["result"];
  const nearbyQuery = (r.nearbyQuery || `Coffee near ${p.name}`).trim();
  return { result, card, place: p, query, draft, open, example, landmark, nearbyQuery };
}

// ---------- Demo fixtures (?demo=place | place-medium | place-low | place-candidates | place-nomatch | place-landmark) ----------
const KINGS: SnapPlace = {
  id: "demo-kings-arms", name: "The Kings Arms", kind: "pub", lat: 51.50352, lng: -0.10876, address: "25 Roupell Street, SE1", area: "Waterloo",
  openAtPlan: true, closesAt: "23:00", closingSoon: false, hoursKnown: true,
  blurb: { text: "A tiny Victorian corner pub on a quiet terraced street, known for real ales and Thai food out back.", bestFor: "Catching up", source: { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/The_Kings_Arms,_Waterloo" } },
};
const DEMO: Record<string, PlaceSnapResponse> = {
  place: { extracted: { name: "The Kings Arms", kind: "pub", signText: "THE KINGS ARMS · FREE HOUSE", confidence: 0.92 }, place: KINGS, suggestedQuery: "Meet at The Kings Arms" },
  "place-candidates": {
    extracted: { name: "Kings Arms", kind: "pub", signText: "KINGS ARMS", confidence: 0.61 },
    candidates: [
      KINGS,
      { id: "demo-kings-arms-borough", name: "The Kings Arms", kind: "pub", lat: 51.50236, lng: -0.09021, address: "65 Newcomen Street, SE1", area: "Borough", openAtPlan: true, closesAt: "23:30", hoursKnown: true },
      { id: "demo-kings-arms-soho", name: "King's Arms", kind: "pub", lat: 51.51478, lng: -0.13703, address: "23 Poland Street, W1F", area: "Soho", openAtPlan: false, opensAt: "12:00", hoursKnown: true },
    ],
    message: "A few places match that sign.",
    suggestedQuery: "Meet at The Kings Arms",
  },
  "place-landmark": {
    extracted: { name: "University of Greenwich", kind: "landmark", signText: "UNIVERSITY OF GREENWICH · OLD ROYAL NAVAL COLLEGE", confidence: 0.88 },
    place: {
      id: "demo-uni-greenwich", name: "University of Greenwich", kind: "landmark", lat: 51.4827, lng: -0.0077, address: "Old Royal Naval College, Park Row, SE10", area: "Greenwich", hoursKnown: false,
      blurb: { text: "Wren's baroque riverside college, now the university's Greenwich campus, with the Painted Hall next door.", bestFor: "A walk by the river", source: { name: "Wikipedia", url: "https://en.wikipedia.org/wiki/University_of_Greenwich" } },
    },
    suggestedQuery: "Meet at the University of Greenwich",
    nearbyQuery: "Coffee near the University of Greenwich",
  },
  "place-medium": { extracted: { name: "The Kings Arms", kind: "pub", signText: "THE KI.. ARMS", confidence: 0.7, certainty: "medium", issue: "glare" }, place: KINGS, certainty: "medium", reason: "Glare is hiding the sign", suggestedQuery: "Meet at The Kings Arms" },
  "place-low": { extracted: { name: null, kind: "pub", signText: null, confidence: 0, certainty: "low", issue: "blurry" }, certainty: "low", reason: "Too blurry to read the sign", message: "Too blurry to read the sign", suggestedQuery: null },
  "place-nomatch": { extracted: { name: null, kind: "café", signText: "…ESPRESSO BAR", confidence: 0.3 }, message: "Couldn't match that sign to a place nearby.", suggestedQuery: null },
};
const DEMO_PHOTO =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe3ee"/><stop offset="1" stop-color="#f3e7d6"/></linearGradient></defs><rect width="240" height="320" fill="url(#s)"/><rect x="18" y="40" width="204" height="280" fill="#8a4b2d"/><g fill="#a65f3a">${Array.from({ length: 14 }, (_, i) => `<rect x="18" y="${44 + i * 20}" width="204" height="2"/>`).join("")}</g><rect x="26" y="118" width="188" height="202" fill="#173b2c"/><rect x="34" y="128" width="172" height="34" rx="3" fill="#0f2a1f" stroke="#c9a54a" stroke-width="2"/><text x="120" y="151" font-family="Georgia,serif" font-size="17" font-weight="700" fill="#e9c766" text-anchor="middle" letter-spacing="1.5">THE KINGS ARMS</text><rect x="40" y="176" width="70" height="96" fill="#f6d79a" opacity=".85"/><rect x="130" y="176" width="70" height="144" fill="#0b2018"/><rect x="134" y="182" width="62" height="70" fill="#f6d79a" opacity=".7"/><rect x="40" y="58" width="56" height="44" fill="#e8eef2" opacity=".8"/><rect x="144" y="58" width="56" height="44" fill="#e8eef2" opacity=".8"/></svg>`,
  );

const DEMO_PHOTO_LANDMARK =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfe3ee"/><stop offset="1" stop-color="#f1ece2"/></linearGradient></defs><rect width="240" height="320" fill="url(#s)"/><rect x="88" y="40" width="64" height="40" fill="#e7dfcf"/><ellipse cx="120" cy="40" rx="26" ry="20" fill="#d9cfbb"/><rect x="117" y="6" width="6" height="16" fill="#cbbfa8"/><rect x="20" y="80" width="200" height="240" fill="#ece4d3"/><polygon points="20,80 120,52 220,80" fill="#ddd3bf"/><g fill="#d6ccb6">${Array.from({ length: 8 }, (_, i) => `<rect x="${30 + i * 25}" y="96" width="9" height="150"/>`).join("")}</g><rect x="20" y="246" width="200" height="74" fill="#e2d9c6"/><rect x="40" y="258" width="160" height="30" rx="2" fill="#1f3550"/><text x="120" y="278" font-family="Georgia,serif" font-size="12.5" font-weight="700" fill="#f4ead2" text-anchor="middle" letter-spacing="1">UNIVERSITY OF GREENWICH</text></svg>`,
  );

// ---------- Image prep (same limits as the poster: longest side ≤ 1600 px, JPEG ≤ 4 MB) ----------
const MAX_SIDE = 1600;
const MAX_BYTES = 4 * 1024 * 1024;
async function toJpeg(src: Blob | HTMLVideoElement, onBlur?: () => void): Promise<{ blob: Blob; faces: FaceBlur }> {
  let w: number, h: number, draw: (c: CanvasRenderingContext2D, w: number, h: number) => void, close = () => {};
  if (src instanceof HTMLVideoElement) {
    w = src.videoWidth;
    h = src.videoHeight;
    draw = (c, W, H) => c.drawImage(src, 0, 0, W, H);
  } else {
    let done = false;
    w = h = 0;
    draw = () => {};
    if ("createImageBitmap" in window) {
      try {
        const b = await createImageBitmap(src, { imageOrientation: "from-image" });
        w = b.width; h = b.height; draw = (c, W, H) => c.drawImage(b, 0, 0, W, H); close = () => b.close(); done = true;
      } catch { /* HEIC / old Safari: fall through */ }
    }
    if (!done) {
      const url = URL.createObjectURL(src);
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => { URL.revokeObjectURL(url); throw new Error("That file isn't an image this browser can open. Try a JPEG or PNG."); });
      w = img.naturalWidth; h = img.naturalHeight; draw = (c, W, H) => c.drawImage(img, 0, 0, W, H); close = () => URL.revokeObjectURL(url);
    }
  }
  try {
    if (!w || !h) throw new Error("Couldn't read the camera. Try Upload instead.");
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(w * k));
    canvas.height = Math.max(1, Math.round(h * k));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn't prepare the photo on this device.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    draw(ctx, canvas.width, canvas.height);
    close();
    // Faces are blurred in this canvas before anything is shown or encoded.
    onBlur?.();
    const faces = await blurFaces(canvas);
    for (const q of [0.85, 0.72, 0.6]) {
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", q));
      if (blob && blob.size <= MAX_BYTES) return { blob, faces };
    }
    throw new Error("That photo is still too big after shrinking. Try a smaller one.");
  } finally {
    close();
  }
}
const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error("Couldn't prepare the photo.")); r.readAsDataURL(b); });

const FRIENDLY: Record<number, string> = {
  400: "Couldn't read that photo. Try another one.",
  404: "Snap a place isn't switched on yet.",
  413: "That photo is too big. Try a smaller one.",
  415: "That file type isn't supported. Try a JPEG or PNG.",
  422: "Couldn't make out a sign. Get the name in frame and try again.",
  502: "The place reader hiccuped. Try again.",
  503: "Place snaps are busy right now. Try again in a moment.",
  504: "That took too long. Try again.",
};

type St =
  | { s: "idle" }
  | { s: "scanning"; preview: string | null; phase?: "blur" | "read" }
  | { s: "confirm"; preview: string; r: PlaceSnapResponse; chosen: SnapPlace; others: SnapPlace[] }
  | { s: "unclear"; preview: string; r: PlaceSnapResponse; typing?: boolean }
  | { s: "match"; preview: string; r: PlaceSnapResponse; chosen: SnapPlace; others: SnapPlace[] }
  | { s: "pick"; preview: string; r: PlaceSnapResponse }
  | { s: "nomatch"; preview: string; r: PlaceSnapResponse }
  | { s: "error"; preview?: string; msg: string };

export type PlaceSnapProps = {
  /** Device location, already rounded to ~100 m by the caller (sent once, never stored). */
  you: LatLng | null;
  /** ?demo=place | place-medium | place-low | place-candidates | place-nomatch: canned response, labelled Example data. */
  demo?: string | null;
  onMatch: (v: SnapView) => void;
  className?: string;
};

export function PlaceSnap({ you, demo, onMatch, className }: PlaceSnapProps) {
  const [st, setSt] = useState<St>({ s: "idle" });
  const [area, setArea] = useState("");
  const [drag, setDrag] = useState(false);
  const [more, setMore] = useState(false);
  const [faces, setFaces] = useState<FaceBlur | null>(null);
  const [typed, setTyped] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const image = useRef<string | null>(null); // in memory only; dropped on clear / unmount
  const previewUrl = useRef<string | null>(null);
  const demoRan = useRef(false);
  const isExample = !!demo && demo in DEMO;

  // Panel open → start loading the face detector, so the first photo isn't held up.
  useEffect(() => {
    const t = window.setTimeout(warmFaceBlur, 400);
    return () => window.clearTimeout(t);
  }, []);
  useEffect(() => {
    return () => {
      abort.current?.abort();
      image.current = null;
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    };
  }, []);

  const show = useCallback(
    (r: PlaceSnapResponse, preview: string, example: boolean) => {
      const cands = (Array.isArray(r.candidates) ? r.candidates : []).filter((c) => c && coords(c)).slice(0, 3);
      const match = r.place && coords(r.place) ? r.place : cands.length === 1 ? cands[0] : null;
      if (r.certainty === "low") setSt({ s: "unclear", preview, r });
      else if (r.certainty === "medium" && match) setSt({ s: "confirm", preview, r, chosen: match, others: cands.filter((c) => c.id !== match.id) });
      else if (match === r.place && match) {
        const v = snapView(r, match, you, example);
        setSt({ s: "match", preview, r, chosen: match, others: cands.filter((c) => c.id !== match.id) });
        if (v) onMatch(v);
      } else if (cands.length === 1) {
        const v = snapView(r, cands[0], you, example);
        setSt({ s: "match", preview, r, chosen: cands[0], others: [] });
        if (v) onMatch(v);
      } else if (cands.length) setSt({ s: "pick", preview, r });
      else setSt({ s: "nomatch", preview, r });
    },
    [you, onMatch],
  );

  const send = useCallback(
    async (dataUrl: string | null, preview: string, hint?: string) => {
      abort.current?.abort();
      const ac = new AbortController();
      abort.current = ac;
      setSt({ s: "scanning", preview, phase: "read" });
      try {
        const res = await fetch("/api/place-snap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // dataUrl === null: the user typed the name instead (no photo is sent).
          body: JSON.stringify({ ...(dataUrl ? { image: dataUrl } : { name: hint }), ...(you ? { you } : {}), ...(hint && dataUrl ? { area: hint } : {}) }),
          signal: AbortSignal.any ? AbortSignal.any([ac.signal, AbortSignal.timeout(25_000)]) : ac.signal,
        });
        const j = (await res.json().catch(() => null)) as (PlaceSnapResponse & { error?: string }) | null;
        if (ac.signal.aborted) return;
        if (!res.ok || !j || j.error || !j.extracted) return setSt({ s: "error", preview, msg: FRIENDLY[res.status] ?? (typeof j?.message === "string" && j.message) ?? "Couldn't read that photo. Try again." });
        show(j, preview, false);
      } catch (e) {
        if (ac.signal.aborted) return;
        const timeout = e instanceof Error && e.name === "TimeoutError";
        setSt({ s: "error", preview, msg: timeout ? FRIENDLY[504] : navigator.onLine === false ? "You look offline. Check your connection and try again." : "Couldn't reach the place reader. Try again." });
      }
    },
    [you, show],
  );

  const handle = useCallback(
    async (src: File | Blob | HTMLVideoElement | null | undefined) => {
      if (!src) return;
      if (!(src instanceof HTMLVideoElement)) {
        if (src.type && !src.type.startsWith("image/")) return setSt({ s: "error", msg: "That's not an image. Snap or pick a photo of the place." });
        if (src.size > 25 * 1024 * 1024) return setSt({ s: "error", msg: FRIENDLY[413] });
      }
      try {
        // Scan state straight away, but no preview yet: the raw photo is never shown, only the face-blurred copy.
        if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        previewUrl.current = null;
        setFaces(null);
        setTyped("");
        setSt({ s: "scanning", preview: null, phase: "blur" });
        const { blob: small, faces: f } = await toJpeg(src);
        setFaces(f);
        previewUrl.current = URL.createObjectURL(small);
        image.current = await toDataUrl(small);
        setArea("");
        await send(image.current, previewUrl.current);
      } catch (e) {
        setSt({ s: "error", msg: e instanceof Error && e.message ? e.message : "Couldn't prepare that photo." });
      }
    },
    [send],
  );

  // Live camera on every device that has one (phones: rear; laptops: webcam). Upload is the fallback.
  const typeName = (name: string) => {
    const n = name.trim();
    if (n.length < 2 || st.s !== "unclear") return;
    if (isExample) {
      setSt({ s: "scanning", preview: st.preview, phase: "read" });
      window.setTimeout(() => show(DEMO.place, st.preview, true), 900);
      return;
    }
    void send(null, st.preview, n);
  };

  const confirm = (yes: boolean) => {
    if (st.s !== "confirm") return;
    if (yes) {
      setSt({ s: "match", preview: st.preview, r: st.r, chosen: st.chosen, others: st.others });
      const v = snapView(st.r, st.chosen, you, isExample);
      if (v) onMatch(v);
    } else if (st.others.length) setSt({ s: "pick", preview: st.preview, r: { ...st.r, candidates: st.others, message: "Is it one of these?" } });
    else setSt({ s: "unclear", preview: st.preview, r: { ...st.r, reason: st.r.reason ?? "Couldn't be sure from the photo" }, typing: true });
  };

  const camera = useCameraSnap({ hint: "snap the sign", onShot: (b) => void handle(b), onUpload: () => file.current?.click() });
  const snapNow = () => {
    warmFaceBlur();
    if (st.s !== "idle") reset();
    void camera.start();
  };

  // Demo: a canned scan of The Kings Arms (offline).
  useEffect(() => {
    if (!isExample || demoRan.current) return;
    demoRan.current = true;
    const photo = demo === "place-landmark" ? DEMO_PHOTO_LANDMARK : DEMO_PHOTO;
    setSt({ s: "scanning", preview: photo, phase: "read" });
    const t = window.setTimeout(() => show(DEMO[demo!], photo, true), 1700);
    return () => window.clearTimeout(t);
  }, [isExample, demo, show]);

  // Desktop: paste a photo anywhere (not while typing).
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, [contenteditable='true']")) return;
      const it = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === "file" && i.type.startsWith("image/"));
      if (!it) return;
      e.preventDefault();
      void handle(it.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [handle]);

  const reset = () => {
    abort.current?.abort();
    image.current = null;
    if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    previewUrl.current = null;
    setFaces(null);
    setTyped("");
    setSt({ s: "idle" });
    if (file.current) file.current.value = "";
  };

  const pick = (p: SnapPlace) => {
    if (st.s !== "pick" && st.s !== "match") return;
    const all = st.s === "pick" ? (st.r.candidates ?? []) : [st.chosen, ...st.others];
    const v = snapView(st.r, p, you, isExample);
    setSt({ s: "match", preview: st.preview, r: st.r, chosen: p, others: all.filter((c) => c !== p).slice(0, 2) });
    if (v) onMatch(v);
  };

  const retryArea = () => {
    const a = area.trim();
    if (!a || st.s !== "nomatch") return;
    if (isExample) {
      setSt({ s: "scanning", preview: st.preview, phase: "read" });
      window.setTimeout(() => show(DEMO["place-candidates"], st.preview, true), 1200);
      return;
    }
    if (image.current) void send(image.current, st.preview, a);
  };

  const preview = st.s === "idle" || camera.active ? null : st.preview;
  const busy = st.s === "scanning";
  const showPanel = !camera.active && st.s !== "idle" && (preview != null || busy);

  return (
    <section aria-label="Snap a place" className={cn("relative", className)}>
      <input ref={file} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => void handle(e.target.files?.[0])} />

      {camera.active ? (
        camera.panel
      ) : !showPanel ? (
        <div
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files?.[0]); }}
          className={cn("flex flex-wrap items-center gap-2 rounded-[12px] border border-dashed p-2.5 transition-colors", drag ? "border-signal bg-signal-soft" : "border-signal/35")}
        >
          <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={snapNow} aria-label="Snap a place: take a photo of a pub or café front" className="sw-btn sw-btn-primary min-h-11 shrink-0 rounded-full px-4 text-[14px] font-semibold">
            <Camera className="size-[18px]" aria-hidden /> Snap a place
          </motion.button>
          <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={() => { warmFaceBlur(); file.current?.click(); }} className="sw-chip min-h-11 shrink-0 px-3.5 text-[14px] font-medium text-ink">
            <ImageUp className="size-4 text-ink-3" aria-hidden /> Upload
          </motion.button>
          <p className="min-w-0 flex-1 basis-[140px] text-[13px] leading-5 text-ink-3">Point at the sign. I&apos;ll say what it is and if it&apos;s open.</p>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <ScanThumb src={preview ?? null} busy={busy} />
          <div className="min-w-0 flex-1" aria-live="polite" aria-busy={busy}>
            <AnimatePresence mode="wait" initial={false}>
              {busy ? (
                <motion.p key="scan" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2 pt-1 text-[14px] font-medium text-ink">
                  <Loader2 className="size-4 animate-spin text-signal-strong motion-reduce:animate-none" aria-hidden />
                  <span className="sw-shimmer">{st.phase === "blur" ? "Blurring faces…" : "Reading the sign…"}</span>
                </motion.p>
              ) : st.s === "confirm" ? (
                <motion.div key="confirm" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                  <Kicker><HelpCircle className="size-3.5" strokeWidth={2.4} aria-hidden /> Not fully sure</Kicker>
                  <p className="mt-0.5 text-[15px] font-semibold leading-5 text-ink">Is this {st.chosen.name}{st.chosen.area ? `, ${st.chosen.area}` : ""}?</p>
                  {st.r.reason ? <p className="mt-0.5 text-[12.5px] leading-4 text-ink-3">{st.r.reason}</p> : null}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={() => confirm(true)} className="sw-btn sw-btn-primary min-h-11 rounded-full px-4 text-[14px] font-semibold"><Check className="size-4" strokeWidth={2.6} aria-hidden /> Yes</motion.button>
                    <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={() => confirm(false)} className="sw-chip min-h-11 px-3.5 text-[14px] font-medium text-ink">Not this one</motion.button>
                  </div>
                </motion.div>
              ) : st.s === "unclear" ? (
                <motion.div key="unclear" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                  <Kicker>Couldn&apos;t tell</Kicker>
                  <p className="mt-0.5 text-[14px] font-semibold leading-5 text-ink">{st.r.reason || st.r.message || "Couldn't read the sign clearly"}</p>
                  {st.typing ? (
                    <form onSubmit={(e) => { e.preventDefault(); typeName(typed); }} className="sw-field mt-2 flex items-center gap-1 p-1 pl-3">
                      <label htmlFor="snap-name" className="sr-only">Place name</label>
                      <Keyboard className="size-4 shrink-0 text-ink-3" aria-hidden />
                      <input id="snap-name" autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Place name" autoComplete="off" enterKeyHint="search" maxLength={80} className="min-w-0 flex-1 bg-transparent py-1.5 text-[16px] leading-6 text-ink caret-signal placeholder:text-ink-3 focus:outline-none" />
                      <button type="submit" disabled={typed.trim().length < 2} aria-label="Find that place" className="sw-btn sw-btn-primary size-10 shrink-0 rounded-full"><Search className="size-4" aria-hidden /></button>
                    </form>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={snapNow} className="sw-btn sw-btn-primary min-h-11 rounded-full px-4 text-[14px] font-semibold"><RotateCcw className="size-4" aria-hidden /> Retake</motion.button>
                      <motion.button type="button" whileTap={{ scale: 0.95 }} onClick={() => setSt({ ...st, typing: true })} className="sw-chip min-h-11 px-3.5 text-[14px] font-medium text-ink"><Keyboard className="size-4 text-ink-3" aria-hidden /> Type the name</motion.button>
                    </div>
                  )}
                </motion.div>
              ) : st.s === "match" ? (
                <Matched key={"m" + (st.chosen.id ?? st.chosen.name)} r={st.r} p={st.chosen} hasOthers={st.others.length > 0} more={more} onMore={() => setMore((m) => !m)} />
              ) : st.s === "pick" ? (
                <motion.div key="pick" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                  <Kicker>Which one?</Kicker>
                  <p className="mt-0.5 text-[13px] leading-5 text-ink-2">{st.r.message || "A few places match that sign."}</p>
                </motion.div>
              ) : st.s === "nomatch" ? (
                <motion.div key="none" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>
                  <Kicker>{st.r.extracted.name || st.r.extracted.signText ? `Read: ${st.r.extracted.name ?? st.r.extracted.signText}` : "No match"}</Kicker>
                  <p className="mt-0.5 text-[14px] font-medium leading-5 text-ink">{st.r.message || "Couldn't find that place."}</p>
                  <form onSubmit={(e) => { e.preventDefault(); retryArea(); }} className="sw-field mt-2 flex items-center gap-1 p-1 pl-3">
                    <label htmlFor="snap-area" className="sr-only">Which area was it in?</label>
                    <MapPin className="size-4 shrink-0 text-ink-3" aria-hidden />
                    <input id="snap-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Which area?" autoComplete="off" enterKeyHint="search" className="min-w-0 flex-1 bg-transparent py-1.5 text-[16px] leading-6 text-ink caret-signal placeholder:text-ink-3 focus:outline-none" />
                    <button type="submit" disabled={!area.trim()} aria-label="Look again in that area" className="sw-btn sw-btn-primary size-10 shrink-0 rounded-full"><Search className="size-4" aria-hidden /></button>
                  </form>
                </motion.div>
              ) : st.s === "error" ? (
                <motion.div key="err" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} role="alert" className="pt-1">
                  <p className="text-[14px] font-medium leading-5 text-ink">{st.msg}</p>
                  <button type="button" onClick={snapNow} className="sw-btn mt-2 min-h-11 rounded-full bg-signal-soft px-4 text-[14px] font-semibold text-signal-ink">
                    <RotateCcw className="size-4" aria-hidden /> Try another photo
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <button type="button" onClick={reset} aria-label={busy ? "Cancel" : "Clear the photo"} className="sw-btn grid size-9 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-sunk hover:text-ink">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}
      {/* Candidates go full width under the photo, so names and hours fit on phones. */}
      {st.s === "pick" ? <Picker items={(st.r.candidates ?? []).filter((c) => coords(c)).slice(0, 3)} r={st.r} onPick={pick} /> : null}
      <AnimatePresence initial={false}>
        {st.s === "match" && more && st.others.length ? (
          <motion.div key="more" initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <Picker items={st.others} r={st.r} onPick={(c) => { setMore(false); pick(c); }} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {st.s === "error" && !preview ? <p role="alert" className="mt-2 px-1 text-[13px] font-medium text-signal-ink">{st.msg}</p> : null}

      <p className="mt-2 flex items-center gap-1.5 px-1 text-[11.5px] leading-4 text-ink-3">
        <ShieldCheck className="size-3.5 shrink-0" aria-hidden /> Photo isn&apos;t saved.
        {!isExample ? <FaceChip faces={faces} /> : null}
        {isExample ? <span className="ml-auto inline-flex h-5 items-center gap-1 rounded-full bg-likely-bg px-2 text-[11px] font-semibold text-likely"><FlaskConical className="size-3" aria-hidden /> Example data</span> : null}
      </p>
    </section>
  );
}

function Kicker({ children }: { children: React.ReactNode }) {
  return <p className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-signal-ink">{children}</p>;
}

function OpenDot({ tone }: { tone: OpenTone }) {
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", tone === "ok" ? "bg-ok" : tone === "unknown" ? "bg-unknown" : "bg-amber-ink")} />;
}

function Matched({ r, p, hasOthers, more, onMore }: { r: PlaceSnapResponse; p: SnapPlace; hasOthers: boolean; more: boolean; onMore: () => void }) {
  const o = openNow(p);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}>
      <Kicker><Check className="size-3.5" strokeWidth={2.6} aria-hidden /> Found{r.extracted.confidence < 0.5 ? <span className="font-medium normal-case tracking-normal text-ink-3">· not sure, check it</span> : null}</Kicker>
      <p className="mt-0.5 text-[15px] font-semibold leading-5 text-ink">{p.name}</p>
      {isLandmark(p) ? (
        <p className="mt-0.5 text-[13px] font-medium text-ink-2">Landmark{p.area ? ` · ${p.area}` : ""}</p>
      ) : (
        <p className={cn("mt-0.5 flex items-center gap-1.5 text-[13px] font-medium", TONE_CLASS[o.tone])}><OpenDot tone={o.tone} />{o.text}</p>
      )}
      <p className="mt-1 text-[12.5px] text-ink-3">Details are open on the map.</p>
      {hasOthers ? (
        <button type="button" onClick={onMore} aria-expanded={more} className="mt-1.5 min-h-8 text-[13px] font-semibold text-signal-ink underline-offset-2 hover:underline">{more ? "Hide others" : "Not it?"}</button>
      ) : null}
    </motion.div>
  );
}

/** Mini picker: up to 3 candidates, name · area · open state. */
function Picker({ items, r, onPick }: { items: SnapPlace[]; r: PlaceSnapResponse; onPick: (p: SnapPlace) => void }) {
  return (
    <ul className="mt-2.5 flex flex-col gap-1.5" aria-label="Possible places">
      {items.map((c, i) => {
        const o = openNow(c);
        return (
          <motion.li key={(c.id ?? c.name) + i} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05 }}>
            <button type="button" onClick={() => onPick(c)} className="group flex min-h-12 w-full cursor-pointer items-center gap-2.5 rounded-[12px] bg-white/80 px-2.5 py-2 text-left shadow-e1 ring-1 ring-white/80 transition-colors hover:bg-white hover:ring-signal/30">
              <span className="grid size-8 shrink-0 place-items-center rounded-full bg-signal-soft text-signal-ink"><Store className="size-4" aria-hidden /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-semibold leading-5 text-ink">{c.name}</span>
                <span className="block truncate text-[12.5px] leading-4 text-ink-3">{[c.area, placeKind(c, r.extracted)].filter(Boolean).join(" · ")}</span>
                {isLandmark(c) ? null : <span className={cn("mt-0.5 flex items-center gap-1.5 truncate text-[12.5px] font-medium leading-4", TONE_CLASS[o.tone])}><OpenDot tone={o.tone} />{o.text}</span>}
              </span>
              <ChevronRight className="size-4 shrink-0 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
            </button>
          </motion.li>
        );
      })}
    </ul>
  );
}

/** Photo thumbnail; while reading, a frosted veil with an orange scan line (static with reduced motion). */
function ScanThumb({ src, busy }: { src: string | null; busy: boolean }) {
  const reduce = useReducedMotion();
  return (
    <div className="relative h-28 w-[84px] shrink-0 overflow-hidden rounded-[12px] bg-sunk shadow-e1 ring-1 ring-black/5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {src ? <img src={src} alt="Your photo of the place (faces blurred)" className="size-full object-cover" /> : <span aria-hidden className="absolute inset-0 bg-gradient-to-b from-signal-soft to-sunk" />}
      <AnimatePresence>
        {busy ? (
          <motion.div key="veil" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0">
            <span aria-hidden className="absolute inset-0 bg-white/25 backdrop-blur-[1.5px]" />
            {["left-1.5 top-1.5 border-l-2 border-t-2", "right-1.5 top-1.5 border-r-2 border-t-2", "bottom-1.5 left-1.5 border-b-2 border-l-2", "bottom-1.5 right-1.5 border-b-2 border-r-2"].map((c) => (
              <span key={c} aria-hidden className={cn("absolute size-3 rounded-[2px] border-white", c)} />
            ))}
            {reduce ? (
              <span aria-hidden className="absolute inset-x-1 top-1/2 h-[2px] rounded-full bg-signal shadow-[0_0_10px_2px_rgba(255,107,44,.6)]" />
            ) : (
              <motion.span
                aria-hidden
                className="absolute inset-x-1 h-[2px] rounded-full bg-signal shadow-[0_0_12px_3px_rgba(255,107,44,.55)]"
                initial={{ top: "8%" }}
                animate={{ top: ["8%", "92%", "8%"] }}
                transition={{ duration: 1.6, ease: "easeInOut", repeat: Infinity }}
              />
            )}
            <span aria-hidden className="absolute inset-0 grid place-items-center"><ScanLine className="size-5 text-white drop-shadow" /></span>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ---------- Segmented sheet: "Snap a poster" | "Snap a place" ----------
export type SnapMode = "place" | "poster";
export function SnapSheet({ mode, onMode, poster, place, className }: { mode: SnapMode; onMode: (m: SnapMode) => void; poster: PosterSnapProps; place: PlaceSnapProps; className?: string }) {
  const tabs: { id: SnapMode; label: string }[] = [
    { id: "place", label: "Snap a place" },
    { id: "poster", label: "Snap a poster" },
  ];
  return (
    <div className={cn("relative overflow-hidden rounded-[16px] bg-white/80 p-2 shadow-e3 ring-1 ring-signal/25 backdrop-blur-md", className)}>
      <div role="tablist" aria-label="What are you snapping?" className="relative mb-2 grid grid-cols-2 gap-1 rounded-full bg-sunk/80 p-1">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={mode === t.id} onClick={() => onMode(t.id)} className={cn("relative min-h-10 cursor-pointer rounded-full px-3 text-[13.5px] font-semibold transition-colors", mode === t.id ? "text-white" : "text-ink-2 hover:text-ink")}>
            {mode === t.id ? <motion.span layoutId="snap-tab" className="absolute inset-0 -z-0 rounded-full bg-signal-strong shadow-[var(--sw-shadow-red)]" transition={{ type: "spring", stiffness: 500, damping: 38 }} /> : null}
            <span className="relative">{t.label}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" className="px-1 pb-1">
        {mode === "place" ? <PlaceSnap {...place} /> : <PosterSnap {...poster} className={cn("!bg-transparent !p-0 !shadow-none !ring-0 !backdrop-blur-none", poster.className)} />}
      </div>
    </div>
  );
}
