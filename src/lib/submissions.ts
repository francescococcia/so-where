"use client";

// Shared review queue in Supabase (tables `submissions` and `submission_vouches`).
// Everyone can read it; adding, vouching, rejecting and revoking need email sign-in.
// The database ties each row to auth.uid(), flips a submission to verified at 2 distinct
// vouches, refuses self-vouches, and caps submissions per person per day.

import { currentUserId } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase";

export const VENUES_EVENT = "lumap:venues-changed";
export const SESSIONS_EVENT = "lumap:sessions-changed";

export type SubmissionRow = {
  id: string;
  kind: "venue" | "session";
  status: "pending" | "verified" | "rejected";
  name: string;
  organiser: string | null;
  venue_name: string | null;
  address: string | null;
  area: string | null;
  capacity: number | null;
  day_of_week: string | null;
  start_time: string | null;
  end_time: string | null;
  price: string | null;
  url: string | null;
  note: string | null;
  lat: number;
  lng: number;
  vouch_count: number;
  reject_count: number;
  created_at: string;
  submitter: string;
};

export type NewSubmission = Omit<SubmissionRow, "id" | "status" | "vouch_count" | "reject_count" | "created_at" | "submitter">;
export type Vote = "vouch" | "reject";
export type Result = { ok: true; id: string } | { ok: false; error: string; signIn?: boolean };

const COLUMNS =
  "id,kind,status,name,organiser,venue_name,address,area,capacity,day_of_week,start_time,end_time,price,url,note,lat,lng,vouch_count,reject_count,created_at,submitter";

let rows: SubmissionRow[] = [];
let votes: Record<string, Vote> = {};
let me: string | null = null;
let started = false;
let inflight: Promise<void> | null = null;

function emit() {
  window.dispatchEvent(new Event(VENUES_EVENT));
  window.dispatchEvent(new Event(SESSIONS_EVENT));
}

export function myVote(id: string): Vote | undefined {
  return votes[id];
}

/** True when the signed-in person submitted this row. */
export function isMine(row: { submitter?: string }): boolean {
  return Boolean(me && row.submitter === me);
}

/** Rows from the shared queue (newest first). Starts loading and polling on first use. */
export function sharedRows(kind: SubmissionRow["kind"]): SubmissionRow[] {
  if (typeof window === "undefined") return [];
  if (!started) {
    started = true;
    void refreshQueue();
    window.setInterval(() => void refreshQueue(), 30_000);
    window.addEventListener("focus", () => void refreshQueue());
    getSupabase().auth.onAuthStateChange(() => {
      window.setTimeout(() => void refreshQueue(), 0);
    });
  }
  return rows.filter((r) => r.kind === kind);
}

export function refreshQueue(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data, error } = await getSupabase()
        .from("submissions")
        .select(COLUMNS)
        .neq("status", "rejected")
        .order("created_at", { ascending: false })
        .limit(300);
      if (!error && data) rows = data as SubmissionRow[];
      me = await currentUserId();
      votes = {};
      if (me) {
        const mine = await getSupabase().from("submission_vouches").select("submission_id,vote").eq("voter", me).limit(1000);
        for (const v of (mine.data ?? []) as { submission_id: string; vote: Vote }[]) votes[v.submission_id] = v.vote;
      }
      emit();
    } catch {
      /* offline: keep the last copy */
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

function explain(error: { code?: string; message?: string }): string {
  if (error.code === "23505") return "That's already in the review queue.";
  if (error.code === "23514") {
    if (/contact_details/.test(error.message ?? "")) return "Please leave out emails and phone numbers.";
    if (/lat_check|lng_check/.test(error.message ?? "")) return "That address doesn't look like it's in London.";
    return error.message && !/violates check constraint/.test(error.message) ? error.message : "Some fields are too long or not valid.";
  }
  return error.message ?? "Couldn't save.";
}

const SIGN_IN: Result = { ok: false, error: "Sign in with email to contribute.", signIn: true };

function failure(error: { code?: string; message?: string }): Result {
  if (/row-level security/i.test(error.message ?? "")) return { ok: false, error: "You can't do that on this item." };
  if (error.code === "42501" || /JWT|not authenticated/i.test(error.message ?? "")) return SIGN_IN;
  return { ok: false, error: explain(error) };
}

export async function submitShared(input: NewSubmission): Promise<Result> {
  if (!(await currentUserId())) return SIGN_IN;
  try {
    const { data, error } = await getSupabase().from("submissions").insert(input).select("id").single();
    if (error) return failure(error);
    await refreshQueue();
    return { ok: true, id: (data as { id: string }).id };
  } catch {
    return { ok: false, error: "Couldn't reach the review queue. Check your connection and try again." };
  }
}

export async function voteShared(id: string, vote: Vote): Promise<Result> {
  if (!(await currentUserId())) return SIGN_IN;
  try {
    const { error } = await getSupabase().from("submission_vouches").insert({ submission_id: id, vote });
    await refreshQueue();
    if (error) {
      if (error.code === "23505") return { ok: false, error: "You've already voted on this one." };
      return failure(error);
    }
    return { ok: true, id };
  } catch {
    return { ok: false, error: "Couldn't reach the review queue. Check your connection and try again." };
  }
}

/** Take back your own vouch or rejection; the database re-counts (a verified item can drop back to pending). */
export async function revokeShared(id: string): Promise<Result> {
  const uid = await currentUserId();
  if (!uid) return SIGN_IN;
  try {
    const { data, error } = await getSupabase().from("submission_vouches").delete().eq("submission_id", id).eq("voter", uid).select("id");
    await refreshQueue();
    if (error) return failure(error);
    if (!data?.length) return { ok: false, error: "You haven't voted on this one." };
    return { ok: true, id };
  } catch {
    return { ok: false, error: "Couldn't reach the review queue. Check your connection and try again." };
  }
}
