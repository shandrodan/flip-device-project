# Architecture

## The two machines

| | Device | Cloud VM |
| --- | --- | --- |
| Hardware | Pi 5-class: 4 arm64 cores, 2 GB, no swap (`pi-vm/`) | `e2-standard-2`: 2 vCPU, 8 GB, x86 (`cloud-vm/`) |
| Runs | Kiosk Chromium showing `apps/device`, `docker/serve.mjs`, screen relay, mic | `apps/server` with OpenCode, the Build project and its dev server |
| Talks to | Only its own `serve.mjs`, which passes `/ws`, `/setup`, `/health`, `/preview/` to the cloud | The Device (internal network, port 8787), model providers, your laptop's PC agent |
| Holds state | Nothing that matters | `/var/lib/flip/data` (state, keys, agent sessions), `/var/lib/flip/build` (the Build project) |

The Device never talks to the internet. The cloud VM has no public ports: the Device reaches it on the VPC (firewall rule `flip-device-to-cloud`, tag to tag), and you reach it over SSH.

## A spoken request, end to end

1. You hold the mic on the Device. The audio goes over `/ws` to the cloud and is transcribed there.
2. The server picks the agent: Omni from Home, the app's agent inside an app (ADR 0014, 0030).
3. `runner.ts` makes a Task and builds the agent's brief: role, permission mode, machines, the Build brief when it serves Build.
4. `engine.ts` sends the brief and the request to **OpenCode** (`opencode serve`, one process, all agents). Each agent has one OpenCode session per app, so it remembers its own earlier tool calls and results.
5. OpenCode runs the loop: it plans with `todowrite`, calls tools, reads results, retries, and compacts long sessions.
   If OpenCode exits on its own, the server starts it again once (a second exit within 5 minutes waits for the next request). `/health` shows `engine: "opencode" | "builtin" | "starting" | "failed"` and `engineRestarts`. A Task running when the engine dies ends with "say it again"; it is never rerun on the built-in loop, because its work may be half done.
6. A Flip tool call goes from the plugin (`apps/server/engine-plugin/flip.ts`, running inside OpenCode) back to the server at `/engine/call`, with the OpenCode session ID. The server finds the Task and runs the tool with that Task's context.
7. Every tool passes `ctx.gate`. Risky actions (send, delete, leave) wait for the **approval press** on the Device. Grey-zone actions ask in Auto when the model sets `ask_first`. Manual asks for everything.
8. App work forwards to the app's assigned agent when the caller doesn't own the app (ADR 0027). That is a typed operation, not another model turn.
9. Steps show on the Device as they happen (each tool's `say` line). The final answer goes to the Device's screen.

## The Build app on the cloud (ADR 0033)

```
Build Task ──▶ OpenCode (directory = /var/lib/flip/build)
                 read / grep / glob / edit / write / bash ──before each call──▶ server gate ──▶ approval press?
                 build_serve "npx vite --port 5300 --base /preview/" ──▶ dev server on 127.0.0.1:5300
Device iframe ──▶ serve.mjs /preview/ ──▶ server /preview/ ──▶ 127.0.0.1:5300/preview/  (HTTP and HMR WebSocket)
```

- A Build Task gets OpenCode's own coding tools, scoped to the project folder. `external_directory` is denied, and the server re-checks every path.
- `bash` always takes a press in Manual and Auto. Edits take one only in Manual.
- No dev server: `/preview/` serves the project's files, so plain HTML/CSS/JS needs nothing else.
- Dev server: started with `build_serve`, must use base path `/preview/`. The server streams it, hot reload included. It restarts with the server.
- The Device's frame is sandboxed with an opaque origin, so the preview answers with `access-control-allow-origin: *`.

## Memory budget

| Process | Measured |
| --- | --- |
| OpenCode, idle | ~240 MB |
| Whole cloud side with a Vite dev server running (simulation) | ~740 MB of 8 GB |
| `serve.mjs` on the Device | ~18 MB |
| Kiosk Chromium on the Device | see the Pi VM's monitor (`pi-vm/relay.mjs`) |

`flip-server.service` has `MemoryMax=8G`, which covers the server, OpenCode, npm installs and the dev server together.

## Models

- Agents: the engine uses `ENGINE_MODEL`, else OpenRouter's `OPENROUTER_MODEL` (default `deepseek/deepseek-v4.1-flash`), else Anthropic's `AGENT_MODEL`.
- Other model calls (intent, routing, suggestions, transcription) use the same key directly, not the engine.
- Any OpenCode provider works through `ENGINE_CONFIG`, including a local model server.

## What makes the agents reliable

These came out of real failures and are tested:

1. **Typed tools with required fields.** One tool with 13 actions made a cheap model drop or swap fields. Small tools fixed it (ADR 0032).
2. **Batches.** `notes_create {texts[]}`, `todo_create {items[]}`, `ids[]` everywhere: one call, one approval, one forward.
3. **Errors that say how to fix the call.** "notes_replace needs the new full text in text."
4. **A repeat guard.** The same failing call three times gets a nudge, six times ends the Task.
5. **Session memory.** Follow-ups ("rename the ones you kept") work because the agent sees what it did.
6. **Verify by reading.** The agent prompt asks to read state again after changes.

## Safety boundaries

- Risk is fixed per tool, never chosen by the model (ADR 0008). The gate runs on the server, after the model, for every call.
- OpenCode's own tools are off except in Build Tasks, and there only inside the project folder.
- The engine listens on 127.0.0.1. Plugin calls carry a per-start token and must come from localhost.
- Keys live in `/var/lib/flip/data/secrets.json` (mode 600) or `.env` on the cloud VM, never on the Device.
- Not a sandbox: an approved Build command runs as the `flip` user on the cloud VM. Keep that VM single-purpose.
