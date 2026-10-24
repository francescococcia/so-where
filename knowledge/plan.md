# So where? — plan (start easy, iterate)

**One line:** Ask in plain English where to meet or what to do in London. You get three honest options on a map: who travels how long, what's confirmed, what's unknown, and a plan you send yourself.

## Use cases (all equal)
1. **Meet halfway** — "Date Thursday at 7, I'm at Old Street, she's around Clapham, pub, about £40 for two."
2. **Coffee with a friend** — "Coffee with Sam tomorrow morning, I'm at King's Cross, he's in Brixton."
3. **What's on near me** — "It's Saturday, what's on near me?"
4. **Walk-in events** — "What can I just walk into, no registration?" → suggests the place and how to get there.

## Rules (don't break these)
- Every fact shows its source and "as of" time, plus a verdict: Confirmed / Likely / Unknown.
- Unknowns are shown, not hidden (price, how busy, step-free if not tagged).
- Nothing is sent automatically. "Send plan" opens a draft the user sends.
- The other person's location is rounded to an area (~500 m) and never stored.
- No invented data. Anything placeholder is labelled "example data".

## v1 — smallest demoable slice (tonight)
1. **Typed ask → intent.** Rules first (extend `src/lib/ask-local.ts`); Gemini Flash is optional on top. Two intents only: `halfway` (two origins) and `nearby` (one origin, plus a `walkIn` flag).
2. **Where.** `halfway`: geocode both stations with TfL StopPoint, then pick the fairest of ~12 central hub stations using TfL Journey Planner times (lowest worst-case, then smallest gap). `nearby`: use the user's location or a typed station.
3. **What.** `halfway`: OSM venues (pub/cafe) near the fair point via Overpass, open at that time (`src/lib/hours.ts`). `nearby`: the Luma seed (`seed/events-all.json`) within 30 min, plus OSM free-entry places (museum, gallery, market with `fee=no`). Walk-in = free or no ticket/registration fields in the seed, otherwise **Unknown**.
4. **Three cards.** Each has travel times, open hours, line status now and weather forecast, each with source, as-of and verdict.
5. **Map + send.** Pins, the "you" dot, the rounded "their area" circle, route lines; a "Send plan" button that builds a text draft (share sheet / WhatsApp link / copy).

## v2 (Sunday morning, only if v1 is solid)
- MongoDB Atlas: events + venues in one collection with a 2dsphere index; `$geoNear` in `/api/plan` behind a flag, falling back to JSON. (MongoDB bounty.)
- Proper "No registration" filter chip with counts.
- Live line status on each route leg; weather on each card.

## v3 (after the hackathon)
Atlas Search for free-text ("quiet", "garden"), voice input, photo → OSM note, "create a Luma event" link, saved plans.

## Out tonight
Accounts, storing anyone's location, auto-sending messages, booking or payments, Luma API (needs Luma Plus), price data (none of our sources has it), dark mode, Supabase changes.

## Demo script (2 scenes, ~90 s)
1. **Meet halfway (~50 s).** Type the date ask. The map draws both routes to Borough (24 vs 23 min). Card: The Blue Maid — open till midnight (Likely, OSM), Northern line good now (Confirmed), price Unknown. Tap "Send plan" → draft opens; point out her area isn't in it.
2. **It's Saturday (~40 s).** Type "It's Saturday, what's on near me that I can just walk into?" Three walk-in places within 20 min, free entry Confirmed, sign-up Likely none, show Unknown. Tap Directions.

## Where it lands in the repo
| Piece | Files |
|---|---|
| Theme + fonts | `src/app/globals.css` (paste `design-tokens.css`), `src/app/layout.tsx` |
| Plan panel | `src/components/ask-panel.tsx` (reuse), `src/app/page.tsx` |
| Result card + verdict chip | new `src/components/plan-card.tsx`, `src/components/verdict-chip.tsx`; reuse `ui/card.tsx`, `ui/button.tsx` |
| Map | `src/components/venue-map.tsx` (MapLibre, add route + area layers) |
| Intent | `src/lib/ask-local.ts`, `src/lib/use-cases.ts`, `src/lib/when.ts`, `src/app/api/ask/route.ts` |
| TfL, geo, weather | new `src/lib/tfl.ts`, `src/lib/weather.ts`; reuse `src/lib/geo.ts`, `src/lib/areas.ts` |
| Venues | new `src/lib/overpass.ts`; reuse `src/lib/hours.ts`, `src/lib/venue-facts.ts`, `src/data/venue-facts.json` |
| Events + walk-in | `src/lib/events.ts`, new `src/lib/walkin.ts`, `seed/events-all.json` |
| Assemble | new `src/app/api/plan/route.ts` |
| Send plan | new `src/components/send-plan.tsx`, reuse `src/lib/links.ts` |
| Atlas (v2) | new `src/lib/mongo.ts`, new `scripts/seed_atlas.ts` |
| Docs | `README.md`, `knowledge/plan.md`, `knowledge/pitch.md` |

## Decisions (Sat 24 Oct)
- 19:05 BST: name is **So where?** (no "by Lumap" line). Repo stays `lumap`. Current palette is a starting point only: Francesco finds it "too AI and static", so the UI lane redoes the art direction with the `design-taste-frontend` (taste-skill) and `ui-ux-pro-max` skills, and adds motion.
- Build runs as parallel lanes on separate branches: UI lane and DATA lane. They meet at the `PlanResult` contract in `src/lib/plan-types.ts` (DATA lane owns it).
