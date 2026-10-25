// "Why here", in words: a 1–2 sentence description per card, built ONLY from public facts about the venue
// (Wikipedia extract, Wikidata description, OSM tags, the venue's own site meta description), rewritten
// warmly by Gemini (low thinking) with a "Best for …" tag for the kind of plan. No facts beyond name + type
// → a plain template ("A local pub near Waterloo, open till 23:00."). Nothing about the people planning
// (where they are, the query text) is ever sent: only the venue's facts and the plan kind (date / coffee …).
import type { LatLng, PlanCard, PlanResultWithAgent } from "@/lib/plan-types";

/** Card field `blurb` (also sent late as NDJSON `{"type":"blurbs","blurbs":{[cardId]: Blurb}}`). */
export type Blurb = {
  text: string;
  /** "Best for a cosy date" (only when the facts support it). */
  bestFor?: string;
  /** Where the description comes from (the pill): Wikipedia / the venue's website / OpenStreetMap. */
  source: { name: string; url: string };
  /** True when the text uses what the user's photo shows (place-snap); source then names "Your photo". */
  fromPhoto?: boolean;
};
export type BlurbIntent = "date" | "coffee" | "friends" | "solo" | "event";
export type BlurbInput = { id: string; name: string; kind: string; tags: Record<string, string>; location: LatLng; area?: string | null; closesAt?: string | null; url?: string; photo?: { tags: string[]; line: string } };
type Src = { name: string; url: string };
export type BlurbFacts = { facts: string[]; source: Src; rich: boolean };
export type BlurbLlm = (prompt: string, signal: AbortSignal) => Promise<{ text?: unknown; bestFor?: unknown } | null>;
export type BlurbDeps = { llm?: BlurbLlm | null; fetch?: typeof fetch; budgetMs?: number; now?: () => number };

const UA = "SoWhere/0.1 (London meet-up planner; venue descriptions)";
// Blurbs have to land inside ~2.5 s: gemini-2.5-flash with thinking off answers in ~0.5 s, where
// gemini-3-flash-preview (low thinking) took 1.7–7 s in tests. BLURB_MODEL overrides; a gemini-3 model gets thinkingLevel "low".
const MODEL = process.env.BLURB_MODEL || "gemini-2.5-flash";
const THINKING = /gemini-3/.test(MODEL) ? { thinkingLevel: "low" } : { thinkingBudget: 0 };
const BUDGET_MS = 3200; // blurbs arrive as a late NDJSON line, so a little more room for the rewrite
const CACHE = new Map<string, { at: number; v: Blurb }>();
const TTL = 6 * 3600_000;

const clean = (s: unknown, max = 400) => (typeof s === "string" ? s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");
const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)));
const norm = (s: string) => s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/&/g, " and ").replace(/['’`.]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
const sameName = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b.replace(/\s*\([^)]*\)\s*$/, "")); // "George Inn (Southwark)" → "george inn"
  return !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 6 && (` ${x} `.includes(` ${y} `) || ` ${y} `.includes(` ${x} `))));
};
const firstSentences = (s: string, n = 2, max = 320) => {
  const parts = s.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [s];
  let out = "";
  for (const p of parts.slice(0, n)) if ((out + p).length <= max) out += p;
  return (out || s.slice(0, max)).trim();
};

async function getJson<T>(f: typeof fetch, url: string, ms: number): Promise<T | null> {
  if (ms < 150) return null;
  try {
    const r = await f(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(ms) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

const metres = (a: LatLng, b: LatLng) => {
  const k = Math.PI / 180;
  const dx = (b.lng - a.lng) * k * Math.cos(((a.lat + b.lat) / 2) * k);
  const dy = (b.lat - a.lat) * k;
  return Math.sqrt(dx * dx + dy * dy) * 6_371_000;
};
const FOOD_DRINK = /\b(?:pub|bar|inn|tavern|caf[eé]|coffee|restaurant|bistro|brasserie|eatery|bakery|brewery|tap ?room|wine|cocktail|gastropub|public house|hotel|food|dining|tea ?room|club|venue|diner|kitchen)\b/i;
const OTHER_THING = /\b(?:born|was an? (?:english|british|american|scottish|irish|welsh)\b|actor|singer|footballer|politician|band|album|song|single|film|novel|book|television|tv series|village|parish|ward|borough|district|river|station|railway|church|cathedral|school|college|university|hospital|ship|company|manufacturer|football club|street in|road in|square in)\b/i;
/** Wikipedia/Wikidata text is about this venue: similar name, and (for a pub/café/restaurant…) a food-or-drink place, not a person, street or station. */
export function wikiFits(x: Pick<BlurbInput, "name" | "kind">, title: string, about: string): boolean {
  if (title && !sameName(x.name, title) && !looseName(x.name, title)) return false;
  if (FOOD_DRINK.test(x.kind || "")) return FOOD_DRINK.test(about) && !(OTHER_THING.test(about) && !/\b(?:pub|public house|bar|inn|restaurant|caf[eé])\b/i.test(about.split(/[.;]/)[0]));
  return !/\b(?:born|actor|singer|footballer|politician|album|song)\b/i.test(about);
}
const looseName = (a: string, b: string) => {
  const stop = new Set(["the", "and", "london", "bar", "pub", "cafe", "restaurant", "inn", "s"]);
  const t = (v: string) => new Set(norm(v.replace(/\s*\([^)]*\)\s*$/, "")).split(" ").filter((w) => w.length > 2 && !stop.has(w)));
  const x = t(a);
  const y = t(b);
  const both = [...x].filter((w) => y.has(w)).length;
  return both > 0 && both >= Math.min(x.size, y.size);
};

type Wiki = { title: string; extract: string; description: string; url: string };
async function wikipedia(f: typeof fetch, x: BlurbInput, left: () => number): Promise<Wiki | null> {
  let title: string | null = null;
  let description = "";
  const wp = x.tags.wikipedia;
  if (wp && /^en:/i.test(wp)) title = wp.slice(3).trim();
  if (!title && x.tags.wikidata && /^Q\d+$/.test(x.tags.wikidata)) {
    const j = await getJson<{ entities?: Record<string, { descriptions?: { en?: { value: string } }; sitelinks?: { enwiki?: { title: string } } }> }>(f, `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${x.tags.wikidata}&props=descriptions|sitelinks&languages=en&sitefilter=enwiki&format=json&origin=*`, Math.min(1200, left()));
    const e = j?.entities?.[x.tags.wikidata];
    description = clean(e?.descriptions?.en?.value, 160);
    title = e?.sitelinks?.enwiki?.title ?? null;
  }
  if (!title) {
    // No tag: an English Wikipedia article within 150 m whose title is this venue's name.
    const j = await getJson<{ query?: { geosearch?: { title: string; dist: number }[] } }>(f, `https://en.wikipedia.org/w/api.php?action=query&list=geosearch&gscoord=${x.location.lat}|${x.location.lng}&gsradius=150&gslimit=15&format=json&origin=*`, Math.min(1000, left()));
    title = j?.query?.geosearch?.find((g) => g.dist <= 150 && sameName(x.name, g.title))?.title ?? null;
  }
  if (!title) return description && wikiFits(x, "", description) ? { title: "", extract: "", description, url: `https://www.wikidata.org/wiki/${x.tags.wikidata}` } : null;
  const s = await getJson<{ extract?: string; description?: string; content_urls?: { desktop?: { page?: string } }; type?: string; coordinates?: { lat: number; lon: number } }>(f, `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, Math.min(1200, left()));
  if (!s || s.type === "disambiguation") return description && wikiFits(x, title, description) ? { title, extract: "", description, url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` } : null;
  // Same entity only: the article's name matches, it's within 150 m (when it has coordinates) and it's the same kind of place.
  // Landmarks (big sites: a campus, a museum) get 300 m; venues 150 m.
  if (s.coordinates && metres(x.location, { lat: s.coordinates.lat, lng: s.coordinates.lon }) > (x.kind === "Landmark" ? 300 : 150)) return null;
  if (!wikiFits(x, title, `${clean(s.description, 160)} ${firstSentences(clean(s.extract, 600), 1, 300)} ${description}`)) return null;
  return { title, extract: firstSentences(clean(s.extract, 900), 3, 500), description: description || clean(s.description, 160), url: s.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}` };
}

async function metaDescription(f: typeof fetch, site: string | undefined, left: () => number): Promise<{ text: string; url: string } | null> {
  if (!site || !/^https?:\/\//i.test(site)) return null;
  const ms = Math.min(1200, left());
  if (ms < 300) return null;
  try {
    const r = await f(site, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow", signal: AbortSignal.timeout(ms) });
    if (!r.ok || !/html/i.test(r.headers.get("content-type") ?? "html")) return null;
    const html = (await r.text()).slice(0, 200_000);
    const m = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*content=["']([^"']{20,})["']/i.exec(html) ?? /<meta[^>]+content=["']([^"']{20,})["'][^>]*(?:name|property)=["'](?:description|og:description)["']/i.exec(html);
    const text = m ? clean(decode(m[1]), 300) : "";
    // Skip boilerplate ("Just another WordPress site", cookie banners, generic booking-engine text).
    if (!text || /wordpress|cookie|javascript|squarespace|wix\.com|^home\b/i.test(text)) return null;
    return { text, url: site };
  } catch {
    return null;
  }
}

/** Facts straight from OSM tags (no inference beyond what each tag says). */
export function osmFacts(tags: Record<string, string>): string[] {
  const out: string[] = [];
  const t = (k: string) => tags[k];
  if (t("description")) out.push(`OSM description: ${clean(t("description"), 200)}`);
  if (t("cuisine")) out.push(`Cuisine: ${t("cuisine").split(";").map((c) => c.replace(/_/g, " ").trim()).join(", ")}`);
  if (t("outdoor_seating") === "yes") out.push("Has outdoor seating");
  if (t("beer_garden") === "yes") out.push("Has a beer garden");
  if (t("real_ale") === "yes") out.push("Serves real ale");
  if (t("microbrewery") === "yes") out.push("Brews its own beer");
  if (t("food") === "yes") out.push("Serves food");
  if (t("heritage") || t("listed_status") || t("HE_ref")) out.push(`Heritage-listed building${t("listed_status") ? ` (${t("listed_status")})` : ""}`);
  if (t("historic")) out.push(`Historic site (${t("historic").replace(/_/g, " ")})`);
  if (t("start_date") && /^\d{4}/.test(t("start_date"))) out.push(`Open since ${t("start_date").slice(0, 4)}`);
  if (t("wheelchair") === "yes") out.push("Step-free / wheelchair accessible");
  if (t("operator")) out.push(`Run by ${clean(t("operator"), 60)}`);
  return out;
}

const osmLink = (id: string, tags: Record<string, string>, site?: string): Src => {
  const m = /^osm-(node|way|relation)-(\d+)$/.exec(id);
  return m ? { name: "OpenStreetMap", url: `https://www.openstreetmap.org/${m[1]}/${m[2]}` } : site ? { name: hostOf(site), url: site } : { name: "OpenStreetMap", url: "https://www.openstreetmap.org/" };
};
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "Website";
  }
};

/** Everything we know about the venue, each line a fact, with the best source for the pill. */
export async function gatherFacts(x: BlurbInput, deps: BlurbDeps = {}): Promise<BlurbFacts> {
  const f = deps.fetch ?? fetch;
  const clock = deps.now ?? Date.now;
  const end = clock() + Math.round((deps.budgetMs ?? BUDGET_MS) * 0.5); // leave ≥1.5 s for the rewrite
  const left = () => end - clock();
  const site = x.tags.website ?? x.tags["contact:website"] ?? (x.url && !/openstreetmap\.org/.test(x.url) ? x.url : undefined);
  const [wiki, meta] = await Promise.all([wikipedia(f, x, left), metaDescription(f, site, left)]);
  const facts: string[] = [];
  if (wiki?.extract) facts.push(`Wikipedia: ${wiki.extract}`);
  if (wiki?.description) facts.push(`Wikidata: ${wiki.description}`);
  if (meta) facts.push(`Its website says: ${meta.text}`);
  facts.push(...osmFacts(x.tags));
  if (x.photo?.line) facts.push(`The user's photo shows: ${x.photo.line}`);
  if (x.photo?.tags.length) facts.push(`Visible in the user's photo: ${x.photo.tags.join(", ")}`);
  const rich = facts.length > 0;
  const source: Src = wiki?.extract || wiki?.description ? { name: wiki.extract ? "Wikipedia" : "Wikidata", url: wiki.url } : meta ? { name: hostOf(meta.url), url: meta.url } : osmLink(x.id, x.tags, site);
  return { facts, source, rich };
}

const INTENT_PHRASE: Record<BlurbIntent, string> = { date: "a date", coffee: "a coffee catch-up", friends: "meeting a friend", solo: "a night out", event: "going to an event" };

/** Plain template when there's nothing beyond name and type: "A local pub near Waterloo, open till 23:00." */
export function templateBlurb(x: BlurbInput, source: Src): Blurb {
  const kind = (x.kind || "place").toLowerCase();
  const near = x.area ? (/^near /.test(x.area) ? ` ${x.area}` : ` in ${x.area.replace(/ · /, ", ")}`) : "";
  const until = x.closesAt ? `, open till ${x.closesAt}` : "";
  return { text: `A local ${kind}${near}${until}.`, source };
}

export function blurbPrompt(x: BlurbInput, facts: string[], intent: BlurbIntent): string {
  return [
    `Write a short description of a London venue for someone planning ${INTENT_PHRASE[intent]}.`,
    `Venue: ${x.name} (${x.kind || "place"}).`,
    "Facts (the ONLY information you may use):",
    ...facts.map((f) => `- ${f}`),
    "",
    "Rules: 1–2 warm, plain sentences, at most 200 characters, no emoji, no quotes, no brackets. Use ONLY the facts above:",
    "Lead with its character and what it's good for, e.g. \"Classic Victorian corner pub on a pretty terraced street, with Thai food in the back.\"",
    "Never give the address, street number or postcode, never write \"is a pub located at\", and don't open with the venue's name.",
    "Write in the third person (turn the website's \"we\"/\"our\" into a description); skip walking times, awards and marketing claims.",
    "do not add atmosphere, decor, food, drinks, prices, history, dates, numbers or anything else that isn't stated.",
    "If a fact is uncertain, leave it out. Don't mention Wikipedia, OSM or the website.",
    ...(x.photo ? ["Facts from the user's photo describe only what it shows: you may use them, but never as ratings, reviews or claims about quality."] : []),
    "Don't say who should go (no 'on your own', 'for solo').",
    `bestFor: a short tag starting "Best for" naming the kind of outing (max 6 words, e.g. "Best for a cosy date", "Best for a sunny pint", "Best for catching up"), suited to ${INTENT_PHRASE[intent]} and supported by the facts, else null.`,
  ].join("\n");
}

/** Gemini JSON {text, bestFor}; null on any failure. */
export const geminiBlurbLlm: BlurbLlm = async (prompt, signal) => {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: { type: "OBJECT", properties: { text: { type: "STRING" }, bestFor: { type: "STRING", nullable: true } }, required: ["text"] },
          thinkingConfig: THINKING,
          temperature: 0.4,
        },
      }),
      signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return JSON.parse(j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "null");
  } catch {
    return null;
  }
};

const POSTCODE = /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/;
const ADDRESSY = /\blocated (?:at|on)\b|\b\d+[a-z]?,?\s+(?:[A-Z][\w']+\s+){1,3}(?:Street|St|Road|Rd|Lane|Square|Place|Row|Walk|Terrace|Hill|Way|Gardens|Yard|Court|Parade|Mews|Market|Broadway|Bridge Road)\b/;
/** Address, postcode, "located at", first-person website copy: never in a blurb. */
export const addressy = (t: string) => POSTCODE.test(t) || ADDRESSY.test(t);
const FIRST_PERSON = /\b(?:we|we're|we've|our|us)\b/i;
/** Reject a rewrite that brings in numbers / years that aren't in the facts, brackets, an address, "we/our", or runs long.
 *  Street numbers and postcodes in the facts don't count against it as long as the text leaves them out. */
export function acceptRewrite(text: string, facts: string[]): boolean {
  if (!text || text.length < 12 || text.length > 230 || /[[\]{}<>]/.test(text) || addressy(text) || FIRST_PERSON.test(text)) return false;
  const pool = facts.join(" ");
  return (text.match(/\d+/g) ?? []).every((n) => pool.includes(n));
}

const tidyBestFor = (v: unknown): string | undefined => {
  const s = clean(v, 60).replace(/[.!]+$/, "");
  if (!s || /null|none/i.test(s)) return undefined;
  const b = /^best for/i.test(s) ? s.replace(/^best for/i, "Best for") : `Best for ${s.charAt(0).toLowerCase()}${s.slice(1)}`;
  return b.split(" ").length <= 7 ? b : undefined;
};

/** No rewrite: a sentence from Wikipedia / Wikidata / OSM that isn't just name + address (website copy only when it isn't "we/our"),
 *  else the modest template plus a couple of OSM facts. */
export function fallbackBlurb(x: BlurbInput, g: BlurbFacts): Blurb {
  const name = norm(x.name);
  for (const f of g.facts) {
    const m = /^(Wikipedia|Wikidata|OSM description|Its website says): (.*)$/.exec(f);
    if (!m) continue;
    const sentences = m[2].match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [m[2]];
    const keep = sentences.map((v) => v.trim()).filter((v) => v.length > 12 && !addressy(v) && !FIRST_PERSON.test(v) && !/^\S.{0,60}\b(?:is|was) an? (?:pub|bar|caf[eé]|restaurant|public house)\.?$/i.test(v) && norm(v) !== name);
    const text = keep.reduce((a, v) => ((a ? `${a} ${v}` : v).length <= 200 ? (a ? `${a} ${v}` : v) : a), "");
    if (text) return { text: (text.charAt(0).toUpperCase() + text.slice(1)).replace(/([^.!?])$/, "$1."), source: g.source };
  }
  const t = templateBlurb(x, g.source);
  const extra = g.facts.filter((f) => !/^(Wikipedia|Wikidata|OSM description|Its website says|Run by|Open since)/.test(f)).slice(0, 2).map((f) => f.replace(/^Cuisine: (.*)$/, "$1 food").replace(/^(?:Has|Serves) /, "").replace(/^Step-free \/ wheelchair accessible$/, "step-free")).map((f) => f.charAt(0).toLowerCase() + f.slice(1));
  return extra.length ? { ...t, text: `${t.text.replace(/\.$/, "")}, with ${extra.join(" and ")}.`.slice(0, 220) } : t;
}

const PHOTO_SRC: Src = { name: "Your photo", url: "" };
const RATED = /\b(?:rated|ratings?|reviews?|stars?|michelin|award|top[- ]rated|must[- ]visit)\b|★|⭐|\d\s*\/\s*(?:5|10)\b/i;
/** Did the text draw on the photo? (a visible tag, or two content words from the photo's line). */
export function usesPhoto(text: string, photo: NonNullable<BlurbInput["photo"]>): boolean {
  const t = text.toLowerCase();
  if (photo.tags.some((g) => t.includes(g))) return true;
  const words = photo.line.toLowerCase().match(/[a-z]{5,}/g) ?? [];
  return words.filter((w) => t.includes(w)).length >= 2;
}
/** Label a blurb that uses the photo: source "Your photo" alone, or "<public source> + your photo". */
function photoLabel(b: Blurb, publicFacts: boolean): Blurb {
  return { ...b, fromPhoto: true, source: publicFacts ? { name: `${b.source.name} + your photo`, url: b.source.url } : PHOTO_SRC };
}

/** One card's blurb within the deadline: facts → Gemini rewrite (checked) → else first facts sentence → else template. */
export async function buildBlurb(x: BlurbInput, intent: BlurbIntent, deps: BlurbDeps = {}): Promise<Blurb> {
  const key = `${x.id}|${intent}`;
  const hit = x.photo ? undefined : CACHE.get(key); // photo blurbs are per request, never cached
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const clock = deps.now ?? Date.now;
  const t0 = clock();
  const budget = deps.budgetMs ?? BUDGET_MS;
  const g = await gatherFacts(x, deps);
  const pub = g.facts.filter((f) => !/^(?:The user's photo shows|Visible in the user's photo):/.test(f));
  if (x.photo) g.source = pub.length ? g.source : PHOTO_SRC;
  let out: Blurb;
  if (!g.rich) out = templateBlurb(x, g.source);
  else {
    const llm = deps.llm === undefined ? geminiBlurbLlm : deps.llm;
    const ms = budget - (clock() - t0) - 50;
    const j = llm && ms > 300 ? await llm(blurbPrompt(x, g.facts, intent), AbortSignal.timeout(ms)).catch(() => null) : null;
    const text = clean(j?.text, 360);
    if (j && acceptRewrite(text, g.facts) && !(x.photo && RATED.test(text))) {
      out = { text, ...(tidyBestFor(j.bestFor) ? { bestFor: tidyBestFor(j.bestFor) } : {}), source: g.source };
      if (x.photo && usesPhoto(text, x.photo)) out = photoLabel(out, pub.length > 0);
    } else {
      // No rewrite: quote the first real fact plainly (Wikipedia / website wording), never invent.
      out = fallbackBlurb(x, { ...g, facts: pub });
      if (x.photo?.line) {
        const line = x.photo.line.charAt(0).toUpperCase() + x.photo.line.slice(1);
        const isTemplate = !pub.length || /^A local /.test(out.text);
        // Template or nothing public: the photo's own line leads; else add it after the public sentence if it fits.
        if (isTemplate) out = photoLabel({ ...out, text: `${line}.` }, false);
        else if (out.text.length + line.length + 2 <= 200) out = photoLabel({ ...out, text: `${out.text} ${line}.` }, true);
      }
    }
  }
  if (x.photo) return out;
  if (CACHE.size > 500) CACHE.clear();
  CACHE.set(key, { at: Date.now(), v: out });
  return out;
}

/** Plan kind for the "Best for" tag, from the plan's own fields (no stored query text). */
export function blurbIntent(r: Pick<PlanResultWithAgent, "intent" | "filters" | "query">): BlurbIntent {
  if (/\b(?:date|first date|romantic|girlfriend|boyfriend|partner|wife|husband)\b/i.test(r.query ?? "")) return "date";
  if (r.filters?.category === "event") return "event";
  if (r.filters?.category === "cafe") return "coffee";
  return r.intent === "meet_halfway" ? "friends" : "solo";
}

/** Blurbs for the top 3 cards in parallel, all inside one budget; a card that runs out gets none. */
export async function planBlurbs(r: PlanResultWithAgent, tagsOf: (c: PlanCard) => Record<string, string>, deps: BlurbDeps = {}): Promise<Record<string, Blurb>> {
  const intent = blurbIntent(r);
  const budget = deps.budgetMs ?? BUDGET_MS;
  const cards = r.cards.slice(0, 3) as (PlanCard & { area?: string; closesAt?: string | null })[];
  const outs = await Promise.all(
    cards.map((c) => {
      const kind = (c.subtitle ?? "").split(" · ")[0] || (c.kind === "event" ? "event" : "place");
      const input: BlurbInput = { id: c.id, name: c.name, kind: /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) /.test(kind) ? "event venue" : kind, tags: tagsOf(c), location: c.location, area: c.area ?? null, closesAt: c.closesAt ?? null, url: c.url };
      return Promise.race([buildBlurb(input, intent, { ...deps, budgetMs: budget }).catch(() => null), new Promise<null>((res) => setTimeout(() => res(null), budget + 100))]).then((b) => [c.id, b] as const);
    }),
  );
  return Object.fromEntries(outs.filter((x): x is readonly [string, Blurb] => !!x[1]));
}
