# apps/server

Node + TypeScript. WebSocket server speaking `@app/protocol` at `/ws`, setup page at `/setup`.

- `src/notes.ts`: dumps become notes instantly, then transcription and suggestions (ADR 0005, 0009).
- `src/suggest.ts`: Structured output from the configured model, or a rule-based splitter without a key.
- `src/agents/`: task agents. `runner.ts` (model tool-use loop), `planner.ts` (no-key plans), `tools.ts` (every action and its risk).
- `src/approvals.ts`: approval requests; "Not now" holds a task until resumed (ADR 0004).
- `src/machines.ts`: links to PC agents over Tailscale, with retries; paused tasks resume when a machine returns (ADR 0006).
- `src/index.ts`: the hub, focus timer, Claude limit window, settings.
- State lives in `data/state.json`; keys pasted on `/setup` in `data/secrets.json` (mode 600). Both gitignored.

Open `/setup` and enter an OpenRouter key, or set `OPENROUTER_API_KEY` on the server. The key enables Nemotron 3.5 Super VL (free) for agents and Whisper Large V3 Turbo for transcription. `OPENROUTER_MODEL` can select a different model such as `google/gemma-4-31b-it:free`. OpenRouter bills Whisper usage separately. Only the key suffix is shown on the Device.

`pnpm test:e2e` runs the demo flow end to end against a real PC agent in a throwaway home folder.
