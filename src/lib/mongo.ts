// MongoDB Atlas connection for serverless (Vercel): one MongoClient promise cached on globalThis so warm
// invocations reuse the pool. getDb() never throws: it returns null when MONGODB_URI is unset, the connect
// fails, or it takes longer than the caller's wait (2.5 s on the plan's critical path), so callers always
// fall back to the bundled snapshot path. A slow cold-start connect (SRV lookup + TLS + auth on a fresh
// serverless instance can take 3–6 s) keeps going in the background for later callers instead of failing.
import { MongoClient, type Db } from "mongodb";

export const MONGO_DB_NAME = process.env.MONGODB_DB || "sowhere";
const CONNECT_BUDGET_MS = 2500; // how long the plan's critical path waits
const DRIVER_TIMEOUT_MS = 10_000; // how long the driver itself may take to connect
const RETRY_AFTER_FAIL_MS = 30_000; // after a failed connect, don't make every request wait 2.5 s again

type MongoState = { client?: Promise<MongoClient>; connected?: boolean; waitedOutAt?: number; failedAt?: number; lastError?: string };
const g = globalThis as typeof globalThis & { __soWhereMongo?: MongoState };
const state: MongoState = (g.__soWhereMongo ??= {});

/** Resolve `p`, or reject after `ms` (the underlying work keeps going and can still be reused later). */
export function withTimeout<T>(p: Promise<T>, ms: number, what = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

function connect(uri: string): Promise<MongoClient> {
  const client = new MongoClient(uri, {
    appName: "so-where",
    maxPoolSize: 5,
    serverSelectionTimeoutMS: DRIVER_TIMEOUT_MS,
    connectTimeoutMS: DRIVER_TIMEOUT_MS,
    socketTimeoutMS: 10_000,
  });
  const p = client.connect();
  p.then(() => {
    if (state.client !== p) return;
    state.connected = true;
    state.lastError = undefined;
  }).catch((e: unknown) => {
    if (state.client !== p) return void client.close().catch(() => {});
    state.client = undefined;
    state.failedAt = Date.now();
    // Error class + code only (messages can carry the cluster host).
    state.lastError = e instanceof Error ? `${e.name}${(e as { code?: unknown }).code ? ` ${(e as { code?: unknown }).code}` : ""}` : "connect failed";
    void client.close().catch(() => {});
  });
  return p;
}

/** The `sowhere` database, or null when Mongo isn't configured or reachable right now. Never throws. */
export async function getDb(waitMs = CONNECT_BUDGET_MS): Promise<Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!state.client && state.failedAt && Date.now() - state.failedAt < RETRY_AFTER_FAIL_MS) return null;
  // A connect that already outlasted one critical-path wait: don't make every request wait again; only
  // callers with a longer budget (the plan_runs write, /api/stats) keep waiting for it.
  if (state.client && !state.connected && state.waitedOutAt && waitMs <= CONNECT_BUDGET_MS) return null;
  try {
    if (!state.client) {
      state.client = connect(uri);
      state.connected = false;
      state.waitedOutAt = undefined;
    }
    const client = await withTimeout(state.client, waitMs, "MongoDB connect");
    return client.db(MONGO_DB_NAME);
  } catch (e) {
    if (e instanceof Error && /timed out/.test(e.message)) {
      state.waitedOutAt = Date.now();
      state.lastError = `connect still pending after ${waitMs} ms`;
    }
    return null;
  }
}

/** Why the last connect failed (no secrets), for /api/stats diagnostics. */
export const mongoLastError = () => state.lastError ?? null;

/** Test hook: drop the cached client so a new MONGODB_URI is picked up. */
export async function resetMongoForTests() {
  const c = state.client;
  state.client = undefined;
  state.connected = false;
  state.failedAt = undefined;
  state.waitedOutAt = undefined;
  if (c) void c.then((x) => x.close()).catch(() => {}); // a still-pending connect closes itself when it settles
}
