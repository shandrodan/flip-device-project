# AGENTS.md

Context for any coding agent working in this repo. Read this first, then CONTEXT.md, then the doc for the area you're touching.

## What we're building

A small flip-style AI device for people who work at a desk (developers, builders, founders). You talk to it, and agents do the work on your own machines. You only press a button to approve risky actions.

**Pitch line:** Dump your thoughts out loud. Agents turn them into work on your own machines. You only press a button to approve.

- **Handheld:** on battery, for voice notes and talking to agents.
- **Docked:** sits beside your desktop as a companion screen (focus timer, todos, Claude limit reset countdown).
- **Open:** bring your own key, self-host on your own VM, open SDK for your own apps.

Product name: TBD.

## Hackathon context

- Event: Unfair Weekend, Vilnius, Nov 12-15 2026. Team of 3.
- No hardware. The device is simulated as a full-screen web app; the hardware is shown with Blender renders.
- Never present the web app as real hardware. Framing: "software-first, hardware-ready".
- The device side runs in an arm64 Docker container with hard limits to show it fits a Raspberry Pi 5-class board. This proves memory fit, not Pi CPU speed.

## Repo map

| Path | What lives there |
| --- | --- |
| `apps/device` | React + Vite PWA: the device screen and the dock screen |
| `apps/server` | Node backend: WebSocket server, task agents, voice |
| `apps/pc-agent` | Small agent on the laptop, reached over Tailscale |
| `packages/protocol` | Shared WebSocket message types. Every app imports these. |
| `docs/` | SHAPE, STACK, APPS, DEMO |
| `docs/adr/` | One file per decision. Read before changing direction. |
| `device-controls.md` | The physical controls. The UI is button-only (ADR 0007). |
| `renders/` | Blender scripts and exported renders |
| `pitch/` | Slides, video, demo script |
| `docker/` | Container setup for the device-side demo |

## Rules for agents

- TypeScript everywhere. React for UI, Node for backend.
- All device ↔ server messages go through `packages/protocol`. Never invent ad-hoc message shapes.
- Keep the device client thin. Agents and heavy work live on the server.
- Keep the UI light: CSS transforms over JS animation, no heavy libraries.
- Build only what the demo flow in `docs/DEMO.md` needs.
- Changing a decision in `docs/adr/`? Write a new ADR that supersedes it. Don't silently diverge.
- Use the words in CONTEXT.md exactly.

## Open questions

- Product name
- ~~What the PC agent can control~~: see `docs/adr/0008-agent-runtime-and-pc-actions.md`
- Why buy our hardware instead of flashing our OS onto your own Pi
- Hackathon rules on prior code, submission format and judging
