# AGENTS.md: instructions for coding agents

## Context
- This repo is for **Encode London Hackathon 2026** (Encode Hub, London, 23–25 Oct 2026). The builder is Francesco Coccia.
- The project is **TBD**. Candidate challenges: Gemini 4 Argon (Google DeepMind), MongoDB Atlas, Saint, The Real World, Agents That Ship.
- **`README.md` is the source of truth** for rules, judging criteria, submission requirements and deadlines. Read it before you start. Don't invent event facts; anything unconfirmed is marked TBC.
- Francesco switches tasks a lot. Keep updates short: what you did, what's next, and what's blocked on him.

## Hard rules
1. **Only code written during the hackathon may be shown in the demo.** Open-source libraries and starter templates are fine, but don't paste in pre-existing project code.
2. **Human in the loop:** any action that affects external systems, money, private data, sending messages or submitting forms must stop and ask for human approval. Log every action the agent takes, as judges want a clear record.
3. **Secrets:** never commit keys. Use `.env` (ignored) and keep `.env.example` updated with key names only.

## Gemini 4 Argon API rules
- SDKs: Python `pip install -U "google-genai>=2.3.0"`; JS/TS `npm install @google/genai@latest`.
- Use the **Interactions API**: `client.interactions.create` (covers models and managed agents, server-side state, long background runs).
- Use `thinking_level` (`"low"` | `"medium"` (default) | `"high"`). **Never** use `thinking_budget` (deprecated).
- **Don't set** `temperature`, `top_p`, `top_k` or explicit `cached_content`. Implicit caching is automatic.
- Set `background=True` to generate beyond **65,536 tokens** (up to 1M).
- Model IDs: `gemini-4-argon` (lead), `antigravity-preview-09-2026` (sandbox agent), `gemini-3.8-flash` / `gemini-3.5-flash-lite` (subagents), `deep-research-preview-04-2026`, `gemini-3.8-live*`, `gemini-3.5-transcribe-live`, `gemini-3.5-live-translate-preview`, `gemini-3.8-flash-tts`, `gemini-nano-banana-2.1`, `gemini-omni-1.1-flash`, `lyria-3.5`, `gemma-4-31b-it`. Full table in README §2.
- Install the Gemini skills before writing Gemini code:
  ```bash
  npx skills add google-gemini/gemini-skills --skill gemini-api-dev
  npx skills add google-gemini/gemini-skills --skill gemini-live-api-dev
  # Antigravity: agy plugin install https://github.com/google-gemini/gemini-skills
  ```

## How to work
- **Verification loops:** every agent feature needs a concrete pass/fail signal (tests, compiler output, runtime logs, headless browser checks). Run it before saying a task is done. (This is worth 50% of the Gemini score.)
- **Demo first:** keep a demo runnable from a fresh clone in **under 3 minutes**, with real inputs. Don't break the demo path. If an extra (voice, video, 3D) isn't working within about 20–30 min, add a fallback and move on.
- **Commit often:** small commits with clear messages, then push. Unpushed work doesn't exist.
- **Keep README setup instructions updated** (README §10) whenever dependencies, env vars or run commands change.
- **Record models and agents used** (and data sources, tools and approval points) in README §10 as you go. The submission notes need them.
- MongoDB: if Atlas is used, make it core to the app and list each Atlas feature used (more features = more points).
- Privacy: blur or avoid faces, number plates and personal locations. Show model uncertainty honestly.
- One task at a time: finish, verify, commit, write a one-line note for the next agent, stop.
