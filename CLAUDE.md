# lfiq-llm

The LFIQ AI router. Read README.md first.

- Never add an OCP provider, setting or fallback. LFIQ apps never use OCP (decided 2026-10-07). `test/llm.test.mjs` fails if OCP shows up in the source.
- Keep it free of runtime dependencies: fetch for Anthropic, the Worker `AI` binding for Workers AI.
- Commit `dist/` with every source change (`npm run build`). CI fails if `dist/` is stale.
- Built-in `ROUTES` must match the `lfiq` rows seeded in brick.command `backend/database/migrations/227_ai_control_panel.sql`.
- Plan: https://claude.ai/code/artifact/ffb781bd-0b64-4903-b668-bdf1c1a284dc (AI Model Usage Plan, phase 3).
