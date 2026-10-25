// POST /api/place-snap: "Snap a place". Body: multipart (field `image` = jpeg/png/webp file ≤ 5 MB, optional `you` =
// JSON {lat,lng}, optional `area` = typed neighbourhood) or JSON {image: "data:image/jpeg;base64,…", you?: {lat,lng}, area?}.
// `you` is rounded to ~100 m on arrival. Gemini reads the sign; the venue is matched in MongoDB Atlas.
// → 200 PlaceSnapResponse {extracted, place?, candidates?, message?, suggestedQuery} (see lib/place-snap.ts).
// → 4xx/5xx {error} with a user-facing message. 503 when GEMINI_API_KEY is missing.
// Privacy: the image, its text, your location and the area are never logged or stored.
import { extractSnap, roundYou, snapPlace, snapReaderReady, type PlaceSnapResponse } from "@/lib/place-snap";
import { PosterError } from "@/lib/poster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const MAX_BYTES = 5 * 1024 * 1024;
const BUDGET_MS = 15_000;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const TOO_BIG = "That photo is too big (over 5 MB). Try a smaller one.";

export type { PlaceSnapResponse };

const err = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });
type Img = { mime: string; base64: string };
const json = (v: unknown) => {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};
const areaOf = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : null);

async function readBody(req: Request): Promise<{ img: Img; you: unknown; area: string | null }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES * 1.4 + 64_000) throw new PosterError(413, TOO_BIG);
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const f = form?.get("image");
    if (!f || typeof f === "string") throw new PosterError(400, "No photo found. Attach it as the `image` field.");
    if (!MIMES.has(f.type)) throw new PosterError(415, "Use a JPEG, PNG or WebP photo.");
    if (f.size > MAX_BYTES) throw new PosterError(413, TOO_BIG);
    if (!f.size) throw new PosterError(400, "That photo is empty.");
    return { img: { mime: f.type, base64: Buffer.from(await f.arrayBuffer()).toString("base64") }, you: json(form?.get("you")), area: areaOf(form?.get("area")) };
  }
  const b = (await req.json().catch(() => null)) as { image?: unknown; you?: unknown; area?: unknown } | null;
  const m = typeof b?.image === "string" ? b.image.match(/^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/) : null;
  if (!m) throw new PosterError(400, "Send the photo as {image: \"data:image/jpeg;base64,…\"} or as multipart `image`.");
  if (!MIMES.has(m[1])) throw new PosterError(415, "Use a JPEG, PNG or WebP photo.");
  const base64 = m[2].replace(/\s+/g, "");
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_BYTES) throw new PosterError(413, TOO_BIG);
  if (bytes < 100) throw new PosterError(400, "That photo is empty.");
  return { img: { mime: m[1], base64 }, you: b?.you, area: areaOf(b?.area) };
}

export async function POST(req: Request) {
  const t0 = Date.now();
  if (!snapReaderReady()) return err(503, "Photo reading isn't switched on here yet. Type the place name instead.");
  try {
    const { img, you, area } = await readBody(req);
    let model = "";
    const extracted = await extractSnap(img, Math.min(11_000, BUDGET_MS - (Date.now() - t0) - 3_000), (m) => (model = m));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const matched = await Promise.race([
      snapPlace(extracted, { you: roundYou(you), area, budgetMs: BUDGET_MS - (Date.now() - t0) - 300 }),
      new Promise<Omit<PlaceSnapResponse, "model">>((r) => (timer = setTimeout(() => r({ extracted, suggestedQuery: null, message: "Matching that place took too long. Try again, or type the name." }), Math.max(0, BUDGET_MS - (Date.now() - t0) - 200)))),
    ]).finally(() => clearTimeout(timer));
    const out: PlaceSnapResponse = { ...matched, model };
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof PosterError) return err(e.status, e.message);
    // No details: they could include the image or its text.
    return err(500, "Something went wrong reading that photo. Try again.");
  }
}
