# Overnight brief

You are working alone overnight on Flip, a small voice device whose agents run on a cloud VM. By morning the owner wants: everything tested, everything working, and the next features built with tests. Read this whole file, then `AGENTS.md`, `CONTEXT.md`, and the rest of `docs/cloud/`.

## Setup (first 10 minutes)

```sh
git checkout claude/serene-darwin-uvr9gt && git pull      # or the branch you were given
pnpm install
(dockerd > /tmp/dockerd.log 2>&1 &) ; sleep 5 ; docker info | head -3   # in a cloud sandbox without a running daemon
export OPENROUTER_API_KEY=${OPENROUTER_API_KEY:-proxy-injected}        # sandbox proxies inject the real key
```

In a Claude Code cloud session, use the `flip-device-project` environment: it already has the OpenRouter key on its network proxy, so `proxy-injected` works as the key. If outbound HTTPS needs a CA (`/root/.ccr/ca-bundle.crt` in Claude cloud sessions), pass `CA_CERT=` to the simulation.

Then prove the baseline before changing anything:

```sh
pnpm -r typecheck
pnpm test:e2e
pnpm test:agents                                   # 9 scenarios
CA_CERT=/root/.ccr/ca-bundle.crt HTTP_PROXY=$HTTPS_PROXY cloud-vm/sim/run.sh   # drop CA_CERT/HTTP_PROXY outside a proxied sandbox
```

If the baseline fails, fixing it is the night's first job. Write down what failed and why.

## Rules

1. **The Device UI and `packages/protocol` do not change.** No edits under `apps/device/`. If an item seems to need one, skip it and say why in the report.
2. **Risk stays on the tool.** Never let a model choose whether something asks. Every new tool calls `ctx.gate` before it changes anything.
3. **Tests before "done".** An agent scenario counts when it passes 3 runs in a row on the default model (`deepseek/deepseek-v4.1-flash`). If it can't, try `MODEL=openrouter/anthropic/claude-haiku-5.5` and report both.
4. **Fix the tool before the prompt, the prompt before the model.** See "Reading a failure" in [TESTING.md](TESTING.md).
5. **Commit after each finished item**, with a message that says what and why. Push to your branch. Never force-push, never push to `main`.
6. **Decisions go in ADRs.** A change in direction gets a new file in `docs/adr/` that supersedes the old one.
7. **Use the words in `CONTEXT.md`** in code, docs and messages.
8. **Budget.** Stay under $5 of model spend for the night. The full agent suite costs a few cents on DeepSeek; the simulation a bit more. Don't loop a failing test more than 5 times without changing something.
9. **No GCP.** You have no `gcloud`. Everything is proven in the simulation. Keep `cloud-vm/*.sh` correct by reading and `bash -n`, and note anything the owner must try on real VMs.

## The work, in order

Do these from [ROADMAP.md](ROADMAP.md), in this order. Stop an item after 90 minutes without progress, write down where it stands, and move on.

| # | Roadmap item | Why first |
| --- | --- | --- |
| 1 | P0.3 Engine health and restart | A crashed engine must not break the demo |
| 2 | P1.4 `build_screenshot` | The biggest jump in Build quality: the agent sees its own work |
| 3 | P1.5 Undo by voice (git in the Build project) | Building by voice needs a safety net |
| 4 | P1.7 Errors come back by themselves | Fewer broken previews |
| 5 | P1.6 Starters with a warm cache | "Start a React app" in seconds |
| 6 | P1.10 Search and filters for Notes and To-Do | Scales past a few dozen items |
| 7 | P1.11 Project tools | Common To-Do requests that fail today |
| 8 | P1.12 Note edit and merge | Small edits without retyping |
| 9 | P2.13 Typed Focus, Agents, Settings tools | Finishes the typed tool set |
| 10 | P2.14 Show the plan as steps | Visible progress on the Device |
| 11 | P2.17 Cost and speed per Task | Know what each request costs |
| 12 | P3.18 CI | Keep it green after tonight |

For each: add the code, add a scenario (or extend `smoke.mjs` for topology items), run it 3 times, update `AGENT-TOOLS.md` and the status table in `docs/cloud/README.md`, commit.

## Hard-won facts (don't relearn these)

- Cheap models fail on one big multi-action tool with shared optional fields. Small tools with required fields and batch inputs fix it.
- OpenCode talks to OpenRouter in OpenAI format. Its `top_p` and format differ from the old loop, so test both engines when comparing.
- `tool.execute.before` in the plugin is the gate for OpenCode's own tools. `permission` in the engine config is all `allow` on purpose (plus `external_directory: deny`): OpenCode must never wait on its own prompt, because nothing answers it.
- Dev servers must run with base path `/preview/` on 127.0.0.1 through `build_serve`. A plain long-running command blocks the agent.
- The preview frame on the Device has an opaque origin. Keep `access-control-allow-origin: *` on `/preview/`.
- Docker Hub rate-limits anonymous pulls (429). Wait and retry; built layers are cached.
- In a proxied sandbox, Node's own `fetch` ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`. OpenCode (Bun) honors it.
- Debian's apt mirrors use plain HTTP, which a TLS-only sandbox proxy refuses. That's why the server image is `node:22-bookworm` (no apt step).

## Morning report

Write `docs/cloud/REPORT-<date>.md` with:

1. **Baseline:** what passed and failed before you changed anything.
2. **Done:** each item, its commit, the scenario that proves it, and the pass count (e.g. 3/3 DeepSeek, 3/3 Haiku).
3. **Not done:** each item you stopped, where it stands, what you'd try next.
4. **Test table:** the final run of every layer from [TESTING.md](TESTING.md), with numbers (time, memory, steps).
5. **For the owner:** anything to try on the real VMs, any decision only they can make, any cost surprise.

Keep it short and true. If something is flaky, say so with the numbers.
