// MongoDB Atlas connection for serverless (Vercel): one MongoClient promise cached on globalThis so warm
// invocations reuse the pool. getDb() never throws: it returns null when MONGODB_URI is unset, the connect
// fails, or it takes longer than ~2.5 s, so callers always fall back to the bundled snapshot path.
import { MongoClient, type Db } from "mongodb";

export const MONGO_DB_NAME = process.env.MONGODB_DB || "sowhere";
const CONNECT_BUDGET_MS = 2500;
const RETRY_AFTER_FAIL_MS = 30_000; // after a failed connect, don't make every request wait 2.5 s again

type MongoState = { client?: Promise<MongoClient>; failedAt?: number };
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
    serverSelectionTimeoutMS: CONNECT_BUDGET_MS,
    connectTimeoutMS: CONNECT_BUDGET_MS,
    socketTimeoutMS: 10_000,
  });
  const p = client.connect();
  p.catch(() => {
    if (state.client === p) state.client = undefined;
    state.failedAt = Date.now();
    void client.close().catch(() => {});
  });
  return p;
}

/** The `sowhere` database, or null when Mongo isn't configured or reachable right now. Never throws. */
export async function getDb(): Promise<Db | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;
  if (!state.client && state.failedAt && Date.now() - state.failedAt < RETRY_AFTER_FAIL_MS) return null;
  try {
    state.client ??= connect(uri);
    const client = await withTimeout(state.client, CONNECT_BUDGET_MS, "MongoDB connect");
    return client.db(MONGO_DB_NAME);
  } catch {
    return null;
  }
}

/** Test hook: drop the cached client so a new MONGODB_URI is picked up. */
export async function resetMongoForTests() {
  const c = state.client;
  state.client = undefined;
  state.failedAt = undefined;
  if (c) await c.then((x) => x.close()).catch(() => {});
}
