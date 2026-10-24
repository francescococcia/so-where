# So where? — task cards

Each card is 10–20 min and ends with something you can see. ★ = on the demo-critical path. Lanes don't share files, so a coding agent per lane can run in parallel (UI · DATA · DB · DOCS).

**Times:** Saturday is BST (UTC+1). **Clocks go back at 02:00 BST → 01:00 GMT tonight.** Sunday is GMT.
**Sunday gates:** feature freeze **10:30 GMT** · backup video recorded by **11:00** · submitted by **11:40** · hard deadline **12:00**. Pitch final 15:00.

**Design philosophy (from task 1 on):** pocket street atlas — warm paper, ink, one pillar-box red action, canal-blue routes, mono source chips; every fact = value + source + as-of + verdict. Reuse before create.

## Saturday evening (BST)

| ID | Lane | ~Time | Card | Files (reuse / modify / create) | Done when |
|---|---|---|---|---|---|
| U1 ★ | UI | 19:30–19:45 | Tokens + fonts | modify `src/app/globals.css` (paste `design-tokens.css`), `src/app/layout.tsx` (next/font ×3) | Home page renders on paper `#F5F0E6` with Bricolage headings; no Inter left |
| D1 ★ | DATA | 19:30–19:50 | Intent v1 (rules) | modify `src/lib/ask-local.ts`, `src/lib/use-cases.ts`; reuse `src/lib/when.ts` | `parseAsk()` returns `{intent:'halfway'|'nearby', origins[], when, category, walkIn}` for the 4 demo sentences (quick unit check) |
| D2 ★ | DATA | 19:50–20:10 | TfL geocode + rounding | create `src/lib/tfl.ts` (StopPoint search); modify `src/lib/geo.ts` (`roundToArea` ≈500 m) | "Clapham" → lat/lon, rounded; "Old Street" exact; logged with fetch time |
| U2 ★ | UI | 19:45–20:05 | Plan panel shell | modify `src/components/ask-panel.tsx`, `src/app/page.tsx` | Panel over map with 4 chips (Meet halfway, Coffee with a friend, What's on near me, No-registration events); chip click fills an example ask |
| U3 ★ | UI | 20:05–20:25 | Verdict chip + plan card | create `src/components/verdict-chip.tsx`, `src/components/plan-card.tsx`; reuse `ui/card.tsx` | Card renders from a hard-coded fixture labelled "example data", with Confirmed/Likely/Unknown rows |
| D3 ★ | DATA | 20:10–20:30 | Fair point | create `src/data/hubs.json` (~12 central stations); add `fairPoint()` in `src/lib/tfl.ts` | Old Street + Clapham → Borough-area hub with both times from TfL Journey Planner (expect ~24/23 min Thu 18:30) |
| D4 ★ | DATA | 20:30–20:50 | Venues near point | create `src/lib/overpass.ts`; reuse `src/lib/hours.ts`, `src/lib/venue-facts.ts` | Returns 3 open pubs/cafés near the point with OSM id, hours verdict, `fetchedAt`; falls back to `venue-facts.json` on 502/timeout |
| D5 ★ | DATA | 20:50–21:10 | `/api/plan` assemble | create `src/app/api/plan/route.ts` | POST the date ask → JSON with 3 cards, each fact `{value, source, asOf, verdict}` |
| U4 ★ | UI | 21:10–21:30 | Wire panel → API | modify `ask-panel.tsx`; use `plan-card.tsx` | Typing the date ask shows 3 real cards; loading + error states visible |
| U5 ★ | UI | 21:30–21:50 | Map: pins, you, area, routes | modify `src/components/venue-map.tsx` | Numbered red pins, yellow "you" dot, dashed ~500 m area circle, two route lines (TfL leg paths) |
| U6 ★ | UI | 21:50–22:05 | Send plan draft | create `src/components/send-plan.tsx`; reuse `src/lib/links.ts` | Button opens share sheet / WhatsApp link / copy with the plan text; nothing auto-sent; her area not in text |
| D6 | DATA | 22:05–22:20 | Line status + weather | add `lineStatus()` to `src/lib/tfl.ts`; create `src/lib/weather.ts` (Open-Meteo) | Card shows "Northern: Good Service · as of HH:MM" and forecast rain % with "Forecast" chip |
| D7 ★ | DATA | 22:20–22:40 | Nearby + walk-in | create `src/lib/walkin.ts`; modify `src/lib/events.ts` | Saturday ask → seed events within 30 min + OSM `fee=no` places; walk-in = free/no ticket field → Confirmed/Likely, else Unknown |
| U7 ★ | UI | 22:40–22:55 | Saturday view | modify `ask-panel.tsx`, `plan-card.tsx` (compact variant) | Saturday ask shows 3 compact cards with filter row (No sign-up, Within 30 min) |
| P1 | DOCS | 22:55–23:10 | README honesty + sources | modify `README.md` | Sources, attribution (© OSM, TfL, Open-Meteo CC BY 4.0), privacy rules, what's unknown |
| U8 | UI | 23:10–23:25 | Mobile layout | modify `page.tsx`, `ask-panel.tsx` | At 390 px: map on top, panel as bottom sheet, 44 px hit areas |
| P2 ★ | DOCS | 23:25–23:40 | Deploy + smoke test | Vercel (lumap-self.vercel.app) | Both demo asks work on the live URL; note any slow call |
| — | — | 23:40–00:30 | Buffer / fix bugs, then sleep | | Commit + push; write tomorrow's first card |

## Sunday morning (GMT, after clocks go back)

| ID | Lane | ~Time | Card | Files | Done when |
|---|---|---|---|---|---|
| B1 | DB | 07:30–07:50 | Atlas seed | create `src/lib/mongo.ts`, `scripts/seed_atlas.ts` | Events + venues in Atlas with 2dsphere index (needs `MONGODB_URI` in Vercel env) |
| B2 | DB | 07:50–08:10 | `$geoNear` behind flag | modify `src/app/api/plan/route.ts` | `USE_ATLAS=1` returns the same cards via `$geoNear`; JSON fallback still works |
| U9 | UI | 08:10–08:25 | Motion polish | `plan-card.tsx`, `venue-map.tsx` (motion) | Cards stagger in, routes draw in; reduced-motion respected |
| P3 ★ | DOCS | 08:25–08:45 | Pitch + demo script | `knowledge/pitch.md`, `knowledge/plan.md` | 2-scene script timed under 2 min |
| — | — | 08:45–10:30 | Buffer: fix, rehearse, cache demo responses | | Demo runs twice in a row without a hitch |
| **FREEZE** | | **10:30** | No new features | | |
| P4 ★ | DOCS | 10:30–11:00 | Record backup video | | Video file saved (both scenes) |
| P5 ★ | DOCS | 11:00–11:40 | Submit | repo + video link | Submitted, with disclosure (baseline tag `encode-baseline` 5809e2d) |

**If behind:** drop D6, U8, B1–B2, U9 in that order. Never drop the source/as-of/verdict rows.
