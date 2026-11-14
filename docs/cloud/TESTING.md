# Testing

Five layers, cheapest first. Run the first three before every commit. All commands from the repo root unless shown.

| Layer | Command | Model calls | Time | Proves |
| --- | --- | --- | --- | --- |
| 1. Types | `pnpm -r typecheck` | none | 20 s | Everything compiles |
| 2. Demo flow | `pnpm test:e2e` | none (scripted) | 1–2 min | The demo, approvals, restarts, app ownership, the built-in loop |
| 2b. Tools on the engine | `pnpm --filter server test:tools` | none (scripted) | 30 s | Every tool through the real OpenCode, plugin, gate and server, with a scripted model: results, images, approvals, end state |
| 3. Agents | `pnpm --filter server test:agents` | real | 3–5 min | Agents do multi-step work right, on the engine |
| 4. Cloud simulation | `cloud-vm/sim/run.sh` | real | 5–10 min first, 2 min after | The 8 GB + 2 GB topology, the real UI, Build through the Device |
| 5. Real VMs | `DEVICE=http://localhost:15173 node cloud-vm/sim/smoke.mjs` | real | 2 min | The deployed system |

Layers 3–5 need `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY`) in the environment.

## 2. Demo flow (`apps/server/scripts/e2e.ts`)

Spawns a real server and a real PC agent in a throwaway home folder and drives the Protocol like the Device. Uses `DEMO_PLANNER=1` and a scripted mock model, pinned to `AGENT_ENGINE=builtin`, so it is deterministic and free. It covers the old loop's behavior and every server rule (approvals, "Not now", offline machines, queues, restarts, app ownership, spoken commands). `RUNS=20` repeats the flow.

## 2b. Tools on the engine (`apps/server/scripts/tools-e2e.ts`)

A scripted model stands in for OpenRouter: an OpenAI-compatible server that answers each engine request with the next tool call of the scenario. Everything else is real: OpenCode, the plugin, `ctx.gate`, approvals, the server's tools, the Build project, the preview, Chromium. It records what each tool returned to the model (and whether an image came with it), so a scenario checks both the end state and what the model would have read. Free and deterministic: run it before every commit that touches a tool, and in CI.

| Scenario | Proves |
| --- | --- |
| engine | `/health` reports `engine: "opencode"` |
| screenshot | `build_screenshot` returns the size, the element list and a PNG that reaches the model (as an "Attached media" user message after the tool result) |
| undo | a Build Task is committed with the request as message; `build_history` lists it; `build_undo` restores `index.html` exactly |
| errors-static | a broken edit's result carries the page error; the fixed edit says clean; the preview reloads after each edit |
| starter | `build_new vite-react`: React renders "Lemon Stand" in the sandboxed preview in under 30 s (12 s here), committed as a new project |
| notes-search | 150 Notes: `notes_search "venue"` returns exactly the 10 venue Notes, they are deleted, under 8 steps |
| todo-filters | `todo_read` with each filter and with `projectId` returns exactly the right To-Dos |
| errors-vite | with a Vite dev server: a syntax error in `src/main.js` comes back in the edit result |

`SHOW=1` prints every tool result, `DUMP=1` every request's last messages, `KEEP=1` keeps the temp folder. `errors-vite` runs `npm install` (network).

Writing a scenario: `run(target, request, steps)` with steps `{ tool, args }` and a final `{ text }`. OpenCode's own `write`/`edit` take absolute paths (`path.join(buildDir, …)`).

## 3. Agents (`apps/server/scripts/agent-e2e.ts`)

Speaks real requests to real agents, presses every approval like a user, and checks the **end state** (Notes, To-Dos, files on disk, the preview), never the agent's words.

| Scenario | Request (abridged) | Checks |
| --- | --- | --- |
| notes | Omni: create Note 1–6, delete 1, 3, 5 | exactly 2, 4, 6 left |
| memory | Omni: rename the ones you kept to Alpha, Beta, Gamma | follow-up resolves "the ones you kept" |
| todo | To-Do agent: add 5, two into Pitch deck due tomorrow, complete one, delete one | each field |
| chain | Omni: push everything due tomorrow by a day, write a note listing them | dates moved, note written |
| cross-app | Omni: a Home to-do for every note, then delete all notes | both apps |
| files | PC agent: make a–e.txt in ~/Flip/letters, delete b and d | files on disk |
| engine-restart | OpenCode is killed, then Omni: write a note | the note exists, `/health` says `engine: "opencode"` and `engineRestarts ≥ 1` |
| build-static | Build: one-page site "Flip Lemonade" with a click counter | `/preview/` serves it |
| build-edit | Build: green button, add a tagline | edit in place, memory |
| build-look | Build: make the button bigger and centred | button area +15 % or more and centred, measured in a sandboxed 568×504 frame; no page errors; a screenshot step in the Task |
| build-undo | Build: change the title, then "undo that" | `index.html` identical to before, an "Undo" commit in the project's git log |
| build-errors | Build: put a syntax error in the main component on purpose, then fix it | an edit result reported the error, the agent never called `build_logs`, the component compiles |
| build-starter | Build: start a new React app called Lemon Stand | react in package.json, Vite client through `/preview/`, under 60 s |
| notes-search | (runs last; restarts the server with 150 Notes on disk) Omni: delete the notes about the venue | the 10 venue Notes gone, 140 left, under 8 steps |
| build-vite | Build: turn it into Vite + React, install, run the dev server | `vite`/`react` in package.json, Vite client through `/preview/` |

Options (environment):

| Variable | Use |
| --- | --- |
| `MODEL=openrouter/anthropic/claude-haiku-5.5` | Another model for the engine |
| `ONLY=notes,build-vite` | Some scenarios. Later ones build on earlier ones' state (memory needs notes, chain needs todo, build-edit needs build-static) |
| `AGENT_ENGINE=builtin` | The old loop, for comparison (in a proxied sandbox add `NODE_USE_ENV_PROXY=1`) |
| `STEPS=1` | Print every step of every scenario |
| `VERBOSE=1` / `ENGINE_VERBOSE=1` | Server / OpenCode output |
| `KEEP=1` | Keep the temp folder (data, OpenCode sessions, Build project) |
| `ASK_TIMEOUT=400` | Seconds per request (default 300) |

### Reading a failure

1. The scenario prints the Task's status, the agent's answer and every step. Most failures are visible there: a repeated step means the model kept retrying one call.
2. `KEEP=1`, then read the raw tool calls the model made:

```sh
D=$(ls -td /tmp/flip-agents-* | head -1)/data/engine/home/data/opencode
python3 - "$D" <<'PY'
import sqlite3, sys, json
db = sqlite3.connect(sys.argv[1] + "/opencode.db")
for (d,) in db.execute("select data from part order by rowid"):
    j = json.loads(d)
    if j.get("type") == "tool":
        s = j["state"]; print(j["tool"], json.dumps(s.get("input"))[:200], "=>", str(s.get("output") or s.get("error"))[:200])
PY
```

3. To see exactly what is sent to the model, put a logging relay in front of OpenRouter with `ENGINE_CONFIG='{"provider":{"openrouter":{"options":{"baseURL":"http://127.0.0.1:4999/v1"}}}}'` (a 20-line Node server that writes each request body and forwards it).

What usually fixes an agent failure, in order: a clearer tool error that says how to fix the call, a narrower tool with required fields, a sentence in the tool's description, then the prompt in `runner.ts` / `engine.ts`. Change the model last.

### Flakiness

Models are not deterministic. A scenario must pass **3 runs in a row** before it counts. Run a loop:

```sh
for i in 1 2 3; do pnpm --filter server test:agents | grep -E "^(✓|✕)|failed$|All passed"; done
```

## 4. Cloud simulation (`cloud-vm/sim/`)

`run.sh` builds `flip-server:local` (the production server image) and `flip-device:local`, starts them with Docker memory caps (cloud 8 GB, device 2 GB), and runs `smoke.mjs` through the device box:

1. cloud health through the device box,
2. the real Device UI in Chromium at 784×504 gets live state (`out/device-home.png`),
3. Omni: three notes, delete the second,
4. Build: a static site, shown in a frame sandboxed like the Device's, button clicked (`out/preview-static.png`),
5. Build: Vite + React with its dev server, React renders through two proxies, button clicked (`out/preview-vite.png`),
6. memory of both boxes.

`KEEP=1` leaves the boxes up (Device on http://127.0.0.1:5173, server on :8787). `SKIP_BUILD=1` reuses the images. `VITE=0` skips step 5. Behind a TLS-inspecting proxy: `CA_CERT=/path/ca.crt`. Stop with `docker compose -f cloud-vm/sim/compose.yml -p flip-sim down -v`.

Docker Hub may rate-limit image pulls (429). Wait a minute and run again: built layers are cached.

## 5. Real VMs

With `pi-vm/tunnel.sh` open: `DEVICE=http://localhost:15173 VITE=0 node cloud-vm/sim/smoke.mjs`. It talks to the deployed system exactly like the kiosk does. Add more checks to `smoke.mjs` rather than writing a second script.

## Adding a scenario

Add an entry to `scenarios` in `apps/server/scripts/agent-e2e.ts`: a request and a `check()` that reads the end state and returns `null` or what is wrong. Keep requests in the user's words, not tool names. Run it 3 times on the default model before you commit.
