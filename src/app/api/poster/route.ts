// POST /api/poster: "Snap a poster". Body: multipart (field `image` = jpeg/png/webp file, optional `context` =
// JSON {query} or plain text) or JSON {image: "data:image/jpeg;base64,…", context?: {query}}.
// → 200 {extracted, place?: {name, lat, lng, address}, suggestedQuery} (suggestedQuery is an ask for /api/plan,
//   "Meet halfway for …" when context.query, the user's earlier halfway ask, is passed; null when nothing to route to).
// → 4xx/5xx {error} with a user-facing message. 503 when GEMINI_API_KEY is missing.
// Privacy: the image, its text and the context are never logged or stored (nothing goes to MongoDB).
import { resolveDestination } from "@/lib/destination";
import { buildSuggestedQuery, extractPoster, PosterError, type PosterExtract } from "@/lib/poster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

const MAX_BYTES = 5 * 1024 * 1024;
const BUDGET_MS = 15_000;
const MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PosterResponse = {
  extracted: PosterExtract;
  place?: { name: string; lat: number; lng: number; address: string | null };
  suggestedQuery: string | null;
  message?: string;
  /** Vision model that read the photo (VISION_MODEL, default gemini-4-argon; gemini-3-flash-preview if that's unavailable). */
  model: string;
};

const err = (status: number, error: string) => Response.json({ error }, { status, headers: { "cache-control": "no-store" } });

type Img = { mime: string; base64: string };

async function readBody(req: Request): Promise<{ img: Img; context: { query: string } | null }> {
  const len = Number(req.headers.get("content-length") ?? 0);
  // base64 inflates by 4/3; allow for that plus form overhead.
  if (len > MAX_BYTES * 1.4 + 64_000) throw new PosterError(413, "That photo is too big (over 5 MB). Try a smaller one.");
  const type = req.headers.get("content-type") ?? "";
  const ctxOf = (v: unknown): { query: string } | null => {
    if (typeof v === "string") {
      try {
        return ctxOf(JSON.parse(v));
      } catch {
        return v.trim() ? { query: v.trim().slice(0, 300) } : null;
      }
    }
    const q = v && typeof v === "object" ? (v as { query?: unknown }).query : null;
    return typeof q === "string" && q.trim() ? { query: q.trim().slice(0, 300) } : null;
  };
  if (type.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const f = form?.get("image");
    if (!f || typeof f === "string") throw new PosterError(400, "No photo found. Attach it as the `image` field.");
    if (!MIMES.has(f.type)) throw new PosterError(415, "Use a JPEG, PNG or WebP photo.");
    if (f.size > MAX_BYTES) throw new PosterError(413, "That photo is too big (over 5 MB). Try a smaller one.");
    if (!f.size) throw new PosterError(400, "That photo is empty.");
    return { img: { mime: f.type, base64: Buffer.from(await f.arrayBuffer()).toString("base64") }, context: ctxOf(form?.get("context")) };
  }
  const b = (await req.json().catch(() => null)) as { image?: unknown; context?: unknown } | null;
  const m = typeof b?.image === "string" ? b.image.match(/^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/) : null;
  if (!m) throw new PosterError(400, "Send the photo as {image: \"data:image/jpeg;base64,…\"} or as multipart `image`.");
  if (!MIMES.has(m[1])) throw new PosterError(415, "Use a JPEG, PNG or WebP photo.");
  const base64 = m[2].replace(/\s+/g, "");
  const bytes = Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);
  if (bytes > MAX_BYTES) throw new PosterError(413, "That photo is too big (over 5 MB). Try a smaller one.");
  if (bytes < 100) throw new PosterError(400, "That photo is empty.");
  return { img: { mime: m[1], base64 }, context: ctxOf(b?.context) };
}

const within = <T,>(p: Promise<T>, ms: number): Promise<T | null> =>
  Promise.race([p.catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), Math.max(0, ms)))]);

export async function POST(req: Request) {
  const t0 = Date.now();
  if (!process.env.GEMINI_API_KEY) return err(503, "Poster reading isn't switched on here yet. Type the event and venue instead.");
  try {
    const { img, context } = await readBody(req);
    let model = "";
    const extracted = await extractPoster(img, { timeoutMs: Math.min(11_500, BUDGET_MS - (Date.now() - t0) - 2_000), onModel: (m) => (model = m) });
    const venue = extracted.venueName ?? extracted.address?.split(",")[0]?.trim() ?? null;
    const found = venue ? await within(resolveDestination({ venue, address: extracted.address }), BUDGET_MS - (Date.now() - t0) - 300) : null;
    const suggestedQuery = buildSuggestedQuery(extracted, context);
    const out: PosterResponse = {
      extracted,
      ...(found ? { place: { name: found.name, lat: found.location.lat, lng: found.location.lng, address: found.address ?? extracted.address } } : {}),
      suggestedQuery,
      ...(!suggestedQuery
        ? { message: extracted.kind === "other" ? "That doesn't look like a poster or venue. Try again with the poster filling the frame." : "Couldn't spot a venue or address on it. Add where it is and plan from there." }
        : extracted.confidence < 0.5
          ? { message: "Not fully sure I read that right: check the details before planning." }
          : {}),
      model,
    };
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof PosterError) return err(e.status, e.message);
    // No details: they could include the image or its text.
    return err(500, "Something went wrong reading that photo. Try again.");
  }
}
