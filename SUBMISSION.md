# So where? · submission text

**Live demo:** https://so-where.vercel.app
**Repo:** ⟨repo URL⟩
**Video:** ⟨video URL⟩

## Tagline

The fair place to meet in London: open, on time, checked, and nothing sent without you.

## Description (150 words)

"Where shall we meet?" takes a dozen messages in London. So where? lets you say it once, by voice, text or photo, in any language. It compares real TfL journey times to find the fairest middle, then finds places there that are open at your time and suit the weather and your vibe. Gemini 4 Argon picks from checked places; deterministic rules re-check its pick, Argon re-picks if it fails, and you see the checks on screen. MongoDB Atlas powers venue search, a vector-plus-text vibe match, and live Tube status streamed every minute. Snap a sign or landmark: faces are blurred on your device, and the app tells you how sure it is. Every fact has a source, and anything it couldn't check is listed. Your friend's location is rounded and never stored. Plans are drafts that you send yourself.

## Tracks / bounties

- **Pathway 2: Google (Gemini)**
- **MongoDB**
- Real World: a working live demo, a public repo with setup steps (README), a video on real inputs (live voice, a real photo, live TfL), and the models and data sources below

## How we used Gemini

**gemini-4-argon** is the planner. It chooses venues from a pool that has already been checked, and explains each trade-off in one line. Deterministic checks then re-test its pick against opening hours, TfL journeys, rain and step-free access. Failures go back to Argon for one re-pick, and that loop is shown on screen. Argon also powers vision: it reads signs, landmarks and posters, gives vibe tags for what is visible only, and reports an honest high/medium/low certainty. **gemini-3.8-live** handles voice and **gemini-3.5-live-translate-preview** handles speech in any language. **gemini-3.5-flash-lite** translates text, and **gemini-3.8-flash-tts** speaks the plan card. **gemini-embedding-001** is the fallback for vibe vectors.

## Agents

1. **Planner agent** (gemini-4-argon). It gathers with tools (TfL StopPoint and Journey Planner, MongoDB Atlas Search and hybrid vibe search, Atlas `line_status`, Open-Meteo weather), picks from the checked pool, gets verified by deterministic rules, and re-picks once if the pick fails. If Argon is too slow, gemini-3-flash-preview picks and the step says so. Each step streams to the "How we got here" panel.
2. **Live voice agent** (gemini-3.8-live). Real-time conversation in the user's language. It acts only through six tools: `plan`, `refine`, `focus`, `isOpen`, `leaveBy` and `draftMessage`. `draftMessage` opens a draft; nothing is ever sent for you.
3. **Translate agent** (gemini-3.5-live-translate-preview for speech, gemini-3.5-flash-lite for text). It turns any language into the English ask and translates the answer back; gemini-3.8-flash-tts speaks it.

**How it was built:** Francesco built the Encode features with AI coding agents (Grok Bot and Cursor-style agents), reviewing, testing and merging each change himself.

## How we used MongoDB Atlas

We use six Atlas features, all visible in the app's "How we got here" steps:

1. **Atlas Search** (geo + fuzzy text) finds venues near the fair middle among 7,225 OSM venues, and matches photographed signs.
2. **Vector Search** finds places by meaning.
3. **Hybrid `$rankFusion`** fuses vector and text results for vibe asks like "cosy quiet pub".
4. **Automated Embedding** has Atlas embed venues and queries itself…
5. …with **Voyage AI voyage-4**.
6. **Atlas Stream Processing** (`tfl_line_status`) pulls TfL line status every 60 s into `line_status`. The planner pads journeys on disrupted lines.

An aggregation over anonymised `plan_runs` (no text, no coordinates) powers `/api/stats`.

## Data sources

- **TfL Unified API:** stations, StopPoint, Journey Planner, line status (Powered by TfL Open Data).
- **OpenStreetMap:** 7,225 London venues from a 24 Oct snapshot, stored in Atlas; live Overpass as a fallback. Map tiles from OpenFreeMap. © OpenStreetMap contributors.
- **Open-Meteo:** the forecast for the plan time (CC BY 4.0).
- **Wikidata, then Nominatim:** landmark names to points; Wikipedia for "Why here".
- **Luma:** events.

No ratings, busyness or prices are invented. Anything no source covers is listed under "Couldn't check".

## Disclosure

The base map and chat existed before Encode kickoff; features listed as Encode-built were made during the hackathon.
