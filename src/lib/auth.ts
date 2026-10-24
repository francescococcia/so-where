"use client";

// Email sign-in state, plus "intents": an action someone started while signed out
// (add a venue, host a session, vouch/reject) that resumes once they're signed in.

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";

export const SIGNIN_EVENT = "lumap:signin-open";
const INTENT_KEY = "lumap.intent.v1";
const INTENT_TTL_MS = 60 * 60 * 1000;

export type Intent =
  | { type: "add-venue"; draft?: Record<string, string> }
  | { type: "host-session"; draft?: Record<string, string> }
  | { type: "vote"; id: string; kind: "venue" | "session"; vote: "vouch" | "reject" }
  // From the venue panel: "Vouch, I've hosted here" or "Share what it's like". The venue is kept so
  // the panel can reopen on it after the magic-link round trip.
  | { type: "venue-report"; action: "vouch" | "report"; venue: { id: string; name: string; address: string | null; lat: number; lng: number; capacity: number | null; status: string | null } };

let current: User | null = null;
let ready = false;
const listeners = new Set<() => void>();

function start() {
  if (typeof window === "undefined" || ready) return;
  ready = true;
  const sb = getSupabase();
  void sb.auth.getSession().then(({ data }) => {
    current = data.session?.user ?? null;
    listeners.forEach((l) => l());
  });
  sb.auth.onAuthStateChange((_event, session) => {
    current = session?.user ?? null;
    listeners.forEach((l) => l());
  });
}

/** The signed-in user (undefined while loading, null when signed out). */
export function useUser(): User | null | undefined {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    start();
    const update = () => setUser(current);
    listeners.add(update);
    void getSupabase()
      .auth.getSession()
      .then(({ data }) => setUser(data.session?.user ?? null));
    return () => {
      listeners.delete(update);
    };
  }, []);
  return user;
}

export async function currentUserId(): Promise<string | null> {
  const { data } = await getSupabase().auth.getSession();
  return data.session?.user.id ?? null;
}

export function saveIntent(intent: Intent) {
  window.localStorage.setItem(INTENT_KEY, JSON.stringify({ ...intent, at: Date.now() }));
}

/** Returns and clears a saved intent of the given type (if it's recent). */
export function takeIntent<T extends Intent["type"]>(type: T): Extract<Intent, { type: T }> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(INTENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Intent & { at: number };
    if (Date.now() - parsed.at > INTENT_TTL_MS) {
      window.localStorage.removeItem(INTENT_KEY);
      return null;
    }
    if (parsed.type !== type) return null;
    window.localStorage.removeItem(INTENT_KEY);
    return parsed as unknown as Extract<Intent, { type: T }>;
  } catch {
    return null;
  }
}

/** Ask the visitor to sign in, remembering what they were doing. */
export function requestSignIn(intent?: Intent) {
  if (intent) saveIntent(intent);
  window.dispatchEvent(new CustomEvent(SIGNIN_EVENT));
}

export async function signOut() {
  await getSupabase().auth.signOut();
}
