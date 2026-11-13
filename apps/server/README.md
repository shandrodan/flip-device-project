# apps/server

Node + TypeScript. WebSocket server speaking `@app/protocol` at `/ws`, setup page at `/setup`.

- `src/notes.ts`: dumps become notes instantly, then transcription and suggestions (ADR 0005, 0009).
- `src/suggest.ts`: Claude structured output, or a rule-based splitter without a key.
- `src/agents/`: task agents. `runner.ts` (Claude tool-use loop), `planner.ts` (no-key plans), `tools.ts` (every action and its risk).
- `src/approvals.ts`: approval requests; "Not now" holds a task until resumed (ADR 0004).
- `src/machines.ts`: links to PC agents over Tailscale, with retries; paused tasks resume when a machine returns (ADR 0006).
- `src/index.ts`: the hub, focus timer, Claude limit window, settings.
- State lives in `data/state.json`; keys pasted on `/setup` in `data/secrets.json` (mode 600). Both gitignored.

`pnpm test:e2e` runs the demo flow end to end against a real PC agent in a throwaway home folder.
