"use client";

// Shared live camera for "Snap a place" and "Snap a poster".
// getUserMedia is called straight from the click (so the browser shows its permission prompt), rear camera
// preferred, any camera otherwise (laptop webcams). Blocked → friendly copy + Upload; no camera / http → Upload.
// Frames never leave the device except the one photo the user takes; every track is stopped on close/capture/unmount.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Camera, CameraOff, ImageUp, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Cam =
  | { s: "off" }
  | { s: "asking" }
  | { s: "live"; stream: MediaStream; mirror: boolean }
  | { s: "problem"; msg: string };

const BLOCKED = "Camera blocked. Allow it in the address bar, or upload a photo.";
const BUSY = "The camera is busy in another app. Close it, or upload a photo.";
const NOCAM = "No camera found. Upload a photo instead.";

const errName = (e: unknown) => (e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "");

/** "Snap" → live viewfinder when possible. `onUpload` opens the file picker; `onShot` gets a full-size JPEG. */
export function useCameraSnap({ onShot, onUpload, hint }: { onShot: (b: Blob) => void; onUpload: () => void; hint: string }) {
  const [cam, setCam] = useState<Cam>({ s: "off" });
  const stream = useRef<MediaStream | null>(null);
  const alive = useRef(true);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }, []);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stop();
    };
  }, [stop]);

  const close = useCallback(() => {
    stop();
    setCam({ s: "off" });
  }, [stop]);

  /** Call from the click handler: the getUserMedia call happens synchronously inside the user gesture. */
  const start = useCallback(async () => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    // http (not localhost) or no API: no live camera possible → the picker (phones still offer their camera there).
    if (!window.isSecureContext || !md?.getUserMedia) return onUpload();
    stop();
    setCam({ s: "asking" });
    let s: MediaStream | null = null;
    try {
      s = await md.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    } catch (e) {
      const n = errName(e);
      if (n === "NotAllowedError" || n === "SecurityError") return alive.current && setCam({ s: "problem", msg: BLOCKED });
      if (n === "NotReadableError" || n === "AbortError") return alive.current && setCam({ s: "problem", msg: BUSY });
      // Overconstrained / NotFound with the rear-camera hint → try any camera.
      try {
        s = await md.getUserMedia({ video: true, audio: false });
      } catch (e2) {
        const n2 = errName(e2);
        if (!alive.current) return;
        if (n2 === "NotAllowedError" || n2 === "SecurityError") return setCam({ s: "problem", msg: BLOCKED });
        if (n2 === "NotReadableError" || n2 === "AbortError") return setCam({ s: "problem", msg: BUSY });
        setCam({ s: "problem", msg: NOCAM });
        return onUpload();
      }
    }
    if (!alive.current || !s) return s?.getTracks().forEach((t) => t.stop());
    stream.current = s;
    const facing = s.getVideoTracks()[0]?.getSettings().facingMode;
    // Mirror only front ("user") cameras, like a selfie view. Rear / unknown (most webcams) stay as-is so signs read right.
    setCam({ s: "live", stream: s, mirror: facing === "user" });
  }, [onUpload, stop]);

  const shot = useCallback(
    (b: Blob) => {
      stop();
      setCam({ s: "off" });
      onShot(b);
    },
    [onShot, stop],
  );

  const panel = (
    <AnimatePresence initial={false} mode="wait">
      {cam.s === "asking" ? (
        <motion.p key="ask" role="status" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="sw-glass-chip flex items-center gap-2 rounded-[12px] px-3 py-2.5 text-[13px] font-medium leading-5 text-ink">
          <Camera className="size-4 shrink-0 text-signal-strong" aria-hidden />
          <span>Allow camera to {hint}. <span className="text-ink-3">Photo isn&apos;t saved.</span></span>
          <button type="button" onClick={close} aria-label="Cancel" className="sw-btn ml-auto grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-sunk hover:text-ink">
            <X className="size-4" aria-hidden />
          </button>
        </motion.p>
      ) : cam.s === "problem" ? (
        <motion.div key="prob" role="alert" initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="sw-glass-chip flex flex-wrap items-center gap-2 rounded-[12px] px-3 py-2.5">
          <CameraOff className="size-4 shrink-0 text-amber-ink" aria-hidden />
          <p className="min-w-0 flex-1 basis-[180px] text-[13px] font-medium leading-5 text-ink">{cam.msg}</p>
          <button type="button" onClick={() => { close(); onUpload(); }} className="sw-btn sw-btn-primary min-h-10 rounded-full px-3.5 text-[13.5px] font-semibold">
            <ImageUp className="size-4" aria-hidden /> Upload
          </button>
          {cam.msg !== NOCAM ? (
            <button type="button" onClick={() => void start()} className="sw-btn sw-btn-quiet min-h-10 rounded-full px-3 text-[13.5px] font-semibold">Try again</button>
          ) : null}
          <button type="button" onClick={close} aria-label="Close" className="sw-btn grid size-8 shrink-0 place-items-center rounded-full text-ink-3 hover:bg-sunk hover:text-ink">
            <X className="size-4" aria-hidden />
          </button>
        </motion.div>
      ) : cam.s === "live" ? (
        <motion.div key="live" initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
          <CameraViewfinder stream={cam.stream} mirror={cam.mirror} hint={hint} onShot={shot} onCancel={close} onUpload={() => { close(); onUpload(); }} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return { cam: cam.s, start, close, panel, active: cam.s !== "off" };
}

/** The live preview + shutter. Captures the un-mirrored frame at full resolution. */
export function CameraViewfinder({ stream, mirror, hint, onShot, onCancel, onUpload }: { stream: MediaStream; mirror: boolean; hint: string; onShot: (b: Blob) => void; onCancel: () => void; onUpload: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    v.srcObject = stream;
    void v.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const ended = () => onCancel();
    track?.addEventListener("ended", ended);
    return () => {
      track?.removeEventListener("ended", ended);
      v.srcObject = null;
      stream.getTracks().forEach((t) => t.stop());
    };
  }, [stream, onCancel]);

  const take = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
    setFlash(true);
    c.toBlob((b) => b && onShot(b), "image/jpeg", 0.92);
  };

  return (
    <div className="relative overflow-hidden rounded-[14px] bg-ink shadow-e2 ring-1 ring-black/10">
      <video
        ref={video}
        playsInline
        muted
        autoPlay
        onLoadedData={() => setReady(true)}
        aria-label="Camera preview"
        className={cn("aspect-[4/3] w-full bg-ink object-cover", mirror && "-scale-x-100")}
      />
      {["left-3 top-3 border-l-[3px] border-t-[3px]", "right-3 top-3 border-r-[3px] border-t-[3px]", "bottom-[76px] left-3 border-b-[3px] border-l-[3px]", "bottom-[76px] right-3 border-b-[3px] border-r-[3px]"].map((k) => (
        <span key={k} aria-hidden className={cn("pointer-events-none absolute size-6 rounded-[3px] border-white/90", k)} />
      ))}
      <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-[12.5px] font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,.5)]">Get the {hint.replace(/^snap the /, "")} in frame</p>
      {flash ? <span aria-hidden className="absolute inset-0 bg-white/70" /> : null}
      <div className="absolute inset-x-0 bottom-0 grid grid-cols-[1fr_auto_1fr] items-center bg-gradient-to-t from-black/60 to-transparent px-2 pb-2.5 pt-8">
        <button type="button" onClick={onCancel} className="min-h-11 justify-self-start rounded-full px-3 text-[14px] font-semibold text-white">Cancel</button>
        <motion.button type="button" whileTap={{ scale: 0.9 }} disabled={!ready} onClick={take} aria-label="Take photo" className="grid size-14 place-items-center rounded-full bg-white/90 ring-4 ring-white/40 transition-opacity disabled:opacity-50">
          <span className="size-11 rounded-full bg-[linear-gradient(180deg,var(--sw-cta-a),var(--sw-cta-b))]" />
        </motion.button>
        <button type="button" onClick={onUpload} className="inline-flex min-h-11 items-center gap-1.5 justify-self-end rounded-full px-3 text-[14px] font-semibold text-white">
          <ImageUp className="size-4" aria-hidden /> Upload
        </button>
      </div>
    </div>
  );
}
