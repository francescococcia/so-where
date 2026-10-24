// Small fetch helper for the plan pipeline: ~6 s timeout, one in-memory cache (a few minutes), and a
// result that never throws, so callers can return partial plans with "unknown" instead of errors.
// Nothing here is written to disk, and request URLs are never logged (they can contain a friend's station).

export type FetchResult<T> = { ok: true; data: T; fetchedAt: string; ms: number; cached: boolean } | { ok: false; error: string; ms: number; status?: number };

const cache = new Map<string, { at: number; data: unknown; fetchedAt: string }>();
const inflight = new Map<string, Promise<FetchResult<unknown>>>();
export const DEFAULT_TIMEOUT_MS = 6000;
export const DEFAULT_TTL_MS = 5 * 60_000;
export const USER_AGENT = "SoWhere/0.1 (Encode London 2026 hackathon app)";

// Gentle on public APIs: at most N requests in flight per host.
const active = new Map<string, number>();
const queue = new Map<string, (() => void)[]>();
async function slot(host: string, max: number) {
  if ((active.get(host) ?? 0) >= max) await new Promise<void>((res) => queue.set(host, [...(queue.get(host) ?? []), res]));
  active.set(host, (active.get(host) ?? 0) + 1);
  return () => {
    active.set(host, (active.get(host) ?? 1) - 1);
    const next = queue.get(host)?.shift();
    if (next) next();
  };
}

export async function getJson<T>(
  url: string,
  opts: { init?: RequestInit; ttlMs?: number; timeoutMs?: number; maxPerHost?: number } = {},
): Promise<FetchResult<T>> {
  const key = `${opts.init?.method ?? "GET"} ${url} ${typeof opts.init?.body === "string" ? opts.init.body : ""}`;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return { ok: true, data: hit.data as T, fetchedAt: hit.fetchedAt, ms: 0, cached: true };
  const pending = inflight.get(key);
  if (pending) return pending as Promise<FetchResult<T>>;
  const p = (async (): Promise<FetchResult<T>> => {
    const host = new URL(url).host;
    const release = await slot(host, opts.maxPerHost ?? 8);
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        ...opts.init,
        headers: { "User-Agent": USER_AGENT, Accept: "application/json", ...(opts.init?.headers ?? {}) },
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        cache: "no-store",
      });
      const ms = Date.now() - t0;
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status, ms };
      const data = (await res.json()) as T;
      const fetchedAt = new Date().toISOString();
      cache.set(key, { at: Date.now(), data, fetchedAt });
      if (cache.size > 500) cache.delete(cache.keys().next().value as string);
      return { ok: true, data, fetchedAt, ms: Date.now() - t0, cached: false };
    } catch (e) {
      const name = (e as Error)?.name;
      return { ok: false, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : String((e as Error)?.message ?? e), ms: Date.now() - t0 };
    } finally {
      release();
    }
  })();
  inflight.set(key, p as Promise<FetchResult<unknown>>);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}
