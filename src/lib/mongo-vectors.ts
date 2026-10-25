// MongoDB Atlas Vector Search + Hybrid Search for vibe asks ("cosy quiet pub", "somewhere lively for the football",
// "good for working"). Each venue has `embed_text` (built only from its own OSM data: name, kind, cuisine, OSM
// description, seating, step-free tag, area) and `embedding` (Gemini gemini-embedding-001, 768 dims, cosine).
// The vector index uses Atlas Automated Embedding (Voyage AI voyage-4) by default; VIBE_EMBED=gemini switches to the
// stored Gemini vectors (re-run seed:vectors with --index=gemini). Query: $rankFusion of { $vectorSearch (ask vibe → embedding, pre-filtered by category + lat/lng box), $search
// (vibe words on embed_text, geoWithin circle) }. Never throws; null on any failure or after VIBE_BUDGET_MS, so the
// plan keeps its normal path. A "Vibe match" only ever means: this venue came back from the vector pipeline.
import type { Db, Document } from "mongodb";
import { createHash } from "node:crypto";
import type { OsmKind } from "@/lib/osm";
import type { LatLng } from "@/lib/plan-types";
import { venueArea } from "@/lib/venue-area";
import { getDb, withTimeout } from "@/lib/mongo";
import { VENUES_SEARCH_INDEX } from "@/lib/mongo-seed";

export const EMBED_MODEL = process.env.VIBE_EMBED_MODEL || "gemini-embedding-001";
export const EMBED_DIMS = 768;
export const AUTO_EMBED_MODEL = "voyage-4";
export const VECTOR_INDEX = "venues_vector";
export const VIBE_BUDGET_MS = 1500;
const FILTERS = ["category", "visitable", "lat", "lng"].map((path) => ({ type: "filter", path }));
/** One vector index slot (the cluster tier allows 3 search indexes) and Atlas can't mix autoEmbed with vector
 *  fields, so the index is either: "voyage" (default) — Atlas Automated Embedding, Atlas embeds embed_text and the
 *  query text with Voyage AI voyage-4 — or "gemini" — our own gemini-embedding-001 vectors in `embedding`. */
export type VibeMode = "voyage" | "gemini";
export const VIBE_MODE: VibeMode = process.env.VIBE_EMBED === "gemini" ? "gemini" : "voyage";
export const vectorIndexDefinition = (mode: VibeMode) => ({
  fields: [
    mode === "voyage"
      ? { type: "autoEmbed", modality: "text", path: "embed_text", model: AUTO_EMBED_MODEL }
      : { type: "vector", path: "embedding", numDimensions: EMBED_DIMS, similarity: "cosine" },
    ...FILTERS,
  ],
});
export const VECTOR_INDEX_DEFINITION = vectorIndexDefinition(VIBE_MODE);

// ---------- vibe words in the ask ----------
/** [pattern, label shown in the step]. English first, a few Italian equivalents (the app answers in Italian too). */
const VIBES: [RegExp, string][] = [
  [/\b(cos[yi]|cozy|cosier|snug|warm and|accogliente|intim[oa])\b/i, "cosy"],
  [/\b(quiet|calm|peaceful|tranquil|not (too )?(loud|busy)|tranquill[oa]|silenzios[oa])\b/i, "quiet"],
  [/\b(lively|buzzy|buzzing|busy vibe|fun|party|vivace|animat[oa])\b/i, "lively"],
  [/\b(watch(ing)? (the )?(football|footy|match|game|rugby|sport)|sports? bar|football|footy|partita|calcio)\b/i, "sports on TV"],
  [/\b(good for work(ing)?|work(ing)? from|laptop|wi-?fi|study|studying|remote work|lavorare|studiare)\b/i, "good for working"],
  [/\b(romantic|date night|first date|romantic[oa])\b/i, "romantic"],
  [/\b(traditional|old[- ]school|historic|classic|proper (old )?pub|tradizional[ei])\b/i, "traditional"],
  [/\b(trendy|hip|cool|stylish|alla moda)\b/i, "trendy"],
  [/\b(live music|gig|jazz|musica dal vivo)\b/i, "live music"],
  [/\b(craft beer|real ale|ales?|birra artigianale)\b/i, "craft beer"],
  [/\b(cocktails?)\b/i, "cocktails"],
  [/\b(rooftop|views?|terrace|beer garden|(?:with|has|got) (?:a )?garden|outdoors?|terrazza|giardino)\b/i, "outdoor"],
  [/\b(chill(ed)?|relaxed|laid[- ]back|rilassat[oa])\b/i, "relaxed"],
  [/\b(fancy|posh|upmarket|elegant|eleganti?)\b/i, "upmarket"],
  [/\b(cheap and cheerful|no[- ]frills|casual)\b/i, "casual"],
  [/\b(dog[- ]friendly|family[- ]friendly|kids?)\b/i, "family/dog-friendly"],
];
/** Vibe labels found in the ask ([] = not a vibe ask; the planner then never runs the hybrid query). */
export function vibeTerms(text: string): string[] {
  const t = String(text ?? "");
  return VIBES.filter(([re]) => re.test(t)).map(([, l]) => l);
}

/** What gets embedded for the ask: the vibe words and the venue kind only (no places, names or times). */
export function vibeQueryText(terms: string[], kind: OsmKind): string {
  const k = { pub: "pub or bar", cafe: "cafe", restaurant: "restaurant", free: "museum or gallery" }[kind];
  return `${terms.join(", ")} ${k}`;
}

// ---------- venue text ----------
const KIND_LABEL: Record<string, string> = { pub: "pub", bar: "bar", biergarten: "beer garden", cafe: "cafe", restaurant: "restaurant", museum: "museum", gallery: "gallery", arts_centre: "arts centre", marketplace: "market" };
/** One line per venue from its own OSM tags. Nothing is inferred or invented. */
export function embedText(v: { name: string | null; category: string; osm_tags: Record<string, string>; location: { coordinates: [number, number] } }): string {
  const t = v.osm_tags ?? {};
  const bits: string[] = [];
  bits.push(v.name ?? "Unnamed place");
  bits.push(KIND_LABEL[v.category] ?? v.category.replace(/_/g, " "));
  if (t.cuisine) bits.push(`cuisine: ${t.cuisine.replace(/[_;]/g, (c) => (c === ";" ? ", " : " "))}`);
  if (t.description && !/opening soon|toilets|floor|entrance/i.test(t.description)) bits.push(t.description.slice(0, 160));
  const seat: string[] = [];
  if (t.outdoor_seating === "yes") seat.push("outdoor seating");
  if (t.beer_garden === "yes" || t["garden:type"] === "beer_garden" || v.category === "biergarten") seat.push("beer garden");
  if (t.indoor_seating === "yes") seat.push("indoor seating");
  if (t.outdoor_seating === "no") seat.push("no outdoor seating");
  if (seat.length) bits.push(seat.join(", "));
  if (t.wheelchair === "yes") bits.push("step-free");
  if (t.fee === "no") bits.push("free entry");
  const area = venueArea(t, { lat: v.location.coordinates[1], lng: v.location.coordinates[0] });
  if (area) bits.push(area);
  return bits.join(". ");
}
export const embedHash = (text: string) => createHash("sha1").update(`${EMBED_MODEL}|${EMBED_DIMS}|${text}`).digest("hex").slice(0, 16);

// ---------- Gemini embeddings ----------
type Task = "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT";
export async function geminiEmbed(texts: string[], task: Task, timeoutMs = 20_000): Promise<number[][]> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY not set");
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({ requests: texts.map((text) => ({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text }] }, taskType: task, outputDimensionality: EMBED_DIMS })) }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`Gemini embeddings HTTP ${res.status}`);
    const j = (await res.json()) as { embeddings?: { values: number[] }[] };
    if (!j.embeddings || j.embeddings.length !== texts.length) throw new Error("Gemini embeddings: wrong count");
    return j.embeddings.map((e) => e.values);
  } finally {
    clearTimeout(timer);
  }
}
const qCache = new Map<string, { v: number[]; at: number }>();
async function queryVector(text: string, timeoutMs: number): Promise<number[]> {
  const hit = qCache.get(text);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.v;
  const [v] = await geminiEmbed([text], "RETRIEVAL_QUERY", timeoutMs);
  if (qCache.size > 200) qCache.clear();
  qCache.set(text, { v, at: Date.now() });
  return v;
}

// ---------- hybrid query ----------
/** Lat/lng box around `center` that contains the `radiusM` circle ($vectorSearch filters can't do geo). */
export function box(center: LatLng, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  return { lat: { $gte: center.lat - dLat, $lte: center.lat + dLat }, lng: { $gte: center.lng - dLng, $lte: center.lng + dLng } };
}
const CATS: Record<OsmKind, string[]> = { pub: ["pub", "bar", "biergarten"], cafe: ["cafe"], restaurant: ["restaurant"], free: ["museum", "gallery", "arts_centre", "marketplace"] };

/** `q` is the ask's vibe text (voyage: Atlas embeds it) or its Gemini vector (gemini). */
export function vibeVectorPipeline(q: string | number[], kind: OsmKind, center: LatLng, radiusM: number, limit = 12): Document[] {
  const b = box(center, radiusM);
  const by = typeof q === "string" ? { path: "embed_text", query: q } : { path: "embedding", queryVector: q };
  return [
    { $vectorSearch: { index: VECTOR_INDEX, ...by, numCandidates: 200, limit, filter: { $and: [{ category: { $in: CATS[kind] } }, { visitable: true }, { lat: b.lat }, { lng: b.lng }] } } },
  ];
}
export function vibeTextPipeline(terms: string[], kind: OsmKind, center: LatLng, radiusM: number, limit = 12): Document[] {
  return [
    {
      $search: {
        index: VENUES_SEARCH_INDEX,
        compound: {
          filter: [
            { geoWithin: { circle: { center: { type: "Point", coordinates: [center.lng, center.lat] }, radius: radiusM }, path: "location" } },
            { text: { query: CATS[kind], path: "category" } },
          ],
          should: [{ text: { query: terms.join(" "), path: ["embed_text", "name", "tags"], fuzzy: { maxEdits: 1, prefixLength: 2 } } }],
          minimumShouldMatch: 1,
          mustNot: [{ text: { query: "unvisitable", path: "tags" } }],
        },
      },
    },
    { $limit: limit },
  ];
}
/** $rankFusion (reciprocal rank fusion, Atlas 8.0+) of the vector and text pipelines. */
export function vibeHybridPipeline(vec: string | number[], terms: string[], kind: OsmKind, center: LatLng, radiusM: number, limit = 10): Document[] {
  return [
    { $rankFusion: { input: { pipelines: { vector: vibeVectorPipeline(vec, kind, center, radiusM), text: vibeTextPipeline(terms, kind, center, radiusM) } }, combination: { weights: { vector: 1, text: 1 } }, scoreDetails: true } },
    { $limit: limit },
    { $project: { osmType: 1, osmId: 1, name: 1, osm_tags: 1, location: 1, asOf: 1, embed_text: 1, fused: { $meta: "scoreDetails" } } },
  ];
}

/** Cosine similarity computed inside MongoDB over the stored Gemini vectors of venues in the circle (no index). */
export function exactCosinePipeline(qv: number[], kind: OsmKind, center: LatLng, radiusM: number, limit = 12): Document[] {
  const qn = Math.sqrt(qv.reduce((a, x) => a + x * x, 0)) || 1;
  const q = qv.map((x) => x / qn);
  return [
    { $match: { location: { $geoWithin: { $centerSphere: [[center.lng, center.lat], radiusM / 6_378_100] } }, category: { $in: CATS[kind] }, visitable: true, embedding: { $type: "array" } } },
    { $limit: 600 },
    {
      $project: {
        osmType: 1, osmId: 1, name: 1, osm_tags: 1, location: 1,
        dot: { $reduce: { input: { $range: [0, q.length] }, initialValue: 0, in: { $add: ["$$value", { $multiply: [{ $arrayElemAt: ["$embedding", "$$this"] }, { $arrayElemAt: [{ $literal: q }, "$$this"] }] }] } } },
        norm: { $sqrt: { $reduce: { input: "$embedding", initialValue: 0, in: { $add: ["$$value", { $multiply: ["$$this", "$$this"] }] } } } },
      },
    },
    { $set: { sim: { $cond: [{ $gt: ["$norm", 0] }, { $divide: ["$dot", "$norm"] }, 0] } } },
    { $sort: { sim: -1 } },
    { $limit: limit },
  ];
}
function rrf(lists: [Row[], string][]): Row[] {
  const score = new Map<string, { r: Row; s: number; d: { inputPipelineName: string; rank: number }[] }>();
  for (const [list, name] of lists)
    list.forEach((r, i) => {
      const k = `${r.osmType}/${r.osmId}`;
      const e = score.get(k) ?? { r, s: 0, d: [] };
      e.s += 1 / (60 + i + 1);
      e.d.push({ inputPipelineName: name, rank: i + 1 });
      score.set(k, e);
    });
  return [...score.values()].sort((a, b) => b.s - a.s).slice(0, 10).map((e) => ({ ...e.r, fused: { details: e.d } }));
}
const rCache = new Map<string, { r: VibeResult; at: number }>();
/** After a Voyage query rate limit (M0 without billing allows 3/min) skip Automated Embedding for a minute. */
let voyageCoolUntil = 0;

export type VibeHit = { key: string; name: string | null; fromVector: boolean; fromText: boolean; rank: number; osmType: string; osmId: number; tags: Record<string, string>; location: LatLng };
export type VibeResult = { terms: string[]; hits: VibeHit[]; method: string; ms: number; embedMs: number; mode: VibeMode; source: string };
export type VibeOutcome = VibeResult | { terms: string[]; error: string; ms: number };

type Row = { osmType: string; osmId: number; name: string | null; osm_tags: Record<string, string>; location: { coordinates: [number, number] }; fused?: { details?: { inputPipelineName: string; rank?: number }[] } };

/** Hybrid vibe search; never throws. Returns {error} (and the plan uses its normal path) on any failure or > budget. */
export async function vibeSearch(terms: string[], kind: OsmKind, center: LatLng, radiusM: number, opts: { db?: Db | null; budgetMs?: number; mode?: VibeMode; embed?: (t: string, ms: number) => Promise<number[]> } = {}): Promise<VibeOutcome> {
  const t0 = Date.now();
  const budget = opts.budgetMs ?? VIBE_BUDGET_MS;
  const fail = (error: string): VibeOutcome => ({ terms, error, ms: Date.now() - t0 });
  if (!terms.length) return fail("no vibe words");
  try {
    return await withTimeout(
      (async (): Promise<VibeOutcome> => {
        const mode = opts.mode ?? VIBE_MODE;
        const qText = vibeQueryText(terms, kind);
        const cKey = `${mode}|${qText}|${center.lat.toFixed(3)},${center.lng.toFixed(3)}|${Math.round(radiusM)}`;
        const cached = opts.db === undefined ? rCache.get(cKey) : undefined;
        if (cached && Date.now() - cached.at < 15 * 60_000) return { ...cached.r, ms: Date.now() - t0, embedMs: 0, method: `${cached.r.method} (cached)` };
        // Gemini query vector starts now in either mode: it is the vector side in "gemini" mode and the ready
        // fallback in "voyage" mode (so a Voyage rate limit costs no extra round trip).
        const gem = (opts.embed ?? queryVector)(qText, budget);
        gem.catch(() => null);
        const voyageOk = mode === "voyage" && Date.now() >= voyageCoolUntil;
        const [db, vec] = await Promise.all([
          opts.db === undefined ? getDb(budget) : Promise.resolve(opts.db),
          mode === "voyage" ? Promise.resolve<string | number[]>(qText) : gem,
        ]);
        const embedMs = Date.now() - t0;
        if (!db) return fail("MongoDB unavailable");
        const coll = db.collection("venues");
        let rows: Row[] = [];
        let method = mode === "voyage" ? `$rankFusion: $vectorSearch (Automated Embedding, ${AUTO_EMBED_MODEL}) + $search` : `$rankFusion: $vectorSearch (${EMBED_MODEL}) + $search`;
        let source = mode === "voyage" ? `MongoDB Atlas Vector Search · Automated Embedding (Voyage AI ${AUTO_EMBED_MODEL})` : `MongoDB Atlas Vector Search (Gemini ${EMBED_MODEL})`;
        try {
          if (mode === "voyage" && !voyageOk) throw new Error("voyage cooling down");
          rows = await coll.aggregate<Row>(vibeHybridPipeline(vec, terms, kind, center, radiusM), { maxTimeMS: budget }).toArray();
        } catch (e) {
          if (mode === "voyage" && /rate.?limit|429|cooling/i.test(String((e as Error)?.message))) voyageCoolUntil = Date.now() + 60_000;
          // Voyage query limit (M0 without billing: 3/min) or no $rankFusion: exact cosine over the stored Gemini
          // vectors inside MongoDB (venues in the geo circle only) + the same $search text pipeline, fused here (RRF).
          const [v, s] = await Promise.all([
            (async () => {
              const qv = typeof vec === "string" ? await gem : vec;
              return coll.aggregate<Row>(exactCosinePipeline(qv, kind, center, radiusM), { maxTimeMS: budget }).toArray();
            })().catch(() => null),
            coll.aggregate<Row>(vibeTextPipeline(terms, kind, center, radiusM), { maxTimeMS: budget }).toArray().catch(() => [] as Row[]),
          ]);
          rows = rrf([[v ?? [], "vector"], [s, "text"]]);
          method = v ? `exact cosine on ${EMBED_MODEL} vectors (aggregation) + $search, RRF` : "$search text only (vector side unavailable)";
          source = v ? `MongoDB Atlas (exact vector similarity, Gemini ${EMBED_MODEL})` : "MongoDB Atlas Search";
        }
        const hits: VibeHit[] = rows.map((r, i) => {
          const d = r.fused?.details ?? [];
          const inP = (n: string) => d.some((x) => x.inputPipelineName === n && x.rank != null && x.rank > 0);
          return { key: `${r.osmType}/${r.osmId}`, name: r.name, fromVector: inP("vector"), fromText: inP("text"), rank: i + 1, osmType: r.osmType, osmId: r.osmId, tags: r.osm_tags ?? {}, location: { lat: r.location.coordinates[1], lng: r.location.coordinates[0] } };
        });
        const out: VibeResult = { terms, hits, method, ms: Date.now() - t0, embedMs, mode, source };
        if (hits.some((h) => h.fromVector)) { if (rCache.size > 300) rCache.clear(); rCache.set(cKey, { r: out, at: Date.now() }); }
        return out;
      })(),
      budget,
      "vibe search",
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message.split("\n")[0].slice(0, 80) : "failed");
  }
}
