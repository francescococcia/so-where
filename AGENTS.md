# Agent instructions

Event: **Encode London Hackathon 2026**. Product: **Lumap Near Me**, a "what's happening near me" explorer. Before planning or writing code, read:
- `knowledge/plan.md`: problem, user, assistant rules, data sources, actions, MVP, build order (cards N1–N8, M1, D1), risks, open decisions
- `knowledge/pitch.md`: 30-second pitch and 3-minute demo script
- `knowledge/event.md`: schedule, checkpoints, judges

## Deadlines (Sunday times are GMT; clocks go back at 02:00 Sun)
- Feature freeze **Sun 10:30** · video by 11:30 · submit **Sun 12:00** (no late entries)
- After the freeze: only fixes to the demo path.

## Build rules
- Optimise for a working, reliable 3-minute live demo on real London inputs (Encode Hub, Shoreditch/Old Street). Cut anything not in `pitch.md`.
- Encode features must be new code written after Fri 23 Oct 17:00 BST. Don't present pre-Encode code as Encode work.
- Keep the existing app (venues, Luma events, map, Ask) as one layer of the neighbourhood view; don't rewrite it.
- Every data source: cache the demo point, return `{source, fetched_at, ok}`, show attribution. On failure retry once, then use the cache labelled "cached".
- Assistant honesty: every fact has a source and freshness; missing data is said plainly; low confidence means "not sure". Never invent step-free status, times, prices or addresses.
- Actions that publish (Luma event, OSM note, any upload) need an explicit human Approve click and an action-log entry. Read-only tool calls don't.
- Privacy: read EXIF GPS in the browser, then strip all EXIF; blur faces (and plates) before anything is published; don't store raw photos or user locations.
- Keep commits small and descriptive, with the card id (e.g. `N1: near briefing`).
- Never commit secrets. Keys go in `.env` (gitignored); document new vars in `.env.example`.

## Gemini API (when a card uses Gemini)
- SDK: `@google/genai@latest` (or `google-genai>=2.3.0` in Python). Use the Interactions API, `client.interactions.create`.
- `gemini-4-argon`: use `thinking_level`, not `thinking_budget`; no `temperature`, `top_p`, `top_k` or explicit `cached_content`; use `background=True` beyond 65,536 tokens.
- Companion models allowed, e.g. `gemini-3.8-flash` for fast reads.
- Skills: `npx skills add google-gemini/gemini-skills --skill gemini-api-dev`.
- Key: `GEMINI_API_KEY` in `.env`, server routes only.

## UI rules (Francesco)
- Light theme only. No dark colours or dark mode. Match `docs/lumap-mockup.jpg` (off-white #FAFAF7, white cards, violet #7C5CFF accent, mint/amber pin states).
- Build UI from component libraries: shadcn/ui as the base, Magic UI or Aceternity UI for showy pieces, Framer Motion (`motion`) for animation, lucide-react for icons. Don't hand-roll components that a library already provides.
- Do not write or run tests. Verify by looking at the running app.

## Working in small chunks (every agent: Cursor, Codex, others)
- The build queue is the build order table in `knowledge/plan.md` §10. Do ONLY the card id you were given (or the first unticked one).
- Don't start the next card, refactor unrelated code, or expand scope. If a card looks bigger than its timebox, split it and do only the first part.
- 15-min debug cap per bug, then use the card's fallback.
- When done: tick the card, commit with the card id, then stop and report in 3 lines.
