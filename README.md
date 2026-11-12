# [Product name TBD]

A flip-style AI device for people who work at a desk. Dump your thoughts out loud; agents turn them into work on your own machines; you press a button to approve.

Built at Unfair Weekend, Vilnius, Nov 2026.

## Start here

- Agents and humans: read [AGENTS.md](AGENTS.md) and [CONTEXT.md](CONTEXT.md).
- The demo we're building toward: [docs/DEMO.md](docs/DEMO.md).
- Decisions so far: [docs/adr/](docs/adr/).

## Run it

```bash
pnpm install
pnpm dev          # device app + server
```

PC agent (on the laptop that agents control):

```bash
pnpm --filter pc-agent dev
```

Device-side container demo: see [docker/README.md](docker/README.md).

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
