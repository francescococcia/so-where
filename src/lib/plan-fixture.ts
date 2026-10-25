// EXAMPLE DATA. Two fixtures that mirror the docs/so-where mockups, used when /api/plan
// is missing or errors. The UI always labels these "example data". Values were
// read off the mockups (fetched Sat 24 Oct 2026, 18:49–18:53 BST); coordinates are approximate.
import type { AgentStep, Clarify, PlanResultWithAgent } from "@/lib/plan-types";

const FETCHED = "2026-10-24T17:49:00Z"; // 18:49 BST
const FETCHED_LATE = "2026-10-24T17:53:00Z";

const OLD_STREET = { lat: 51.5257, lng: -0.0877 };
const BOROUGH = { lat: 51.5011, lng: -0.0943 };
const CLAPHAM = { lat: 51.4618, lng: -0.1384 };

const youToBorough = [
  OLD_STREET,
  { lat: 51.5186, lng: -0.0886 }, // Moorgate
  { lat: 51.5133, lng: -0.0886 }, // Bank
  { lat: 51.5052, lng: -0.0864 }, // London Bridge
  BOROUGH,
];
const themToBorough = [
  CLAPHAM,
  { lat: 51.465, lng: -0.13 }, // Clapham North
  { lat: 51.4723, lng: -0.1228 }, // Stockwell
  { lat: 51.4819, lng: -0.1126 }, // Oval
  { lat: 51.4884, lng: -0.1053 }, // Kennington
  { lat: 51.4943, lng: -0.1001 }, // Elephant & Castle
  BOROUGH,
];

export const meetSteps: AgentStep[] = [
  { id: "parse", label: "Reading your ask", status: "done", detail: "Meet halfway · Thu 29 Oct 19:00 · pub · ~£40 for two", source: "rules", ms: 40 },
  { id: "geocode", label: "Finding Old Street and Clapham", status: "done", detail: "Clapham rounded to ~500 m, not stored", source: "TfL StopPoint", ms: 310 },
  { id: "fair", label: "Comparing 12 central stations", status: "done", detail: "Borough fairest: 24 vs 23 min", source: "TfL Journey Planner", ms: 920 },
  { id: "venues", label: "Finding pubs open at 19:00 near Borough", status: "done", detail: "3 open, hours from OSM", source: "OSM via Overpass", ms: 540 },
  { id: "status", label: "Checking Northern line status", status: "done", detail: "Good Service now", source: "TfL", ms: 160 },
  { id: "weather", label: "Forecast for Thu 19:00", status: "done", detail: "0% rain, 13°C", source: "Open-Meteo", ms: 130 },
  { id: "price", label: "Looking for prices", status: "failed", detail: "None of our sources has prices", source: "—", ms: 0 },
];

export const meetFixture: PlanResultWithAgent = {
  intent: "meet_halfway",
  query: "Date on Thursday at 7. I'm at Old Street, she's around Clapham. A pub halfway, about £40 for two.",
  headline: "Borough is the fair middle: you 24 min, her 23.",
  when: "2026-10-29T19:00:00Z",
  you: OLD_STREET,
  them: { area: "Clapham Common", center: CLAPHAM, radiusM: 500 },
  middle: { name: "Borough", location: BOROUGH },
  filters: { budgetGBP: 40, category: "pub" },
  cards: [
    {
      id: "blue-maid",
      kind: "venue",
      name: "The Blue Maid",
      subtitle: "Pub · 173 Borough High Street, SE1",
      location: { lat: 51.5003, lng: -0.0925 },
      legs: [
        { who: "you", minutes: 24, summary: "Walk · Northern line · walk", path: [...youToBorough, { lat: 51.5003, lng: -0.0925 }] },
        { who: "them", minutes: 23, summary: "Northern line, direct", path: [...themToBorough, { lat: 51.5003, lng: -0.0925 }] },
      ],
      facts: [
        { label: "Open Thu", value: "12:00–00:00", verdict: "likely", source: "OSM · no check date", asOf: FETCHED },
        { label: "Trains", value: "Northern line: Good Service", verdict: "confirmed", source: "TfL · recheck Thu", asOf: FETCHED },
        { label: "Weather", value: "0% rain, 13°C at 19:00", verdict: "forecast", source: "Open-Meteo", asOf: FETCHED },
        { label: "£40 for two", value: "No prices in our sources", verdict: "unknown", source: "—" },
      ],
      why: "Two minutes from Borough station and open past midnight.",
    },
    {
      id: "george-inn",
      kind: "venue",
      name: "The George Inn",
      subtitle: "Pub · 77 Borough High Street, SE1",
      location: { lat: 51.5043, lng: -0.0893 },
      legs: [
        { who: "you", minutes: 22, summary: "Northern line to London Bridge · walk", path: [...youToBorough.slice(0, 4), { lat: 51.5043, lng: -0.0893 }] },
        { who: "them", minutes: 26, summary: "Northern line · walk", path: [...themToBorough, { lat: 51.5043, lng: -0.0893 }] },
      ],
      facts: [
        { label: "Open Thu", value: "11:00–23:00", verdict: "likely", source: "OSM · no check date", asOf: FETCHED },
        { label: "Trains", value: "Northern line: Good Service", verdict: "confirmed", source: "TfL", asOf: FETCHED },
        { label: "Price", value: "No prices in our sources", verdict: "unknown", source: "—" },
      ],
      why: "Galleried coaching inn; a slightly longer trip for her.",
    },
    {
      id: "bunch-of-grapes",
      kind: "venue",
      name: "Bunch of Grapes",
      subtitle: "Pub · 2 St Thomas Street, SE1",
      location: { lat: 51.5049, lng: -0.0884 },
      legs: [
        { who: "you", minutes: 21, summary: "Northern line to London Bridge · walk", path: [...youToBorough.slice(0, 4), { lat: 51.5049, lng: -0.0884 }] },
        { who: "them", minutes: 27, summary: "Northern line · walk", path: [...themToBorough, { lat: 51.5049, lng: -0.0884 }] },
      ],
      facts: [
        { label: "Open Thu", value: "Hours not tagged", verdict: "unknown", source: "OSM", asOf: FETCHED },
        { label: "Trains", value: "Northern line: Good Service", verdict: "confirmed", source: "TfL", asOf: FETCHED },
      ],
      why: "Closest to London Bridge, but its hours aren't in OSM.",
    },
  ],
  unknowns: ["Prices: none of our sources has them", "How busy it will be", "Step-free access: not tagged in OSM", "Noise level"],
  sources: [
    { name: "TfL Journey Planner", asOf: FETCHED },
    { name: "OSM via Overpass", asOf: FETCHED },
    { name: "Open-Meteo", asOf: FETCHED_LATE },
  ],
  draftMessage:
    "Thursday 19:00 at The Blue Maid, 173 Borough High Street SE1 (2 min from Borough, Northern line). Open till midnight per OSM. See you there?",
  steps: meetSteps,
};

const HUB = { lat: 51.5272, lng: -0.0838 }; // near Encode Hub, Shoreditch (approx.)
const MUSEUM_HOME = { lat: 51.5318, lng: -0.0763 };
const VICTORIA_MIRO = { lat: 51.532, lng: -0.0942 };
const BROADWAY_MKT = { lat: 51.5365, lng: -0.0617 };

export const saturdaySteps: AgentStep[] = [
  { id: "parse", label: "Reading your ask", status: "done", detail: "Near me · Sat 31 Oct 11:00 · walk-in only", source: "rules", ms: 30 },
  { id: "locate", label: "Using your location", status: "done", detail: "Shoreditch, on your device only", source: "browser", ms: 60 },
  { id: "events", label: "Scanning events within 30 min", status: "done", detail: "41 events, 29 need an RSVP: hidden", source: "Luma seed", ms: 380 },
  { id: "free", label: "Finding free-entry places open Sat", status: "done", detail: "8 found with fee=no", source: "OSM via Overpass", ms: 710 },
  { id: "travel", label: "Timing walks and buses", status: "done", detail: "3 under 20 min", source: "TfL Journey Planner", ms: 640 },
  { id: "weather", label: "Forecast for Sat 11:00", status: "done", detail: "11°C, 3% rain", source: "Open-Meteo", ms: 120 },
];

export const saturdayFixture: PlanResultWithAgent = {
  intent: "near_me",
  query: "It's Saturday, what's on near me that I can just walk into?",
  headline: "Three places to just walk into, all under 20 min.",
  when: "2026-10-31T11:00:00Z",
  you: HUB,
  filters: { walkIn: true, maxMinutes: 30, free: false },
  cards: [
    {
      id: "museum-of-the-home",
      kind: "venue",
      name: "Museum of the Home",
      subtitle: "Museum · Kingsland Road, E2",
      location: MUSEUM_HOME,
      legs: [{ who: "you", minutes: 12, summary: "Walk, or bus 394 · 13 min", path: [HUB, { lat: 51.5282, lng: -0.0812 }, { lat: 51.5296, lng: -0.0781 }, MUSEUM_HOME] }],
      facts: [
        { label: "Entry", value: "Free", verdict: "confirmed", source: "OSM", asOf: FETCHED },
        { label: "Sign-up", value: "None listed", verdict: "likely", source: "OSM, no booking tag", asOf: FETCHED },
        { label: "Open Sat", value: "10:00–17:00", verdict: "confirmed", source: "OSM, checked 8 Sep", asOf: FETCHED },
        { label: "Step-free", value: "Yes", verdict: "confirmed", source: "OSM", asOf: FETCHED },
      ],
      why: "Closest, free, and step-free is tagged.",
    },
    {
      id: "victoria-miro",
      kind: "venue",
      name: "Victoria Miro",
      subtitle: "Art gallery · Wharf Road, N1",
      location: VICTORIA_MIRO,
      legs: [{ who: "you", minutes: 18, summary: "Walk, or bus 394 · 15 min", path: [HUB, { lat: 51.5279, lng: -0.0885 }, { lat: 51.5301, lng: -0.0921 }, VICTORIA_MIRO] }],
      facts: [
        { label: "Entry", value: "Free", verdict: "confirmed", source: "OSM", asOf: FETCHED },
        { label: "Open Sat", value: "10:00–18:00", verdict: "likely", source: "OSM", asOf: FETCHED },
        { label: "On show", value: "Not in our sources", verdict: "unknown", source: "—" },
      ],
      why: "Free gallery by the canal basin.",
    },
    {
      id: "broadway-market",
      kind: "event",
      name: "Broadway Market",
      subtitle: "Street market · E8",
      location: BROADWAY_MKT,
      legs: [{ who: "you", minutes: 19, summary: "Bus 394 · or walk 30", path: [HUB, { lat: 51.5296, lng: -0.0781 }, { lat: 51.5331, lng: -0.0702 }, { lat: 51.5352, lng: -0.0655 }, BROADWAY_MKT] }],
      facts: [
        { label: "Open Sat", value: "09:00–17:00", verdict: "likely", source: "OSM", asOf: FETCHED },
        { label: "Entry", value: "Open street, no ticket", verdict: "likely", source: "not tagged" },
        { label: "Step-free", value: "Not tagged", verdict: "unknown", source: "OSM" },
      ],
      why: "Saturday-only market; no ticket needed.",
    },
  ],
  unknowns: ["What's on show at the galleries", "How busy the market will be", "Step-free at Broadway Market"],
  sources: [
    { name: "OSM via Overpass", asOf: FETCHED },
    { name: "Luma seed", asOf: FETCHED },
    { name: "TfL Journey Planner", asOf: FETCHED_LATE },
    { name: "Open-Meteo", asOf: FETCHED_LATE },
  ],
  draftMessage:
    "Saturday plan: Museum of the Home (Kingsland Road E2), free, open 10:00–17:00. Then Victoria Miro (Wharf Road N1) or Broadway Market E8. Fancy it?",
  steps: saturdaySteps,
};

/** Example clarify turn (shown when the fallback can't tell where the other person is). */
export const clarifyFixture: Clarify = {
  question: "Where's Sam coming from?",
  missing: "them_location",
  suggestions: ["Brixton", "Clapham", "Stratford"],
};

export type FixtureId = "meet" | "saturday";
export const FIXTURES: Record<FixtureId, PlanResultWithAgent> = { meet: meetFixture, saturday: saturdayFixture };

/** Pick the closer fixture for a typed ask (fallback only). */
export function pickFixture(query: string): FixtureId {
  return /near me|what'?s on|walk ?in|walk into|registration|sign.?up|saturday|sunday|weekend/i.test(query) ? "saturday" : "meet";
}

/** ?demo=translate: the meet fixture asked in Italian (EXAMPLE DATA, no network). The Italian reply was written for
 * this fixture; live asks translate through /api/translate and name the model that really answered. */
export const translateDemo = {
  display: "Appuntamento giovedì alle 19. Io sono a Old Street, lei è dalle parti di Clapham. Un pub a metà strada, circa 40 sterline in due.",
  lead: { id: "translate", label: "Translated from Italian · gemini-3.5-flash-lite", status: "done", detail: "Italiano → English", source: "gemini-3.5-flash-lite", ms: 520 } as AgentStep,
  translated: { lang: "it", langName: "Italiano", model: "gemini-3.5-flash-lite" },
  reply: "The Blue Maid. A due minuti dalla stazione di Borough e aperto fino a dopo mezzanotte. Tu sei a 24 minuti, l'altra persona a 23. Ho trovato 3 opzioni; questa è la migliore.",
};
