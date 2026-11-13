# [Product name TBD]

A flip-style AI device for people who work at a desk. Dump your thoughts out loud; agents turn them into work on your own machines; you press a button to approve.

Built at Unfair Weekend, Vilnius, Nov 2026.

## Start here

- Agents and humans: read [AGENTS.md](AGENTS.md) and [CONTEXT.md](CONTEXT.md).
- The demo we're building toward: [docs/DEMO.md](docs/DEMO.md).
- Decisions so far: [docs/adr/](docs/adr/).

## Run it

Needs Node 20+ and pnpm 9 (`npm i -g pnpm@9`).

```bash
pnpm install
pnpm dev          # Device app + server + a PC agent on this computer
```

Open http://localhost:5173 for the Device twin, and http://localhost:5173/dock for the Dock screen.
Hold the red mic (or Space), turn the wheels (Q/E, W/S), press A (K), B (L), C (I), D (J) and the push bar (Enter).
The Home mic talks to the main Task agent. On an agent screen it talks to that agent.
Each Device app has one or more assigned Task agents. Select an app on Home and press D
to add, change, or delete an agent. With another Home item selected, D opens pending Suggestions. C opens the command center.
The To-Do, Focus, Agents, and Settings mics talk to an assigned agent.
The Notes mic makes a Dump; the main agent files it into the open Note or a new one.

Nothing else is required. With no keys, agents use a built-in planner and speech uses the browser.
To go further, copy `.env.example` to `.env`, or open http://localhost:8787/setup to paste keys:

| What | Where |
| --- | --- |
| Real agents (Claude, your own key) | `ANTHROPIC_API_KEY`, or the setup page |
| Cloud speech to text | `STT_API_KEY` (OpenAI-compatible), or the setup page |
| The laptop on the projector | run `PC_AGENT_TOKEN=… pnpm dev:pc` there, set `PC_AGENTS=Name=ws://<tailscale-ip>:7077` and the same token on the server |
| Real email | `SMTP_URL`, `MAIL_FROM`, `CONTACTS` (otherwise mail lands in `~/Flip/Outbox` as an .eml) |

Checks:

```bash
pnpm typecheck
pnpm test:e2e              # the whole demo flow against a throwaway home folder
RUNS=20 pnpm test:e2e      # DEMO.md: "flow runs end to end 20 times in a row"
```

Other views: `/?kiosk=1` is the screen alone (what a kiosk browser on the board shows). `?server=ws://host:8787` points the Device at another server.

Device-side container demo: see [docker/README.md](docker/README.md).

## What's real and what isn't

- Real: the server, agents (Claude with a key, the planner without), approvals with the push bar, the PC agent doing file work and opening things on the laptop, offline notes and re-transcription, focus timer, the Claude Code limit window (read from Claude Code's logs on your machine), the dock screen.
- Simulated: the hardware. The Device is a web app with drawn controls (ADR 0002). Scripted voice is a rehearsal aid, labelled as such in the panel.

## Team split

| Area | Owner | Folders |
| --- | --- | --- |
| Agents and backend | TBD | `apps/server`, `apps/pc-agent` |
| Device and dock app | TBD | `apps/device` |
| Renders and pitch | TBD (+ team lead) | `renders/`, `pitch/` |

`packages/protocol` is shared. Change it in a PR everyone sees.

## How we work

1. The repo is the single source of truth. A decision not written here doesn't exist.
2. Whoever makes a decision writes the ADR within the hour.
3. Every agent session starts by reading AGENTS.md.
4. Tasks live in GitHub issues. One issue, one owner.
5. Ten-minute sync twice a day: what changed, what's blocked.
