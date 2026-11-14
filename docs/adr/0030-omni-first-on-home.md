# 0030: Omni is the main agent's name, and the first cell on Home

Status: Accepted
Date: 2026-11-14

## Decision
The main agent (id `main`) is called **Omni** by default, as in the pitch. A saved state that still has the old default name "Main agent" is renamed to Omni on load; a name the user chose stays. Device copy that said "Main agent" now says Omni.

On the Home comb, Omni is always the first cell: top left, before the apps, never fused to an app (ADR 0029). The in-app wheel, the D-pad and the system wheel flywheel all start from it.

## Why
Omni is who you talk to and who runs every other agent. It should be in the same list as the apps and always in the same place, not somewhere after the apps that moves as bots come and go.

## Consequences
Omni appears twice on Home: the big bot in the left column and its cell on the comb. The cell gives Omni a cell menu (rename, personality, look) like any other bot.
