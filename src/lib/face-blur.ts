// On-device face blur for every photo the app takes or uploads ("Snap a place", "Snap a poster").
// Runs in the browser before the photo is shown or sent: unblurred faces never leave the device.
//  1. MediaPipe Face Detector (tasks-vision, BlazeFace full-range, WASM on CPU), loaded lazily on first use.
//     The model is served from /models (same origin); the WASM runtime comes from jsDelivr (pinned version).
//     It is run on the whole photo and on overlapping tiles, so small faces in a street shot are caught too.
//  2. The browser's FaceDetector (Shape Detection API) where it exists; its boxes are merged with MediaPipe's.
//  3. Neither available → { faces: null }: the photo is still sent, and the UI says "Face blur unavailable".
// The image is never uploaded, stored or logged by this module.

export type FaceBlur = { faces: number; via: "mediapipe" | "native" | "both" } | { faces: null; via: "none" };
type Box = { x: number; y: number; w: number; h: number; score: number };
type Detect = (src: HTMLCanvasElement) => Promise<Box[]> | Box[];

const MP_VERSION = "1.1.1"; // keep in step with package.json
const WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
const MODEL = "/models/blaze_face_full_range.tflite";
const LOAD_MS = 12_000;
const MIN_SCORE = 0.35; // low on purpose: a stray blurred patch is cheaper than a missed face

let mpP: Promise<Detect | null> | null = null;
let nativeD: Detect | null | undefined;

const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), ms))]);

function loadMediaPipe(): Promise<Detect | null> {
  if (mpP) return mpP;
  mpP = withTimeout(
    (async () => {
      const { FaceDetector, FilesetResolver } = await import("@mediapipe/tasks-vision");
      const files = await FilesetResolver.forVisionTasks(WASM_BASE);
      const fd = await FaceDetector.createFromOptions(files, {
        baseOptions: { modelAssetPath: MODEL, delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: MIN_SCORE,
        minSuppressionThreshold: 0.3,
      });
      const detect: Detect = (src) =>
        fd.detect(src).detections.flatMap((d) => {
          const b = d.boundingBox;
          return b ? [{ x: b.originX, y: b.originY, w: b.width, h: b.height, score: d.categories?.[0]?.score ?? 0.5 }] : [];
        });
      return detect;
    })().catch(() => null),
    LOAD_MS,
  ).then((d) => {
    if (!d) mpP = null; // let a later photo try again (e.g. came back online)
    return d;
  });
  return mpP;
}

function loadNative(): Detect | null {
  if (nativeD !== undefined) return nativeD;
  nativeD = null;
  const FD = (globalThis as unknown as { FaceDetector?: new (o: { fastMode?: boolean; maxDetectedFaces?: number }) => { detect: (s: CanvasImageSource) => Promise<{ boundingBox: DOMRectReadOnly }[]> } }).FaceDetector;
  if (typeof FD === "function") {
    try {
      const fd = new FD({ fastMode: false, maxDetectedFaces: 50 });
      nativeD = async (src) => (await fd.detect(src)).map((f) => ({ x: f.boundingBox.x, y: f.boundingBox.y, w: f.boundingBox.width, h: f.boundingBox.height, score: 0.9 }));
    } catch {
      nativeD = null;
    }
  }
  return nativeD;
}

/** Start loading the detector early (e.g. when the snap panel opens), so the first photo isn't held up. */
export function warmFaceBlur() {
  if (typeof window !== "undefined") void loadMediaPipe();
}

const iou = (a: Box, b: Box) => {
  const x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const i = x * y;
  return i / (a.w * a.h + b.w * b.h - i || 1);
};
/** Overlapping boxes (same face seen in the whole photo and in a tile) → one box covering both. */
function merge(boxes: Box[]): Box[] {
  const out: Box[] = [];
  for (const b of [...boxes].sort((p, q) => q.score - p.score)) {
    const hit = out.find((o) => iou(o, b) > 0.25 || (b.x >= o.x && b.y >= o.y && b.x + b.w <= o.x + o.w && b.y + b.h <= o.y + o.h));
    if (!hit) out.push({ ...b });
    else {
      const x2 = Math.max(hit.x + hit.w, b.x + b.w), y2 = Math.max(hit.y + hit.h, b.y + b.h);
      hit.x = Math.min(hit.x, b.x); hit.y = Math.min(hit.y, b.y); hit.w = x2 - hit.x; hit.h = y2 - hit.y;
    }
  }
  return out;
}

/** Whole photo + a 3×3 grid of overlapping tiles (each 45% of the side), so faces down to ~3% of the width are found. */
async function detectAll(canvas: HTMLCanvasElement, d: Detect): Promise<Box[]> {
  const boxes: Box[] = [...(await d(canvas))];
  const W = canvas.width, H = canvas.height;
  if (Math.max(W, H) < 500) return boxes;
  const tile = document.createElement("canvas");
  const N = 3;
  const tw = Math.round(W * 0.45), th = Math.round(H * 0.45);
  tile.width = tw; tile.height = th;
  const tc = tile.getContext("2d");
  if (!tc) return boxes;
  for (let r = 0; r < N; r++)
    for (let c = 0; c < N; c++) {
      const x0 = Math.round((W - tw) * (c / (N - 1))), y0 = Math.round((H - th) * (r / (N - 1)));
      tc.clearRect(0, 0, tw, th);
      tc.drawImage(canvas, x0, y0, tw, th, 0, 0, tw, th);
      for (const b of await d(tile)) boxes.push({ ...b, x: b.x + x0, y: b.y + y0 });
    }
  return boxes;
}

/** Irreversible blur: the face area is averaged down to a few pixels, scaled back up smoothly, then blurred again
 *  where the browser supports canvas filters. Boxes are padded to take in hair, ears and chin. */
function blurBox(ctx: CanvasRenderingContext2D, b: Box) {
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const px = b.w * 0.3, top = b.h * 0.45, bottom = b.h * 0.25;
  const x = Math.max(0, Math.floor(b.x - px)), y = Math.max(0, Math.floor(b.y - top));
  const w = Math.min(W - x, Math.ceil(b.w + 2 * px)), h = Math.min(H - y, Math.ceil(b.h + top + bottom));
  if (w < 2 || h < 2) return;
  const cells = 6;
  const small = document.createElement("canvas");
  small.width = cells; small.height = Math.max(2, Math.round((cells * h) / w));
  const sc = small.getContext("2d");
  if (!sc) return;
  sc.imageSmoothingEnabled = true;
  sc.imageSmoothingQuality = "high";
  sc.drawImage(ctx.canvas, x, y, w, h, 0, 0, small.width, small.height);
  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, Math.min(w, h) * 0.35);
  else ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  if ("filter" in ctx) ctx.filter = `blur(${Math.max(6, Math.round(w / 10))}px)`;
  ctx.drawImage(small, 0, 0, small.width, small.height, x - w * 0.05, y - h * 0.05, w * 1.1, h * 1.1);
  ctx.restore();
}

/** Finds faces on `canvas` and blurs each one in place. Returns how many, or faces: null if no detector works here. */
export async function blurFaces(canvas: HTMLCanvasElement): Promise<FaceBlur> {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { faces: null, via: "none" };
  const [mp, nat] = [await loadMediaPipe(), loadNative()];
  if (!mp && !nat) return { faces: null, via: "none" };
  let boxes: Box[] = [];
  let mpOk = false, natOk = false;
  if (mp) {
    try { boxes = boxes.concat(await detectAll(canvas, mp)); mpOk = true; } catch { /* fall back to native */ }
  }
  if (nat) {
    try { boxes = boxes.concat(await nat(canvas)); natOk = true; } catch { /* unsupported in this browser after all */ }
  }
  if (!mpOk && !natOk) return { faces: null, via: "none" };
  const faces = merge(boxes.filter((b) => b.w > 4 && b.h > 4));
  for (const f of faces) blurBox(ctx, f);
  return { faces: faces.length, via: mpOk && natOk ? "both" : mpOk ? "mediapipe" : "native" };
}

/** Chip copy: "Faces blurred · 2", "No faces seen", "Face blur unavailable on this device". */
export function faceChip(r: FaceBlur | null): { text: string; tone: "done" | "none" | "off" } | null {
  if (!r) return null;
  if (r.faces === null) return { text: "Face blur unavailable on this device", tone: "off" };
  if (r.faces === 0) return { text: "No faces seen", tone: "none" };
  return { text: `Faces blurred · ${r.faces}`, tone: "done" };
}
