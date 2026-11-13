# 0007: Button-only UI, mapped from device-controls.md

Status: Accepted
Date: 2026-11-13

## Decision
The screen is not touch. Every screen is driven by the controls in `device-controls.md`:

| Control | Everywhere | Inside functions |
| --- | --- | --- |
| System wheel | Switches function (Home, Notes, To-Do, Agents, Focus, Settings). Docked: Dock, Agents, Focus, To-Do. | — |
| Mic button | Hold to dump, let go to save. On a note: hold to add to it. | — |
| In-app wheel | — | Browse lists, set focus length, pick a colour. No action in Agents (per the doc). |
| D-pad | — | Move the selection. |
| A | — | Confirm the selection. Approves *soft* requests (Manual mode, Auto asking in the grey zone). |
| B | Back. "Not now" on any approval. | — |
| X, Y | — | Per screen, always shown in the hint bar at the bottom. |
| Push bar | — | **The approval press for risky actions** (send, delete, pay, leave). Start/end focus. Complete a todo. |

Risky actions (the fire screen) can only be approved with the push bar, not with A.

## Why
The approval press is the reason the hardware has buttons (ADR 0004). If A also approved risky actions, a habit of pressing A to move on could send an email. A different, deliberate control for "this leaves your machines" keeps the press meaningful. Pressing A on the fire screen nudges the user toward the push bar.

## Consequences
- The hint bar always says what A/B/X/Y and the push bar do right now (device-controls.md asks for this).
- The simulator draws every control; keyboard, mouse wheel and a gamepad map onto them (`apps/device/src/input/controls.ts`). Real firmware would emit the same control events.
- If the team prefers A to approve risky actions too, change `FireOverlay` in `apps/device/src/app/overlays.tsx`.
