# 0032: OpenCode runs the Task agent loop, and apps get typed tools

Status: Accepted
Date: 2026-11-14

Supersedes the loop in `runner.ts` from 0008 and 0026 as the default. The tools, the risk rules, the gate and the approval press from 0004 and 0008 do not change. Extends the app actions in 0027.

## Decision
Task agents run in OpenCode on the server machine (`opencode serve`, one process for all agents). The Flip tools stay in the server: the plugin `apps/server/engine-plugin/flip.ts` loads their schemas from the server and sends each call back over localhost with the OpenCode session ID, so it runs with its Task's context, gate and approval press. OpenCode's own shell and file tools are off, because they would act on the server, not on the user's machines. Each agent keeps one OpenCode session per app, so it remembers its own earlier tool calls. A call that fails the same way three times gets a nudge, and six times ends the Task.

Notes and To-Do get small typed tools with required fields (`notes_create`, `todo_update`, …) in `APP_MANIFEST` (`src/agents/app-tools.ts`). They run as `read_app` / `change_app`, so forwarding to the app's agent and approvals stay as in 0027. Creating Notes and To-Dos takes a batch.

`AGENT_ENGINE=builtin` keeps the old loop. If OpenCode can't start, Tasks use the old loop. The model is the saved key's model, or `ENGINE_MODEL` (`provider/model`). `ENGINE_CONFIG` adds OpenCode config such as another provider or a local model.

## Why
We tested multi-step requests with a real model (`pnpm test:agents`: create six Notes and delete 1, 3 and 5; follow-ups; date chains; cross-app; files). Two findings:
- The old loop wasn't the main problem. With the same model it passed these tests.
- One `change_app` tool with 13 actions and shared optional fields was. A cheap model dropped or swapped fields (`name` for `text`, no `ids`) and repeated the failing call. Typed tools with required fields and batches fixed it: DeepSeek V4 Flash went from flaky to passing every run, in about half the steps.

OpenCode gives the loop a maintained harness (retries, compaction, planning with `todowrite`, many providers including local models) instead of one we'd keep building ourselves. New apps add tools to the manifest; the engine picks them up when it starts.

## Consequences
- The server machine runs a second process of about 250 MB. Fine on the 8 GB server VM. On a 2 GB box, set `AGENT_ENGINE=builtin`.
- The first start installs the OpenCode plugin package into `DATA_DIR/engine`, so it needs the npm registry once.
- Agent sessions live in `DATA_DIR/engine/home`. Deleting that folder resets every agent's memory.
- The engine port is local only. Plugin calls carry a per-start token.
