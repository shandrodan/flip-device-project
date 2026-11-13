# 0010: C and D buttons, in-app wheel rules, command center

Status: Accepted
Date: 2026-11-13
Supersedes 0007

## Decision
Everything in 0007 stands (button-only UI, risky actions approved only with the push bar), with these changes:

| Control | Change |
| --- | --- |
| C (yellow, top of the cluster) | Was "Y". On Home it opens the command center; inside apps it's the screen's own extra action. |
| D (blue, left of the cluster) | Was "X". The screen's other extra action. |
| In-app wheel | Always cycles: past the last option it comes back to the first. The D-pad still stops at the edges. It now picks an agent in Agents and browses every cell on Home. |

Control ids in code are `c` and `d` (`apps/device/src/input/controls.ts`). Keyboard: I = C, J = D. Gamepad: Y = C, X = D (same physical positions).

The command center is a shade on Home: Wi-Fi, Bluetooth, Tailscale, Battery saver and Do Not Disturb on a flywheel, recent notifications below. Its switches are on-screen only for now. Details in `device-controls.md`.

## Why
`device-controls.md` names the buttons by colour and letter (C yellow, D blue). Using the same letters on the hardware, in the hint bar and in code keeps one vocabulary. A wheel with no end matches how a physical detented wheel feels.

## Consequences
- Hint bar, simulator and the command-center mockups show C and D.
- New screens set hints with `c:` and `d:` keys.
