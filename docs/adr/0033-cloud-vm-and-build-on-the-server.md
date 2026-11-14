# 0033: The cloud VM runs the server and the Build project; the Device only shows the screen

Status: Accepted
Date: 2026-11-14

Extends 0024 (the Pi-class VM) and 0022 (the server-proxied Build preview). Builds on 0032 (the OpenCode engine).

## Decision
Two machines. The Device (Pi 5-class, 2 GB) runs only the screen: the kiosk browser and `docker/serve.mjs`, which passes `/ws`, `/setup`, `/health` and `/preview/` to the cloud. The cloud VM (8 GB) runs the server, the agent engine and the Build project. `pi-vm/deploy.sh` with `SERVER_URL` makes the Pi VM Device-only; `cloud-vm/up.sh` creates and wires both.

With `BUILD_HOST=server`, the Build project lives on the cloud VM (`BUILD_DIR`). A Build Task gets OpenCode's own coding tools (read, glob, grep, edit, write, bash), scoped to that folder. The plugin's `tool.execute.before` hook sends each call to the server first, which checks the folder and applies the same gate: bash always asks in Manual and Auto, edits ask in Manual. `build_serve` starts the project's dev server on the VM's localhost with base path `/preview/`; the server streams it to the Device through `/preview/`, hot-reload socket included. Without a dev server, `/preview/` serves the files.

`BUILD_HOST=pc` (the default without the cloud setup) keeps 0021 and 0022 unchanged.

## Why
The Device has 2 GB; agents, npm installs and dev servers do not fit next to a browser. On the cloud VM they do (the whole cloud side used about 740 MB with a Vite dev server running in the simulation). Building on the VM means a Build agent works like a real coding agent and the user can build framework apps by talking, without a laptop in the loop. One origin for the Device means the cloud VM needs no public port.

## Consequences
- The Device UI and the Protocol do not change.
- A command the user approves in Build runs on the cloud VM as the `flip` user, not in a sandbox. In Full mode it runs without asking. Keep the VM single-purpose.
- One dev server at a time. It comes back after a server restart.
- Dev servers must support a base path (`--base /preview/` in Vite). Frameworks that don't need their own setup.
