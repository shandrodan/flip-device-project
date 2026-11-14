# apps/server

Node + TypeScript. WebSocket server speaking `@app/protocol` at `/ws`, setup page at `/setup`.

- `src/notes.ts`: dumps become notes instantly, then transcription and suggestions (ADR 0005, 0009).
- `src/suggest.ts`: Structured output from the configured model, or a rule-based splitter without a key.
- `src/agents/`: Task agents. `engine.ts` runs them in OpenCode (ADR 0032); `runner.ts` starts Tasks, builds the prompt, and keeps the built-in loop as a fallback. `tools.ts` defines actions and risks; `app-tools.ts` holds the typed app tools (`APP_MANIFEST`). `planner.ts` supports scripted rehearsals when `DEMO_PLANNER=1`.
- `engine-plugin/flip.ts`: runs inside OpenCode and forwards each Flip tool call back to the server.
- `src/approvals.ts`: approval requests; "Not now" holds a task until resumed (ADR 0004).
- `src/machines.ts`: links to PC agents over Tailscale, with retries; paused tasks resume when a machine returns (ADR 0006).
- `src/index.ts`: the hub, focus timer, Claude limit window, settings.
- State lives in `data/state.json`; keys pasted on `/setup` in `data/secrets.json` (mode 600). Both gitignored.

Open `/setup` and enter an OpenRouter key, or set `OPENROUTER_API_KEY` on the server. The key enables Nemotron 3.5 Super VL (free) for agents and Whisper Large V3 Turbo for transcription. `OPENROUTER_MODEL` can select a different model such as `google/gemma-4-31b-it:free`. OpenRouter bills Whisper usage separately. Only the key suffix is shown on the Device.

`pnpm test:e2e` runs the demo flow end to end against a real PC agent in a throwaway home folder.

`pnpm test:agents` speaks multi-step requests to real agents with a real model and checks the end state: six Notes then delete 1, 3 and 5, a follow-up that relies on memory, To-Dos with projects and dates, a date chain, cross-app work, and files on the PC agent. It needs `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY`). `MODEL=openrouter/anthropic/claude-haiku-5.5` picks the model, `ONLY=notes,files` picks scenarios, `AGENT_ENGINE=builtin` tests the old loop, `STEPS=1` prints every step.

### Agent engine (ADR 0032)

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENT_ENGINE` | `opencode` | `builtin` uses the old loop in `runner.ts`. |
| `ENGINE_MODEL` | the saved key's model | `provider/model`, e.g. `openrouter/anthropic/claude-haiku-5.5`, `anthropic/claude-opus-5-5`, `ollama/qwen3`. |
| `ENGINE_CONFIG` | none | JSON merged into the OpenCode config, e.g. a local model: `{"provider":{"ollama":{"npm":"@ai-sdk/openai-compatible","options":{"baseURL":"http://localhost:11434/v1"},"models":{"qwen3":{}}}}}` |
| `ENGINE_STEPS` | `40` | Most model steps per turn. |
| `ENGINE_VERBOSE` | off | Prints OpenCode's output. |

### Build on the server (ADR 0033)

| Variable | Default | What it does |
| --- | --- | --- |
| `BUILD_HOST` | `pc` | `server` keeps the Build project on this machine: OpenCode's coding tools work in it, `build_serve` runs its dev server, `/preview/` streams it. |
| `BUILD_DIR` | `~/Flip/build` | The project folder (on the server with `BUILD_HOST=server`). |

`src/build-host.ts` runs commands and the dev server; `src/build-preview.ts` serves `/preview/`.
