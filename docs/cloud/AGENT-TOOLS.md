# Agent tools

Tools live in the server (`apps/server/src/agents/`). The engine loads their schemas at start, so a tool added here is available to agents after a server restart. Every tool runs through `ctx.gate`.

## Gate rules (ADR 0004, 0008)

| Kind | Manual | Auto | Full |
| --- | --- | --- | --- |
| `risk` (send, delete, leave) | press | **press** | runs |
| `alwaysAsk` (shell, dev server) | press | press | runs |
| `grey` with `ask_first: true` | press | press | runs |
| everything else | press | runs | runs |

Risk is set on the tool, never by the model.

## Catalog

**Notes** (`app-tools.ts`, `APP_MANIFEST`)

| Tool | Input | Gate |
| --- | --- | --- |
| `notes_read` | — | |
| `notes_create` | `texts[]` (batch, in order) | |
| `notes_append` | `id`, `text` | |
| `notes_replace` | `id`, `text` (full new text) | asks in Auto |
| `notes_delete` | `ids[]` | delete |

**To-Do**

| Tool | Input | Gate |
| --- | --- | --- |
| `todo_read` | — (returns To-Dos and projects) | |
| `todo_create` | `items[]` of `{title, due?, projectId?}` | |
| `todo_update` | `ids[]`, `due?`, `projectId?`, `title?` (title: one at a time) | |
| `todo_complete` / `todo_reopen` | `ids[]` | |
| `todo_delete` | `ids[]` | delete |

**Other apps:** `read_app {app}` (focus, agents, settings, build, dock) and `change_app {action}` with `focus.start`, `focus.stop`, `agents.create`, `settings.permission`. Settings never exposes keys or Full mode.

**Agents:** `list_agents`, `send_agent_message {agent_id, message, expects_reply}` (a request is answered before the asker replies; depth and fan-out limits, ADR 0013).

**Your machines (PC agent)** (`tools.ts`): `list_files`, `read_file`, `find_duplicates`, `write_file` (never overwrites), `make_folder`, `move_files`, `trash_files` (delete, recoverable in `~/.flip-trash`), `open_on_machine`, `notify`, `run_shell` (only with `--allow-shell` and `DEVICE_ACCESS_TOKEN`), `send_email` (send).

**Build** (`build-tools.ts`), for the agent that serves Build:

| Tool | `BUILD_HOST=server` (cloud) | `BUILD_HOST=pc` |
| --- | --- | --- |
| OpenCode `read`, `glob`, `grep`, `edit`, `write`, `bash` | yes, inside the project only; bash always asks, edits ask in Manual | no |
| `build_list`, `build_read`, `build_write`, `build_run` | replaced by the above on the engine; used by the built-in loop | yes, through the PC agent |
| `build_serve {command, port}` | starts the dev server (`--base /preview/`), streams it to the Device | no |
| `build_stop`, `build_logs` | yes | no |
| `build_history`, `build_undo {steps}` | the project is a git repository; the server commits after every Build Task (message = the spoken request). Undo is `git revert`, never a reset, so it can be undone too | no |
| `build_screenshot {path?}` | renders `/preview/` in headless Chromium at 568×504 inside a frame sandboxed like the Device's; returns the PNG (as an image when the model takes images) plus page errors and the boxes of visible elements | no |
| `build_preview {url}` | no | yes |
| `build_deploy {command}` | leave | leave |

**After every edit** (OpenCode `edit`/`write`, or `build_write` on the server) the server adds what broke to the edit's own result, so the agent fixes errors without asking for logs: with a dev server, it requests the edited module through it and adds the dev server's new error lines; then (and for static files) it loads the preview in the Device's sandboxed frame and adds the page's errors. Static edits also reload the Device preview at once (`state.build.rev`).

**Engine extras:** `todowrite` (the agent's plan), `webfetch` for research-type agents.

## Adding an app's tools

1. Add entries to `APP_MANIFEST` in `apps/server/src/agents/app-tools.ts`: `app`, `name` (`<app>_<verb>`), a one-line `description`, `props` with **required** fields marked in `required`, and the `action` it runs.
2. Implement the action in `change_app.run` (or a read in `read_app.run`). Call `ctx.gate` with the right `risk` before you change anything. Throw errors that say how to fix the call.
3. If the app is new, add it to `APP_IDS` in `packages/protocol` and give it a default agent in `store.ts` (that is a Protocol change: write an ADR).
4. Add a scenario to `scripts/agent-e2e.ts` and run it 3 times.

Rules that came from real failures:

- **Required fields over optional ones.** If an action needs a field, make it a separate tool where that field is required.
- **No shared field names with different meanings** (`name` meant "agent name" and the model used it for a note's text).
- **Batch inputs** (`ids[]`, `items[]`) so "all of them" is one call and one approval.
- **Return IDs** of what was created, so the next step can use them without reading again.
- **Errors say the fix**: "No Note has ID x. Read notes with notes_read and use an ID from there."
- Keep descriptions to one or two sentences. The model reads every tool's description on every step.
