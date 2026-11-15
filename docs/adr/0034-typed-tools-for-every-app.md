# 0034: Every Device app has typed tools, and models no longer see change_app

Status: Accepted
Date: 2026-11-15

Extends 0032. The engine, forwarding to the app's Task agent (0027) and the gate do not change.

## Decision
Focus, Agents and Settings get typed tools like Notes and To-Do: `focus_start {minutes}`, `focus_stop`, `agents_create {name, role}`, `settings_permission {mode}`, in `APP_MANIFEST`. With that, every app change a model makes has its own small tool with required fields.

`change_app` is no longer offered to any model (`hidden` on its `ToolDef`). It stays in the server: typed tools still run as `change_app` actions, forwarded app requests run it on the app's Task agent, and the demo planner calls it. `read_app` stays, for reading Focus, Agents, Settings, Build and the Dock.

## Why
0032 found that one tool with many actions and shared optional fields is what cheap models get wrong. After 0032 the only actions left behind `change_app` were these four, and a model that saw `change_app` could still pick it for Notes or To-Do and drop fields. Removing it from the model's list finishes the move.

## Consequences
- A new app action means a new entry in `APP_MANIFEST`. Adding it only to `change_app` makes it unreachable for models.
- Scripts that drove `change_app` as a model now use the typed tools (`scripts/e2e.ts`).
- `pnpm --filter server test:tools` (`typed-apps`) checks that `change_app` is not in the tools sent to the model.
