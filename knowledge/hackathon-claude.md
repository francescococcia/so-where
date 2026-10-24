# CLAUDE.md

Read **AGENTS.md** (how to work) and **README.md** (event facts, challenge rules, submission checklist: the source of truth) before doing anything.

Critical rules:
- The demo may only show code written during the hackathon.
- Gemini: `google-genai>=2.3.0` / `@google/genai@latest`, `client.interactions.create`, `thinking_level` (not `thinking_budget`), no `temperature`/`top_p`/`top_k`/explicit `cached_content`, `background=True` beyond 65,536 tokens.
- Ask a human before any risky action (external systems, money, private data, sending or submitting). Log what the agent did.
- Verify with a real pass/fail signal before calling something done.
- Keep the demo runnable in under 3 minutes. Commit and push often. Keep README setup and the models-used notes current.
- Never commit secrets.
