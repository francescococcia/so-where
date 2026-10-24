// Shared contract between the UI lane and the DATA lane. Do not change without updating both.
export type Verdict = "confirmed" | "likely" | "unknown" | "forecast";

export interface Fact {
  label: string;          // e.g. "Open Thu", "Trains", "Weather", "Price", "Sign-up"
  value: string;          // plain English, e.g. "12:00–00:00"
  verdict: Verdict;
  source: string;         // e.g. "OSM", "TfL", "Open-Meteo", "Luma seed"
  asOf?: string;          // ISO timestamp the data was fetched or last checked
}

export interface LatLng { lat: number; lng: number }

export interface Leg {
  who: "you" | "them";
  minutes: number;
  summary: string;        // e.g. "Northern line, direct"
  path?: LatLng[];        // polyline for the map, optional
}

export interface PlanCard {
  id: string;
  kind: "venue" | "event";
  name: string;
  subtitle: string;       // e.g. "Pub · 173 Borough High St, SE1"
  location: LatLng;
  legs: Leg[];            // 1 leg for near-me, 2 for meet-halfway
  facts: Fact[];
  why: string;            // one line: why this pick
  url?: string;
}

export type Intent = "meet_halfway" | "near_me";

export interface PlanResult {
  intent: Intent;
  query: string;
  headline: string;       // e.g. "Borough is the fair middle: you 24 min, her 23."
  when: string;           // ISO datetime the plan is for
  you: LatLng;            // exact only on device; never stored server-side
  them?: { area: string; center: LatLng; radiusM: number }; // rounded ~500 m, never stored
  middle?: { name: string; location: LatLng };
  filters: { walkIn?: boolean; free?: boolean; maxMinutes?: number; budgetGBP?: number; category?: string };
  cards: PlanCard[];      // up to 3
  unknowns: string[];     // things we couldn't check, shown to the user
  sources: { name: string; asOf: string }[];
  draftMessage: string;   // "Send plan" text; never includes the other person's area or address
}
// Append to src/lib/plan-types.ts (both lanes, byte-for-byte)
export interface AgentStep {
  id: string;
  label: string;          // e.g. "Checking TfL journey times"
  status: "running" | "done" | "failed" | "skipped";
  detail?: string;        // e.g. "12 stations compared, Borough fairest"
  source?: string;
  ms?: number;
}

export interface Clarify {
  question: string;       // e.g. "Where's your friend coming from?"
  missing: "them_location" | "my_location" | "time" | "category";
  suggestions?: string[]; // quick-reply chips, e.g. ["Clapham", "Brixton", "Stratford"]
}

// Streaming: POST /api/plan with header Accept: application/x-ndjson returns one JSON object per line:
//   {"type":"step","step":AgentStep} ... then {"type":"result","result":PlanResultWithAgent} or {"type":"clarify","clarify":Clarify}
// Without that header it returns PlanResultWithAgent as plain JSON.
export interface PlanResultWithAgent extends PlanResult {
  steps: AgentStep[];
  clarify?: Clarify;      // when set, cards may be empty and the UI asks this one question
}
