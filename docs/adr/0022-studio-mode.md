# 0022: Studio mode films the 3D twin

Status: Accepted
Date: 2026-11-14

## Decision
The demo video is filmed from the 3D twin in the browser (`/?studio=1`), not rebuilt in Blender. The Device is driven through its controls only, by a person or by an agent, and every press is marked on the model. Agents record with a frame-by-frame recorder (`apps/device/studio`), where the page's clock is frozen and stepped once per picture.

## Why
The video has to show the real Device screen reacting to real presses. The twin already has the live screen on the model; Blender would need the UI faked as textures. Stepping a frozen clock gives a smooth video on any machine, also one with no GPU, and the same script gives the same take every time.

## Consequences
Still a render of a web app: never present it as real hardware (ADR 0002). The UI stays button-only in the studio too (ADR 0007): agents press controls, they do not click the screen. Anything timed in the Device app must use the normal browser timers and CSS animations, which the studio clock controls. Filming is slow without a GPU (1 to 2 s per frame), so there is a draft mode.
