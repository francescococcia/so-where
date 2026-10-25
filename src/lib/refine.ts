// Follow-up refinements ("make it 8pm somewhere quieter", "cheaper", "with a terrace", "closer to me").
// The accumulated ask travels as `<base query>; refine: <r1>; refine: <r2>`: the base is parsed once, then each
// refinement is replayed in order, so a later time replaces an earlier one and soft wishes stack.
// Hard overrides: time / date / place type / budget / walk-in / free / within N min / near me.
// Soft wishes become ranking preferences (cheaper, quieter, terrace, indoor, closer to me / them, something different).
import { parsePlanAsk, type PlanAsk } from "@/lib/ask-local";
import { seatingOf, weatherRank } from "@/lib/venue-weather";
import { isLeaveQuestion } from "@/lib/leave-time";
import { parseDestination } from "@/lib/destination";

export type Pref = "cheaper" | "quieter" | "terrace" | "indoor" | "closer_you" | "closer_them" | "different";
export type Refinement = {
  prefs: Pref[];
  shiftMin: number; // relative time shift ("an hour later"), applied after the base time is worked out
  changes: string[]; // what the refinements changed, for the reply ("time", "date", "category", …)
  texts: string[];
  /** Only what the latest refinement (this chat turn) changed / asked for; the reply describes this. */
  latest: { changes: string[]; prefs: Pref[]; asks: Ask[] };
};
/** Questions about the current pick, answered in the reply ("is it open now?", "when does it close?"). */
export type Ask = "open";
export type RefinedAsk = PlanAsk & { prefs?: Pref[]; cuisine?: string; focus?: { id?: string; name?: string; lat: number; lng: number } };

/** Cuisine / diet wishes → OSM `cuisine=*` / `diet:*=yes` tokens, plus a name pattern for untagged places. */
const CUISINES: { key: string; label: string; re: RegExp; name: RegExp; diet?: boolean }[] = [
  { key: "italian", label: "Italian", re: /\bital(?:ian|iano|y)\b/i, name: /ital|caff[eè]|pizz|trattoria|osteria|ristorante|pasta|gelat|espresso bar|bar italia/i },
  { key: "pizza", label: "pizza", re: /\bpizz(?:a|eria)s?\b/i, name: /pizz/i },
  { key: "vegan", label: "vegan", re: /\bvegan\b/i, name: /vegan|plant/i, diet: true },
  { key: "vegetarian", label: "vegetarian", re: /\bvegetarian|veggie\b/i, name: /vegetarian|veggie/i, diet: true },
  { key: "indian", label: "Indian", re: /\bindian|curry\b/i, name: /indian|curry|tandoor|masala/i },
  { key: "chinese", label: "Chinese", re: /\bchinese|dim sum\b/i, name: /chinese|dim sum|wok/i },
  { key: "japanese", label: "Japanese", re: /\bjapanese|sushi|ramen\b/i, name: /sushi|ramen|japan|izakaya/i },
  { key: "thai", label: "Thai", re: /\bthai\b/i, name: /thai/i },
  { key: "mexican", label: "Mexican", re: /\bmexican|tacos?\b/i, name: /mexic|taco|cantina/i },
  { key: "french", label: "French", re: /\bfrench\b/i, name: /bistro|brasserie|french/i },
  { key: "turkish", label: "Turkish", re: /\bturkish|kebab\b/i, name: /turk|kebab|meze/i },
  { key: "greek", label: "Greek", re: /\bgreek\b/i, name: /greek|souvlaki|taverna/i },
  { key: "korean", label: "Korean", re: /\bkorean\b/i, name: /korea/i },
  { key: "vietnamese", label: "Vietnamese", re: /\bvietnamese|pho\b/i, name: /viet|pho\b/i },
  { key: "spanish", label: "Spanish", re: /\bspanish|tapas\b/i, name: /tapas|spanish/i },
  { key: "lebanese", label: "Lebanese", re: /\blebanese\b/i, name: /leban|beirut/i },
];
export function cuisineOf(text: string): string | undefined {
  return CUISINES.find((c) => c.re.test(text))?.key;
}
export const cuisineLabel = (key: string) => CUISINES.find((c) => c.key === key)?.label ?? key;
/** Does this OSM place match the cuisine wish? cuisine=* tag, diet:*=yes|only, or (untagged) its name. */
export function cuisineMatch(tags: Record<string, string>, key: string | undefined): "tag" | "name" | null {
  if (!key) return null;
  const c = CUISINES.find((x) => x.key === key);
  if (!c) return null;
  if ((tags.cuisine ?? "").toLowerCase().split(/[;,]\s*/).includes(key) || (c.diet && /^(yes|only)$/.test(tags[`diet:${key}`] ?? ""))) return "tag";
  // Name-only guesses skip chains (a brand tag without the cuisine tag, e.g. Caffè Nero).
  return !tags.brand && !/\bcaff[eè] nero\b|\bcosta\b|\bstarbucks\b|\bpret\b/i.test(tags.name ?? "") && c.name.test(tags.name ?? "") ? "name" : null;
}
const OPEN_Q = /\b(?:is|are)\s+(?:it|they|that|this|these|those|the \w+|[A-Z][\w' ]+?)\s+(?:still\s+)?open\b|\bopen (?:now|tonight|late|then)\b|\bstill open\b|\bwhen (?:does|do|will) .{0,30}\bclose\b|\bclosing time\b|\bopening (?:hours|times)\b|\bwhat time .{0,30}\bclose\b|\b(?:is|are) open\b|\bopen\?/i;

const REFINE_SEP = /;\s*refine:\s*/i;
const SLOT_TOKEN = /;\s*(?:them|you):\s*[^;]+/gi;

/** Accumulated query for the next turn. */
export function joinRefine(prevQuery: string, refinement: string): string {
  const r = refinement.replace(/[;]/g, ",").replace(/\s+/g, " ").trim().replace(/[.!?]+$/, "");
  return r ? `${prevQuery.trim().replace(/[.\s]+$/, "")}; refine: ${r}` : prevQuery;
}

// When the plan switches to "meet at <place>", the old ask's day/time and who-is-where still hold unless the new one says otherwise.
const DAY_RE = /\b(?:today|tonight|tomorrow(?: (?:morning|afternoon|evening|night))?|this (?:morning|afternoon|evening)|(?:on |next )?(?:mon|tues|wednes|thurs|fri|satur|sun)day(?: (?:morning|afternoon|evening|night))?)\b/i;
const TIME_RE = /\b(?:at|from|around|for) \d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b/i;
const WHO_RE = /\b(?:i'?m|i am|(?:she|he|they)(?:'s|'re| is| are)|[A-Z][a-z]+(?:'s| is))\s+(?:at|in|near|by|around|from)\s+[^,;.]+/gi;
function carryOver(oldBase: string, go: string): string[] {
  const out: string[] = [];
  const day = DAY_RE.exec(oldBase)?.[0];
  if (day && !DAY_RE.test(go)) out.push(day);
  const time = TIME_RE.exec(oldBase)?.[0];
  if (time && !TIME_RE.test(go)) out.push(/^\d/.test(time) ? `at ${time}` : time);
  const who = oldBase.match(WHO_RE) ?? [];
  if (who.length && !/\b(?:i'?m|i am|she|he|they)\b/i.test(go)) out.push(`, ${who.join(", ")}`);
  return out.length ? [out.join(" ").replace(/\s+,/g, ",")] : [];
}

/** Split an accumulated query into base + refinements. Also reads the UI's older "X. (refine: a; b)" form. */
export function splitRefine(text: string): { base: string; refinements: string[] } {
  let t = text;
  const legacy = /\.?\s*\(refine:\s*([^)]*)\)\s*\.?\s*$/i.exec(t);
  const extra: string[] = [];
  if (legacy) {
    t = t.slice(0, legacy.index);
    extra.push(...legacy[1].split(";").map((s) => s.trim()).filter(Boolean));
  }
  const [base, ...rest] = t.split(REFINE_SEP);
  // Clarify answers ("; them: X") appended after a refinement belong to the base.
  const slots: string[] = [];
  const refinements = rest.map((r) => r.replace(SLOT_TOKEN, (m) => (slots.push(m.trim()), "")).trim()).filter(Boolean);
  // "When do I leave?" questions change nothing in the plan (answered in runPlan), so they're not refinements.
  const all = [...refinements, ...extra].filter((r) => !isLeaveQuestion(r));
  // "Meet at <place>" / "get me to <place>" as a follow-up: that place is the new base; earlier refinements were for the old plan.
  const go = all.map((r) => !!parseDestination(r)).lastIndexOf(true);
  if (go >= 0) return { base: [all[go], ...carryOver(base, all[go]), ...slots].join(" "), refinements: all.slice(go + 1) };
  return { base: [base.trim(), ...slots].join(" "), refinements: all };
}

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, half: 0.5 };
function shiftOf(r: string): number {
  const m = /\b(an?|one|two|three|four|half an?|\d(?:\.5)?)\s*(?:hours?|hrs?|h)\s+(later|earlier|before|after)\b/i.exec(r);
  if (m) {
    const k = m[1].toLowerCase();
    const n = k.startsWith("half") ? 0.5 : NUM[k] ?? Number(k);
    return Math.round(n * 60) * (/later|after/i.test(m[2]) ? 1 : -1);
  }
  const mm = /\b(\d{1,3})\s*(?:min|mins|minutes)\s+(later|earlier)\b/i.exec(r);
  if (mm) return Number(mm[1]) * (/later/i.test(mm[2]) ? 1 : -1);
  if (/^\s*(?:a bit |slightly )?later\b/i.test(r) || /\b(?:bit|little) later\b/i.test(r)) return 60;
  if (/^\s*(?:a bit |slightly )?earlier\b/i.test(r) || /\b(?:bit|little) earlier\b/i.test(r)) return -60;
  return 0;
}

/** "make it 8" / "change to 9" with no am/pm: evening unless it's a café plan in the morning range. */
function bareTime(r: string, ask: PlanAsk): string | null {
  const m = /\b(?:make it|change (?:it )?to|move (?:it )?to|how about|instead at|at)\s+(\d{1,2})(?:[:.](\d{2}))?(?!\s*(?:min|mins|minutes|people|quid|pounds|%|th|st|nd|rd))\b/i.exec(r);
  if (!m) return null;
  let h = Number(m[1]);
  if (h < 1 || h > 23) return null;
  if (h < 12 && !(ask.category === "cafe" && h >= 7)) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2] ?? "00"}`;
}

const CHEAPER = /\bcheap(?:er)?\b|\bless (?:expensive|pricey)\b|\bbudget\b|\baffordable\b|\binexpensive\b/i;
const QUIETER = /\bquiet(?:er)?\b|\bcalm(?:er)?\b|\bless (?:busy|loud|noisy)\b|\bcan talk\b|\bchill(?:ed)?\b|\bpeaceful\b/i;
const TERRACE = /\bterrace\b|\boutside\b|\boutdoors?\b|\bbeer garden\b|\bgarden\b|\bsit out\b|\bal fresco\b|\brooftop\b/i;
const INDOOR = /\bindoors?\b|\binside\b|\bcovered\b|\bcos[yi]\b|\bout of the rain\b/i;
const CLOSER_YOU = /\b(?:closer|nearer)\s+(?:to\s+)?(?:me|my place|my end|home)\b|\bless travel for me\b|\bshorter (?:trip|journey) for me\b/i;
const CLOSER_THEM = /\b(?:closer|nearer)\s+(?:to\s+)?(?:her|him|them|my (?:friend|mate|date|partner)|[A-Z][a-z]+)\b/;
const DIFFERENT = /\b(?:something|somewhere|a) (?:different|else)\b|\bdifferent (?:area|place|spot|one|options?)\b|\banother (?:area|place|spot|one|option)\b|\bother options?\b/i;
const NEAR_ME = /\b(?:just )?near me(?: instead)?\b|\bforget (?:the )?(?:halfway|meeting)\b|\bon my own\b|\bjust me\b/i;
const YOU_MOVED = /\b(?:i'?m|i am|im)\s+(?:now\s+)?(?:at|in|near|around|by)\s+\w/i;

/** Replay refinements over the base parse. Mutates and returns `ask` (with `prefs`). */
export function applyRefinements(ask: PlanAsk, refinements: string[], today: string): { ask: RefinedAsk; refinement: Refinement } {
  const prefs = new Set<Pref>();
  const changes = new Set<string>();
  let shiftMin = 0;
  const out = ask as RefinedAsk;
  let latestChanges = new Set<string>();
  let latestPrefs = new Set<Pref>();
  let latestAsks: Ask[] = [];
  for (const raw of refinements) {
    const r = raw.replace(/[’‘]/g, "'").trim();
    const before = { changes: new Set(changes), prefs: new Set(prefs) };
    changes.clear(); // per-turn tracking; merged back below
    const p = parsePlanAsk(r, today);
    const t = p.time ?? bareTime(r, out);
    const shift = shiftOf(r);
    if (t && !shift) {
      out.time = t;
      out.timeKind = p.time ? (p.timeKind ?? "clock") : "clock";
      shiftMin = 0;
      changes.add("time");
    }
    if (shift) {
      shiftMin += shift;
      changes.add("time");
    }
    if (p.date) {
      out.date = p.date;
      out.dayPhrase = p.dayPhrase;
      changes.add("date");
    }
    if (p.category && p.category !== out.category) {
      out.category = p.category;
      changes.add("category");
    }
    if (p.budgetGBP) {
      out.budgetGBP = p.budgetGBP;
      changes.add("budget");
    }
    if (p.maxMinutes) {
      out.maxMinutes = p.maxMinutes;
      changes.add("maxMinutes");
    }
    if (p.walkIn) out.walkIn = true;
    if (p.free) {
      out.free = true;
      changes.add("free");
    }
    if (out.intent === "meet_halfway" && NEAR_ME.test(r) && !CLOSER_YOU.test(r)) {
      out.intent = "near_me";
      changes.add("near_me");
    }
    if (YOU_MOVED.test(r) && p.youPlace) {
      out.youPlace = p.youPlace;
      changes.add("you_place");
    }
    if (CHEAPER.test(r)) {
      prefs.add("cheaper");
      if (out.budgetGBP && !p.budgetGBP) out.budgetGBP = Math.max(5, Math.round(out.budgetGBP * 0.75));
    }
    if (QUIETER.test(r)) prefs.add("quieter");
    if (TERRACE.test(r)) {
      prefs.delete("indoor");
      prefs.add("terrace");
    }
    if (INDOOR.test(r) && !TERRACE.test(r)) {
      prefs.delete("terrace");
      prefs.add("indoor");
    }
    if (CLOSER_YOU.test(r)) {
      prefs.delete("closer_them");
      prefs.add("closer_you");
    } else if (CLOSER_THEM.test(r) && !/\bcloser to (?:me|the station|home)\b/i.test(r)) {
      prefs.delete("closer_you");
      prefs.add("closer_them");
    }
    if (DIFFERENT.test(r)) prefs.add("different");
    const cu = cuisineOf(r);
    if (cu) {
      out.cuisine = cu;
      if (!out.category) out.category = "restaurant";
      changes.add("cuisine");
    }
    latestAsks = OPEN_Q.test(r) ? ["open"] : [];
    latestChanges = new Set(changes);
    latestPrefs = new Set([...prefs].filter((p) => !before.prefs.has(p) || turnPrefs(r).includes(p)));
    for (const c of before.changes) changes.add(c);
  }
  out.prefs = [...prefs];
  if (refinements.length) out.signals.push(`refined: ${[...changes, ...prefs].join(", ") || "nothing recognised"}`);
  return { ask: out, refinement: { prefs: [...prefs], shiftMin, changes: [...changes], texts: refinements, latest: { changes: [...latestChanges], prefs: [...prefs].filter((p) => latestPrefs.has(p)), asks: latestAsks } } };
}

/** Preferences a single refinement text asks for (to tell "asked again" from "carried over"). */
function turnPrefs(r: string): Pref[] {
  const o: Pref[] = [];
  if (CHEAPER.test(r)) o.push("cheaper");
  if (QUIETER.test(r)) o.push("quieter");
  if (TERRACE.test(r)) o.push("terrace");
  if (INDOOR.test(r) && !TERRACE.test(r)) o.push("indoor");
  if (CLOSER_YOU.test(r)) o.push("closer_you");
  else if (CLOSER_THEM.test(r)) o.push("closer_them");
  if (DIFFERENT.test(r)) o.push("different");
  return o;
}

const has = (prefs: Pref[] | undefined, p: Pref) => !!prefs?.includes(p);

/** Heuristic price signal from OSM tags (no prices in our sources): -1 likely cheaper, +1 likely pricier. */
function cheapScore(t: Record<string, string>): number {
  const name = `${t.name ?? ""} ${t.brand ?? ""}`;
  const cuisine = t.cuisine ?? "";
  if (/wetherspoon|j ?d ?wetherspoon|sam(?:uel)? smith|greene king|craft union|stonegate/i.test(name)) return -1;
  if (t.amenity === "fast_food" || /pizza|burger|kebab|chicken|noodle|sandwich|fish_and_chips|falafel|street_food|bakery|ramen|dumpling|cafe/i.test(cuisine)) return -1;
  if (/cocktail|champagne|wine|fine_dining|steak_house|sushi|french|oyster/i.test(`${cuisine} ${t.bar ?? ""}`) || /hotel|club|champagne|cocktail/i.test(name) || t.stars) return 1;
  return 0;
}

/** Loudness signal from OSM tags (no noise data): +1 likely louder. */
function loudScore(t: Record<string, string>): number {
  if (t.live_music === "yes" || t.sport || t.television === "yes" || t["sport:tv"] === "yes" || t.amenity === "nightclub" || t.karaoke === "yes") return 1;
  if (t.amenity === "bar" || /\bsports?\b|\bclub\b|karaoke|\blounge\b/i.test(t.name ?? "")) return 1;
  return 0;
}

/** Lower = better for the soft wishes. 0 when there are none. */
export function prefRank(tags: Record<string, string>, prefs: Pref[] | undefined): number {
  if (!prefs?.length) return 0;
  let s = 0;
  if (has(prefs, "cheaper")) s += cheapScore(tags);
  if (has(prefs, "quieter")) s += loudScore(tags);
  if (has(prefs, "terrace")) s += weatherRank(tags, { mode: "warm", label: "" });
  if (has(prefs, "indoor")) s += weatherRank(tags, { mode: "wet", label: "" }) / 2;
  return s;
}

/** Card fact for terrace / indoor wishes, from OSM seating tags. */
export function seatingWish(tags: Record<string, string>, prefs: Pref[] | undefined): { label: string; value: string; ok: boolean } | null {
  const s = seatingOf(tags);
  if (has(prefs, "terrace")) {
    const ok = s.outdoor_seating === true || s.beer_garden === true;
    return { label: "Outdoor seating", value: ok ? (s.beer_garden ? "Beer garden (OSM tag)" : "Yes (OSM tag)") : s.outdoor_seating === false ? "No (OSM tag)" : "Not tagged in OSM", ok };
  }
  if (has(prefs, "indoor")) {
    const ok = s.indoor_seating === true || s.covered === true;
    return { label: "Indoor seating", value: ok ? "Yes (OSM tag)" : s.indoor_seating === false ? "No (OSM tag)" : "Not tagged in OSM", ok };
  }
  return null;
}

/** Hub choice for meet-halfway: fairest by default; closer to one side, or the next one along, on request. */
export function pickHub<H extends { a: { minutes: number }; b: { minutes: number } }>(ranked: H[], prefs: Pref[] | undefined): { hub: H | undefined; why: "fair" | "closer_you" | "closer_them" | "different" } {
  const fair = ranked[0];
  if (!fair) return { hub: undefined, why: "fair" };
  const pool = ranked.slice(0, 8);
  const side = has(prefs, "closer_you") ? "a" : has(prefs, "closer_them") ? "b" : null;
  if (side) {
    const other = side === "a" ? "b" : "a";
    // Shorter for that side, without making the other side's trip more than 2x the fair one.
    const better = pool.filter((h) => h[side].minutes < fair[side].minutes && h[other].minutes <= Math.max(fair[other].minutes * 2, fair[other].minutes + 15));
    better.sort((x, y) => x[side].minutes - y[side].minutes || x[other].minutes - y[other].minutes);
    if (better[0]) return { hub: better[0], why: side === "a" ? "closer_you" : "closer_them" };
  }
  if (has(prefs, "different") && ranked[1]) return { hub: ranked[1], why: "different" };
  return { hub: fair, why: "fair" };
}

/** "8pm", "8:30pm", "noon". */
export function clock12(hh: number, mm: number): string {
  if (hh === 12 && mm === 0) return "noon";
  const h = hh % 12 === 0 ? 12 : hh % 12;
  return `${h}${mm ? `:${String(mm).padStart(2, "0")}` : ""}${hh < 12 ? "am" : "pm"}`;
}

const PREF_PHRASE: Record<Pref, string> = {
  cheaper: "somewhere likely cheaper",
  quieter: "somewhere likely quieter",
  terrace: "somewhere with outdoor seating",
  indoor: "somewhere indoors",
  closer_you: "a spot closer to you",
  closer_them: "a spot closer to them",
  different: "a different option",
};

/** One plain sentence describing what changed and the new top pick. */
export function refineReply(opts: {
  refinement: Refinement;
  prefs: Pref[];
  whenLabel: { day: string; clock: string; dateChanged: boolean };
  category?: string | null;
  who: string;
  top?: { name: string; seating?: { ok: boolean } | null; closesAt?: string | null; hoursKnown?: boolean; openAtPlan?: boolean | null };
  /** Cards that match the cuisine wish (names), when one was asked this turn. */
  cuisine?: { key: string; matches: string[] };
  /** Name of the selected place the search was centred on (refine `focus`). */
  near?: string;
  hubName?: string;
  hubWhy?: string;
  clarify?: string;
  maxMinutes?: number | null;
  intent: string;
}): string {
  const { top } = opts;
  const r = opts.refinement.latest;
  if (opts.clarify) return opts.clarify;
  const parts: string[] = [];
  if (r.changes.includes("time") || r.changes.includes("date"))
    parts.push(`Moved to ${r.changes.includes("date") || opts.whenLabel.dateChanged ? `${opts.whenLabel.day} at ` : ""}${opts.whenLabel.clock}`);
  if (r.changes.includes("category") && opts.category) parts.push(`switched to ${opts.category === "cafe" ? "cafés" : opts.category === "event" ? "events" : `${opts.category}s`}`);
  if (r.changes.includes("near_me")) parts.push("switched to places near you");
  if (r.changes.includes("free")) parts.push("kept it to free entry");
  if (r.changes.includes("budget")) parts.push("updated the budget");
  if (r.changes.includes("maxMinutes") && opts.maxMinutes) parts.push(`kept it within ${opts.maxMinutes} min`);
  if (r.changes.includes("you_place")) parts.push("started from your new spot");
  for (const p of r.prefs) {
    if (p === "terrace" || p === "indoor") {
      parts.push(top?.seating?.ok ? `picked ${PREF_PHRASE[p]}` : `looked for ${PREF_PHRASE[p]} (none tagged nearby, so this is the best match)`);
    } else if (p === "closer_you" || p === "closer_them") {
      const said = p === "closer_you" ? "closer to you" : `closer to ${opts.who === "them" ? "them" : opts.who}`;
      if (opts.intent === "meet_halfway") parts.push(opts.hubWhy === p ? `moved the meeting point ${said}${opts.hubName ? ` (${opts.hubName})` : ""}` : `kept the fairest middle (no hub was ${said} without a much longer trip for the other side)`);
      else parts.push("put the nearest options first");
    } else parts.push(`picked ${PREF_PHRASE[p]}`);
  }
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  // Opening-hours question about the current pick: answered from OSM opening_hours, no replanning wording.
  const openAns = r.asks.includes("open") && top
    ? top.hoursKnown === false ? `No hours listed for ${top.name}` : top.openAtPlan === false ? `${top.name} looks closed at ${opts.whenLabel.clock}` : top.closesAt ? `${top.name} is open until ${top.closesAt}` : `${top.name} is open at ${opts.whenLabel.clock}`
    : null;
  if (r.changes.includes("cuisine") && opts.cuisine) {
    const lbl = cuisineLabel(opts.cuisine.key);
    const m = opts.cuisine.matches.slice(0, 3);
    const near = opts.near ? ` near ${opts.near}` : "";
    const c = m.length ? `found ${m.length} ${lbl} option${m.length > 1 ? "s" : ""}${near}: ${m.join(", ")}` : `no ${lbl} places are tagged ${near ? near.trim() : "near there"}, so these are the closest matches`;
    const rest = parts.length ? `${parts.join(" and ")} and ${c}` : c;
    return `${cap(rest)}${openAns ? `; ${openAns.charAt(0).toLowerCase() === "n" && openAns.startsWith("No hours") ? "n" + openAns.slice(1) : openAns}` : ""}.`;
  }
  if (!parts.length) {
    if (openAns) return `${openAns}.`;
    return top
      ? `Not sure what to change for ${top.name}: try a time ("8pm"), a type ("Italian", "a pub"), "quieter" or "closer to me".`
      : `Not sure what to change: try a time ("8pm"), a type ("Italian", "a pub"), "quieter" or "closer to me".`;
  }
  const s = cap(parts.join(" and "));
  return top ? `${s}: ${top.name}${openAns ? `; ${openAns.startsWith(top.name) ? `it${openAns.slice(top.name.length)}` : openAns}` : ""}.` : `${s}, but nothing open came up; try another time or area.`;
}
