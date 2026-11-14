# Roadmap

Ordered by what moves the product most. Each item has a check that says it's done. "Scenario" means a new entry in `apps/server/scripts/agent-e2e.ts` that passes 3 runs in a row on the default model.

Ground rules for every item: the Device UI and the Protocol stay unchanged unless an ADR says otherwise; risk stays on the tool; new tools follow [AGENT-TOOLS.md](AGENT-TOOLS.md).

## P0: make the cloud real

1. **First GCP deploy.** Run `cloud-vm/up.sh` and fix what breaks.
   Done when: `DEVICE=http://localhost:15173 VITE=0 node cloud-vm/sim/smoke.mjs` passes against the real VMs, and a spoken request on the twin creates a Note.
2. **Device memory with a remote server.** Read the Pi VM's monitor while the kiosk runs.
   Done when: `docs/cloud/ARCHITECTURE.md` has the measured numbers, and the Pi VM stays under 1.5 GB used through a Build session.
3. **Engine health.** `/health` reports `engine: "opencode" | "builtin" | "starting" | "failed"`, and the server restarts OpenCode once if it exits.
   Done when: killing the `opencode` process mid-session, the next request still succeeds (test in `agent-e2e.ts` or a small script).

## P1: the Build app, to "build something great by talking"

4. **The agent sees its result.** `build_screenshot`: the cloud renders `/preview/` with headless Chromium (add Playwright and its Chromium to the server image) at the Device's preview size and returns the image to the model. Prompt: check the screenshot before answering.
   Done when: a scenario "make the button bigger and centred" passes, and the screenshot is in the Task steps.
5. **Undo by voice.** Git in the Build project: commit after each finished Build Task (message = the request). New tools `build_history` and `build_undo {steps}` (`git revert`, never `reset --hard`).
   Done when: scenario "undo that" restores the previous `index.html`.
6. **Starters.** `build_new {template}` with `static`, `vite-react`, `vite-vanilla`, scaffolded from files in the repo (no network), with `--base /preview/` already set. Warm the pnpm/npm cache on the VM at provision time so installs take seconds.
   Done when: "start a new React app" reaches a running preview in under 30 s in the simulation.
7. **Errors come back by themselves.** After every edit while a dev server runs, append new error lines from `build_logs` to the tool result. Bump `state.build.rev` after edits to static projects so the preview reloads mid-Task.
   Done when: scenario "introduce and fix a syntax error" passes without the model calling `build_logs` itself.
8. **Projects.** Several Build projects under `/var/lib/flip/build/<name>`; `build_projects`, `build_open {name}`. `state.build.name/dir` already exist, so no Protocol change.
   Done when: "open the lemonade project" switches the preview.
9. **Publish.** `build_deploy` to Cloudflare Pages or Vercel with a token from `/setup` (risk `leave`, always a press).
   Done when: a deploy in the simulation returns a public URL (with a test account).

## P1: Notes and To-Do

10. **Search instead of read-all.** `notes_search {query}`, `todo_read {filter: today|overdue|project|done}`. Reading 200 items per step is slow and expensive.
    Done when: scenario with 150 notes ("delete the notes about the venue") passes, and the step count stays under 8.
11. **Projects as tools.** `todo_project_create`, `todo_project_rename`, `todo_project_delete` (delete risk).
    Done when: "make a project Launch and move the two pitch tasks there" passes.
12. **Note editing tools.** `notes_edit {id, find, replace}` for small changes in long notes (no full rewrite), `notes_merge {ids}`.
    Done when: "in the shopping note, change milk to oat milk" passes without retyping the note.

## P2: across the system

13. **Typed tools for Focus, Agents and Settings** (`focus_start {minutes}`, `focus_stop`, `agents_create {name, role}`, `settings_permission {mode}`), then retire `change_app` from the model's tools (keep it for forwarding and the planner).
14. **Show the plan.** Turn OpenCode `todowrite` updates into Task steps (read them from `/session/{id}/todo` while polling), so the Device shows "1/4 Create notes".
15. **Connectors through the gate.** Email, calendar or GitHub as OpenCode MCP servers via `ENGINE_CONFIG`, but every MCP call passes the plugin's `tool.execute.before` hook to the server gate with a fixed risk per tool. Never let an MCP tool skip the gate.
16. **Scheduled work.** "Every morning at 8, summarize my to-dos into a note": a small scheduler in the server that starts Tasks. Needs an ADR.
17. **Cost and speed per Task.** Log tokens and cost (OpenCode reports them per message) with each Task; print a summary at the end of `agent-e2e.ts`.

## P3: hardening

18. **CI.** GitHub Action: typecheck and `test:e2e` on every push; nightly `test:agents` with an OpenRouter key secret.
19. **Sandbox Build commands.** Run `bash` and `build_*` commands in `bwrap` (or a rootless container) limited to the project folder and the network, so an approved command can't touch the rest of the VM.
20. **Device token between the boxes.** Set `DEVICE_ACCESS_TOKEN` in the cloud deploy and have `serve.mjs` add it, so only the Device can use the cloud server even inside the VPC.
21. **Backups.** Nightly copy of `/var/lib/flip/data` and the Build projects to a bucket.
