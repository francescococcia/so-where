"use client";

// Suggested venues, from the shared Supabase review queue (see submissions.ts).
// Adding and voting need email sign-in; nothing is kept only in this browser any more.

import { LONDON_AREAS } from "@/lib/areas";
import { VENUES_EVENT, isMine, myVote, revokeShared, sharedRows, submitShared, voteShared, type Result, type SubmissionRow, type Vote } from "@/lib/submissions";

export type PendingVenue = {
  id: string;
  name: string;
  address: string;
  area: string;
  capacity: number | null;
  note: string;
  lat: number;
  lng: number;
  vouches: number;
  status: "pending" | "verified" | "rejected";
  createdAt: string;
  myVote?: Vote;
  /** submitted by the signed-in person */
  mine?: boolean;
};

export const VOUCHES_NEEDED = 2;
export const CHANGE_EVENT = VENUES_EVENT;

const fromRow = (r: SubmissionRow): PendingVenue => ({
  id: r.id,
  name: r.name,
  address: r.address ?? "",
  area: r.area ?? "",
  capacity: r.capacity,
  note: r.note ?? "",
  lat: r.lat,
  lng: r.lng,
  vouches: r.vouch_count,
  status: r.status,
  createdAt: r.created_at,
  myVote: myVote(r.id),
  mine: isMine(r),
});

export function listVenues(): PendingVenue[] {
  return sharedRows("venue").map(fromRow);
}

export async function addVenue(input: { name: string; address: string; area: string; capacity: number | null; note: string }): Promise<Result> {
  const base = LONDON_AREAS.find((a) => a.name === input.area) ?? LONDON_AREAS[0];
  const lat = base.lat + (Math.random() - 0.5) * 0.006;
  const lng = base.lng + (Math.random() - 0.5) * 0.009;
  const res = await submitShared({
    kind: "venue",
    name: input.name,
    organiser: null,
    venue_name: null,
    address: input.address || null,
    area: input.area,
    capacity: input.capacity,
    day_of_week: null,
    start_time: null,
    end_time: null,
    price: null,
    url: null,
    note: input.note || null,
    lat,
    lng,
  });
  return res;
}

export const vouchVenue = (id: string): Promise<Result> => voteShared(id, "vouch");
export const rejectVenue = (id: string): Promise<Result> => voteShared(id, "reject");
export const revokeVenue = (id: string): Promise<Result> => revokeShared(id);
