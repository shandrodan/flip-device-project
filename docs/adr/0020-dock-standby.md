# 0020: The Dock is a StandBy carousel, and shows the coding agents on your machines

Status: Accepted
Date: 2026-11-14
Replaces the Dock widget grid. The handheld controls (0007, 0010, 0019) are unchanged.

## Decision
Docked, the Device shows one screen that turns like Apple's StandBy. The in-app wheel moves between five screens and never ends. While it turns, the screen zooms out to a row of cards and back in.

1. **Clock**, full screen.
2. **Focus**, full screen. The time sits in the centre. Progress is a glow around the screen edge, starting at top centre and running clockwise: white at the very edge, red further in. As the session runs out the glow shortens, reaches further in and gets stronger, and it breathes slowly. It's a small WebGL shader that only draws while the page is in view. Without WebGL the page shows a still CSS glow.
3. **Agents**: the coding agents on your machines (Claude Code, Codex, OpenCode, Antigravity, Cursor Agent, Gemini CLI, Aider), not the Task agents. Each shows its repo, branch, machine and whether it's Working, Idle or Finished.
4. **To-Do**: the Scheduled board from the To-Do app (0016), in dark.
5. **Split**: two blocks side by side. Each is Clock, Focus timer, Agents, Today or Claude limits. The choice is kept on the Device.

Docked, the D-pad and the A–D buttons are out of reach, so the Dock uses only the lid:

| Control | Dock |
| --- | --- |
| In-app wheel | Next or previous screen. Editing the split: change the selected block |
| In-app wheel press | On the split screen: edit it, and press again when done |
| Push bar | On Focus: start or end the session. Editing the split: switch to the other side |
| Mic | Talk to the main Task agent, as on Home |

The status bar and hint bar are hidden. Approvals still take over the screen as everywhere else.

The PC agent checks the process list every 3 seconds for known coding tools and sends `pc.coding` when something changes. For each one it sends the tool, the git repo folder name and branch, whether it's busy, and when it started. Busy means it used CPU in the last 6 seconds, or, for Claude Code, wrote its transcript in the last 8 seconds. When a process ends, the server keeps it as Finished for 30 minutes. The snapshot carries all of it as `coding`. These protocol changes are additive.

Tool icons are in `apps/device/public/agent-icons`. They're drawn as masks in each tool's colour.

Decided from a throwaway prototype:
- Rejected **Glance** (one huge number per screen), **Map** (every widget on one screen as tiles) and **Ambient** (time on the left, a stack of cards on the right). StandBy's turn-and-zoom was the one to keep.
- Rejected a progress line along the edge: it cut hard at the rounded corners. The glow alone reads better.
- Rejected the ring around the time: it looked like an app, not a dock.

## Why
On the desk the Device is glanceable furniture. One thing per screen reads from your chair, and the turn-and-zoom makes the wheel feel physical. What builders want to glance at is whether Claude Code finished while Codex is still going. Those agents already run on their own machines, so the PC agent is the right thing to report them.

## Consequences
- Idle can't tell "waiting for your answer" from "you left it open". Claude Code's hooks could report that later.
- Coding agents can't be approved or stopped from the Dock yet. The push bar only does Focus here.
- Windows PC agents report no coding agents for now.
- Only the folder name of the repo and the branch leave the machine, never code or conversations.
- The `/dock` page shows the same screen. W and S turn the wheel there.
