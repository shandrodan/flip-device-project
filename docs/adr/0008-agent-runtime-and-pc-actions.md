# 0008: Agent runtime and what the PC agent may do

Status: Accepted
Date: 2026-11-13

## Decision
Task agents run on the server as a Claude tool-use loop (`apps/server/src/agents/runner.ts`) with the user's own key. Without a key, a built-in planner runs fixed plans for the common jobs (tidy a folder, send a file by email, archive a folder, research brief, write it down) using the *same* tools and the *same* approval rules.

The PC agent allows only these actions, and only inside allowed folders (default `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Pictures`, `~/Flip`):
`fs.list`, `fs.read`, `fs.write`, `fs.mkdir`, `fs.move`, `fs.trash`, `fs.duplicates`, `open`, `notify`, `claude.window`, and `shell` only when started with `--allow-shell`.

- `fs.trash` never deletes: files move to `~/.flip-trash/<time>/`, so a delete can be undone.
- Risk is fixed per tool, not chosen by the model: `trash_files` is a delete, `send_email` is a send. In Auto, grey-zone tools carry an `ask_first` flag the model sets. Every tool passes the gate, so Manual asks for every action.
- Mail without SMTP writes a ready-to-send `.eml` into `~/Flip/Outbox` and opens it in the mail app.

## Why
Answers the open question in ADR 0006. A short allowlist plus folder roots is easy to explain to judges ("what stops it deleting my files?": it can't leave these folders and it can't really delete). The planner keeps the demo reliable with no key and no network.

## Consequences
- The demo task can be "clean up my Screenshots folder" (visible on the projector, needs one delete approval) and "send Jonas the pitch deck" (needs one send approval).
- New agent abilities are new tools in `apps/server/src/agents/tools.ts`, each with a risk.
- Shell access stays off by default.
