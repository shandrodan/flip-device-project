# 0021: The Build app, and apps that fall back to the main agent

Status: Accepted. Changes the one-agent minimum of 0015 for Build only
Date: 2026-11-14

## Decision

Add a Build app: you talk, and an agent builds a web app on your own machine while the Device shows
its live preview. A black sidebar on the left holds the agent's bot with one line under it; the rest
of the screen is the preview, wrapped in a yellow and black caution-tape stroke on the screen edge.

Build may have no assigned Task agent. With none, the main agent does its work and its bot sits in
the sidebar. Once you add a Task agent to Build, that agent does the work and its bot takes the
sidebar. Deleting Build's last agent hands the work back to the main agent. Every other app still
keeps at least one agent (ADR 0015). The main agent still cannot join an app: it only fills in.

The project is one folder on the user's machine (`BUILD_DIR`, default `~/Flip/build`). Whoever
serves Build gets `build_*` tools scoped to that folder: list, read, write (replaces files), run
a command, deploy, and set the preview address. Deploying leaves the user's machines, so it always
needs the push bar. Running a command always asks unless Full mode is on.

## Why

Building is the main agent's job when you start out: you shouldn't have to make an agent before you
can try Build. Teams that want a dedicated builder (its own name, look and personality) can add one,
and the screen then shows who is actually doing the work.

## Consequences

`minAppAgents(app)` in the protocol says how many agents an app must keep (0 for Build, 1 for the
rest), and the server and Device both use it. Old saved state gets `build: []` on load. A Build
voice request is tagged `app: "build"` on its Task, and the preview reloads after every Build task
(`snapshot.build.rev`). Writing code needs an AI key: the built-in planner only looks at the
project and says so. The preview address must be reachable from the Device (Tailscale or LAN IP);
set it with `BUILD_PREVIEW_URL` or let the agent set it once it starts a dev server.
