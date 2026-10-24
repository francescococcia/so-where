// Agent memory in MongoDB: one anonymised `plan_runs` document per finished plan, aggregated by
// GET /api/stats ("what the agent learned") and used to tie-break near-equal hubs.
// PRIVACY: never store coordinates (yours or the other person's), place names typed by the user, the raw
// query, step detail text, or the draft message. Only the detected intent type, fixed labels, public TfL
// hub names and OSM venue ids. If the chosen hub sits within 1 km of either person, it is NOT stored
// (it would reveal where someone started), and neither are the card ids near it.
import type { Db } from "mongodb";
import { metresBetween } from "@/lib/geo";
import { londonParts } from "@/lib/london-time";
import { getDb, withTimeout } from "@/lib/mongo";
import type { PlanResultWithAgent, Verdict } from "@/lib/plan-types";
import type { HubScore } from "@/lib/tfl";

const WRITE_BUDGET_MS = 5000; // off the critical path: the result is already sent when this runs
const WRITE_CONNECT_WAIT_MS = 8000; // a cold serverless instance may still be connecting
const HUB_PRIVACY_M = 1000;

export type PlanRunDoc = {
  createdAt: Date;
  intent: PlanResultWithAgent["intent"];
  category: string | null;
  filters: { walkIn: boolean; free: boolean; hasBudget: boolean; maxMinutes: number | null };
  hub: string | null;
  hubSuppressed: boolean;
  cards: { id: string; kind: "venue" | "event" }[];
  cardCount: number;
  venueSource: string | null;
  steps: { id: string; status: string; ms: number | null; source: string | null }[];
  verdicts: Record<Verdict, number>;
  factsTotal: number;
  unknownsCount: number;
  latencyMs: number;
  planHour: number; // London hour the plan is for (0–23), not where
  evals: { allFactsSourced: boolean; allSourcesHaveAsOf: boolean; draftOmitsTheirArea: boolean | null; withinCardLimit: boolean; hasMiddle: boolean | null };
};

/** Build the anonymised record. Exported so tests can check exactly what is (not) stored. */
export function planRunDoc(r: PlanResultWithAgent, latencyMs: number, now = new Date()): PlanRunDoc {
  const facts = r.cards.flatMap((c) => c.facts);
  const verdicts: Record<Verdict, number> = { confirmed: 0, likely: 0, unknown: 0, forecast: 0 };
  for (const f of facts) if (f.verdict in verdicts) verdicts[f.verdict]++;
  const mid = r.middle;
  const nearSomeone = !!mid && (metresBetween(mid.location, r.you) < HUB_PRIVACY_M || (!!r.them && metresBetween(mid.location, r.them.center) < HUB_PRIVACY_M));
  const hub = mid && !nearSomeone ? mid.name : null;
  // near-me cards sit around the user's own location, so only meet-halfway cards (around a public hub) are kept
  const keepCards = r.intent === "meet_halfway" && !!hub;
  const venueStep = r.steps.find((s) => s.id === "venues");
  return {
    createdAt: now,
    intent: r.intent,
    category: r.filters.category ?? null,
    filters: { walkIn: !!r.filters.walkIn, free: !!r.filters.free, hasBudget: !!r.filters.budgetGBP, maxMinutes: r.filters.maxMinutes ?? null },
    hub,
    hubSuppressed: !!mid && !hub,
    cards: keepCards ? r.cards.map((c) => ({ id: c.id, kind: c.kind })) : [],
    cardCount: r.cards.length,
    venueSource: venueStep?.source ?? null,
    steps: r.steps.map((s) => ({ id: s.id, status: s.status, ms: s.ms ?? null, source: s.source ?? null })),
    verdicts,
    factsTotal: facts.length,
    unknownsCount: r.unknowns.length,
    latencyMs,
    planHour: londonParts(new Date(r.when)).hh,
    evals: {
      allFactsSourced: facts.every((f) => !!f.source?.trim()),
      allSourcesHaveAsOf: r.sources.length > 0 && r.sources.every((s) => !!s.asOf),
      draftOmitsTheirArea: r.them ? !r.draftMessage.toLowerCase().includes(r.them.area.toLowerCase()) : null,
      withinCardLimit: r.cards.length <= 3,
      hasMiddle: r.intent === "meet_halfway" ? !!r.middle : null,
    },
  };
}

/** Insert the anonymised run; returns false (never throws) when Mongo is unavailable. */
export async function recordPlanRun(r: PlanResultWithAgent, latencyMs: number, dbIn?: Db | null): Promise<boolean> {
  try {
    const db = dbIn === undefined ? await getDb(WRITE_CONNECT_WAIT_MS) : dbIn;
    if (!db) return false;
    await withTimeout(db.collection<PlanRunDoc>("plan_runs").insertOne(planRunDoc(r, latencyMs)), WRITE_BUDGET_MS, "plan_runs insert");
    return true;
  } catch {
    return false;
  }
}

/** How often each hub was chosen in past plans. */
export async function hubPickCounts(names: string[], dbIn?: Db | null): Promise<Map<string, number> | null> {
  try {
    const db = dbIn === undefined ? await getDb() : dbIn;
    if (!db || !names.length) return null;
    const rows = await withTimeout(
      db.collection("plan_runs").aggregate<{ _id: string; n: number }>([{ $match: { hub: { $in: names } } }, { $group: { _id: "$hub", n: { $sum: 1 } } }], { maxTimeMS: 1500 }).toArray(),
      1500,
      "hub history",
    );
    return new Map(rows.map((r) => [r._id, r.n]));
  } catch {
    return null;
  }
}

/**
 * When the top hubs are near-tied (worst journey within 1 min of the best), order the tied group by how often
 * past plans picked them (MongoDB plan_runs). Mutates `ranked`; returns step text when history was used.
 */
export async function tieBreakByHistory(ranked: HubScore[], dbIn?: Db | null): Promise<string | null> {
  if (ranked.length < 2) return null;
  const tied = ranked.filter((h) => h.worst <= ranked[0].worst + 1);
  if (tied.length < 2) return null;
  const counts = await hubPickCounts(tied.map((h) => h.hub.name), dbIn);
  if (!counts || ![...counts.values()].some((n) => n > 0)) return null;
  const n = (h: HubScore) => counts.get(h.hub.name) ?? 0;
  const before = ranked[0].hub.name;
  const order = [...tied].sort((a, b) => n(b) - n(a) || a.worst - b.worst || a.gap - b.gap);
  ranked.splice(0, tied.length, ...order);
  const list = order.slice(0, 3).map((h) => `${h.hub.name} ${n(h)}×`).join(", ");
  return ranked[0].hub.name === before
    ? `near-tie (${tied.length} hubs within 1 min); past picks in MongoDB agree: ${list}`
    : `near-tie (${tied.length} hubs within 1 min) broken by past picks in MongoDB: ${list}`;
}

export type PlanStats = {
  available: true;
  totalPlans: number;
  last24h: number;
  medianLatencyMs: number | null;
  byIntent: { intent: string; count: number }[];
  topHubs: { hub: string; count: number }[];
  topVenues: { id: string; count: number }[];
  facts: { total: number; confirmed: number; likely: number; unknown: number; forecast: number; pctConfirmed: number | null };
  venueSources: { source: string; count: number }[];
  evals: { allFactsSourcedPct: number | null; draftPrivacyPct: number | null };
};

/** One aggregation pipeline ($facet) over plan_runs for the demo's "what the agent learned" panel. */
export function statsPipeline(now = new Date()) {
  const pct = (num: unknown, den: unknown) => ({ $cond: [{ $gt: [den, 0] }, { $round: [{ $multiply: [{ $divide: [num, den] }, 100] }, 1] }, null] });
  return [
    {
      $facet: {
        totals: [{ $group: { _id: null, n: { $sum: 1 }, last24h: { $sum: { $cond: [{ $gte: ["$createdAt", new Date(now.getTime() - 86_400_000)] }, 1, 0] } } } }],
        latency: [
          { $match: { latencyMs: { $type: "number" } } },
          { $sort: { latencyMs: 1 } },
          { $group: { _id: null, xs: { $push: "$latencyMs" } } },
          { $project: { median: { $arrayElemAt: ["$xs", { $floor: { $divide: [{ $subtract: [{ $size: "$xs" }, 1] }, 2] } }] } } },
        ],
        byIntent: [{ $group: { _id: "$intent", count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        topHubs: [{ $match: { hub: { $type: "string" } } }, { $group: { _id: "$hub", count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 5 }],
        topVenues: [{ $unwind: "$cards" }, { $group: { _id: "$cards.id", count: { $sum: 1 } } }, { $sort: { count: -1, _id: 1 } }, { $limit: 5 }],
        facts: [
          {
            $group: {
              _id: null,
              total: { $sum: "$factsTotal" },
              confirmed: { $sum: "$verdicts.confirmed" },
              likely: { $sum: "$verdicts.likely" },
              unknown: { $sum: "$verdicts.unknown" },
              forecast: { $sum: "$verdicts.forecast" },
            },
          },
          { $addFields: { pctConfirmed: pct("$confirmed", "$total") } },
        ],
        venueSources: [{ $group: { _id: { $ifNull: ["$venueSource", "none"] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }],
        evals: [
          {
            $group: {
              _id: null,
              n: { $sum: 1 },
              sourced: { $sum: { $cond: ["$evals.allFactsSourced", 1, 0] } },
              draftN: { $sum: { $cond: [{ $eq: [{ $type: "$evals.draftOmitsTheirArea" }, "bool"] }, 1, 0] } },
              draftOk: { $sum: { $cond: [{ $eq: ["$evals.draftOmitsTheirArea", true] }, 1, 0] } },
            },
          },
          { $project: { allFactsSourcedPct: pct("$sourced", "$n"), draftPrivacyPct: pct("$draftOk", "$draftN") } },
        ],
      },
    },
  ];
}

export async function planStats(dbIn?: Db | null): Promise<PlanStats | null> {
  const db = dbIn === undefined ? await getDb(8000) : dbIn;
  if (!db) return null;
  type F = { _id: string | null; count: number };
  const [f] = await db.collection("plan_runs").aggregate<Record<string, Record<string, unknown>[]>>(statsPipeline(), { maxTimeMS: 5000 }).toArray();
  const one = (k: string) => (f?.[k]?.[0] ?? {}) as Record<string, number | null>;
  const facts = one("facts");
  return {
    available: true,
    totalPlans: Number(one("totals").n ?? 0),
    last24h: Number(one("totals").last24h ?? 0),
    medianLatencyMs: (one("latency").median as number | undefined) ?? null,
    byIntent: ((f?.byIntent ?? []) as F[]).map((x) => ({ intent: String(x._id), count: x.count })),
    topHubs: ((f?.topHubs ?? []) as F[]).map((x) => ({ hub: String(x._id), count: x.count })),
    topVenues: ((f?.topVenues ?? []) as F[]).map((x) => ({ id: String(x._id), count: x.count })),
    facts: {
      total: Number(facts.total ?? 0),
      confirmed: Number(facts.confirmed ?? 0),
      likely: Number(facts.likely ?? 0),
      unknown: Number(facts.unknown ?? 0),
      forecast: Number(facts.forecast ?? 0),
      pctConfirmed: (facts.pctConfirmed as number | undefined) ?? null,
    },
    venueSources: ((f?.venueSources ?? []) as F[]).map((x) => ({ source: String(x._id), count: x.count })),
    evals: { allFactsSourcedPct: (one("evals").allFactsSourcedPct as number | undefined) ?? null, draftPrivacyPct: (one("evals").draftPrivacyPct as number | undefined) ?? null },
  };
}
