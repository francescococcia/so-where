// Minimal server-only helper for Next.js (route handlers / server actions).
// Reads credentials from env only. Returns null on any failure or timeout,
// so the caller can fall back to the local answer.
const DATASET = process.env.COGNEE_DATASET ?? "lumap_london";

export type CogneeOptions = { systemPrompt?: string; timeoutMs?: number };

export async function askCognee(question: string, opts: CogneeOptions = {}): Promise<string | null> {
  const base = process.env.COGNEE_BASE_URL;
  const key = process.env.COGNEE_API_KEY;
  const tenant = process.env.COGNEE_TENANT_ID;
  if (!base || !key || !tenant || !question.trim()) return null;

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": key,
        "X-Tenant-Id": tenant,
      },
      body: JSON.stringify({
        query: question,
        search_type: "GRAPH_COMPLETION",
        include_references: true,
        datasets: [DATASET],
        ...(opts.systemPrompt ? { system_prompt: opts.systemPrompt } : {}),
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12000),
      cache: "no-store",
    });
    // An older server that rejects system_prompt: ask again with the instructions in the query.
    if (res.status === 422 && opts.systemPrompt) return askCognee(`${question}\n\n${opts.systemPrompt}`, { timeoutMs: opts.timeoutMs });
    if (!res.ok) return null;
    // Response: [{ dataset_id, dataset_name, dataset_tenant_id, search_result: string[] }]
    const data = (await res.json()) as Array<{ search_result?: unknown }>;
    const first = Array.isArray(data) ? data[0]?.search_result : null;
    const text = Array.isArray(first) ? first.filter((s) => typeof s === "string").join("\n") : null;
    return text && text.trim() ? text.trim() : null;
  } catch {
    return null;
  }
}

