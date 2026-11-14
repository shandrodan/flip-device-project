# Cloud rebuild

The Device is a small screen with buttons. Everything that thinks or builds runs on a cloud VM. This folder is the whole story of that rebuild: how it works, how to deploy it, how to test it, and what to do next.

```
 Device (Pi 5-class, 2 GB)                       Cloud VM (8 GB)
 ┌───────────────────────────┐   /ws  /setup     ┌──────────────────────────────────────────┐
 │ kiosk browser (Device UI) │   /preview/       │ server :8787 (agents, voice, state)      │
 │ serve.mjs :5173 ──────────┼──────────────────▶│  ├ OpenCode engine (agent loop)          │
 │   one origin, no logic    │  internal network │  ├ Build project /var/lib/flip/build     │
 └───────────────────────────┘                   │  └ Build dev server 127.0.0.1:53xx       │
                                                 └──────────────┬───────────────────────────┘
                                                                │ PC agent over SSH tunnel / Tailscale
                                                                ▼
                                                       your laptop (files, shell)
```

| Read | When |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How a spoken request becomes work, where each piece runs, memory budget, safety. |
| [DEPLOY-GCP.md](DEPLOY-GCP.md) | Plug and play on Google Cloud: one command, then tunnels. |
| [TESTING.md](TESTING.md) | Every test layer, how to run it, how to read a failure. |
| [AGENT-TOOLS.md](AGENT-TOOLS.md) | Every tool agents have, how risk works, how to add an app. |
| [ROADMAP.md](ROADMAP.md) | What to build next, in order, with acceptance checks. |
| [OVERNIGHT-BRIEF.md](OVERNIGHT-BRIEF.md) | Hand this to an agent for an unattended night of work. |

Decisions: [ADR 0032](../adr/0032-opencode-agent-engine-and-typed-app-tools.md) (engine, typed tools), [ADR 0033](../adr/0033-cloud-vm-and-build-on-the-server.md) (cloud VM, Build on the server).

## Status on 2026-11-14

Verified in this repo, with real models through OpenRouter:

| Check | Result |
| --- | --- |
| `pnpm test:agents`: 9 multi-step scenarios (Notes, To-Do, memory, chains, cross-app, PC files, Build static, Build edit, Vite + React) | 18/18 over 2 full runs on DeepSeek V4.1 Flash, the default. Requests took 5–90 s: OpenRouter latency varies by provider |
| Same suite, earlier scenarios, on DeepSeek V4 Flash and Claude Haiku 5.5 | Passing |
| `cloud-vm/sim/run.sh`: 8 GB cloud box + 2 GB device box in Docker, smoke test through the device box with a real browser | Passing. Cloud 740 MB with a Vite dev server; device box 18 MB (no kiosk browser in the box) |
| `pnpm test:e2e` (the demo flow, scripted model) | Passing, 23 checks |
| `pnpm -r typecheck` | Passing |
| Device UI and Protocol | Unchanged |
| Real GCP deploy (`cloud-vm/up.sh`) | Written, not run: no `gcloud` in the build session. First thing to try. |

Model: `deepseek/deepseek-v4.1-flash` ($0.05 in / $0.20 out per million tokens). If it disappoints on real use, `OPENROUTER_MODEL=anthropic/claude-haiku-5.5` ($0.10 / $0.50).

## Overnight 2026-11-15

Roadmap items built in the night run (see [REPORT-2026-11-15.md](REPORT-2026-11-15.md)). The first three passed their `agent-e2e.ts` scenario 3 runs in a row on DeepSeek V4.1 Flash. Then the night's OpenRouter key reached its $0.40 cap, so later items are proven with `test:tools` (the real engine with a scripted model, 3/3) and their agent scenarios are written but not yet run on a model.

| Item | Status | Proof |
| --- | --- | --- |
| P0.3 Engine health and restart | Done | `engine-restart`: OpenCode killed between requests, the next request works. `/health` reports `engine` and `engineRestarts` |
| P1.4 `build_screenshot` | Done | `build-look`: "make the button bigger and centred", button measured before and after in a sandboxed frame, screenshot in the Task steps |
| P1.5 Undo by voice | Done | `build-undo`: "change the title to Lemon Lab", then "undo that"; `index.html` is byte-for-byte what it was, and the history has the undo |
| P1.7 Errors come back by themselves | Done, model run pending | `test:tools` `errors-static`, `errors-vite` 3/3 through the real engine. Agent scenario `build-errors` written; not run, the OpenRouter key hit its cap |
