// GET /api/stats → aggregates over the anonymised MongoDB `plan_runs` collection ("what the agent learned"):
// total plans, median latency, most-chosen hubs/venues, % of facts confirmed. {available:false} without Mongo.
import { planStats } from "@/lib/plan-memory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const stats = await planStats();
    if (!stats) return Response.json({ available: false, reason: "MongoDB not configured or unreachable" }, { headers: { "Cache-Control": "no-store" } });
    return Response.json({ ...stats, source: "MongoDB Atlas plan_runs (aggregation pipeline)", asOf: new Date().toISOString() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ available: false, reason: "Stats query failed" }, { status: 200, headers: { "Cache-Control": "no-store" } });
  }
}
