# apps/device

React + Vite PWA. The Device screen (784 × 504, non-touch) and the Dock screen, on one WebSocket.

- `/` the device twin: the Blender model (`web-render/device-handoff`) rendered with Three.js, with the live Device screen on its `screen` mesh and every control clickable. Drag to turn it, scroll or pinch to zoom, scroll or drag the wheels, click the shell to slide the tray, and flip the kickstand or power switch. Plus a dev panel (dock, offline, voice source).
- `/?studio=1` studio mode: the twin on a clean stage, for stills and video of the Device with its live screen. Camera shots, backdrops, press rings, and `window.studio` for agents. See `docs/STUDIO.md`.
- `/?flat=1` the older drawn twin, also the fallback when WebGL is not available.
- `/?kiosk=1` the screen alone, scaled to the window. What a kiosk browser on the real board would show.
- `/dock` the dock screen for a second tab: focus, today's tasks, Claude limits, agent activity.

## Controls (ADR 0007)

| Device | Keyboard | Gamepad (Xbox layout) |
| --- | --- | --- |
| Mic, hold | Space | hold View |
| Push bar (approve risky, start/stop focus, complete todo) | Enter | Start |
| A (green) / B (red) / C (yellow) / D (blue) | K / L (or Esc) / I / J | A / B / Y / X |
| D-pad | arrow keys | D-pad |
| System wheel (switch function) | Q / E | LB / RB |
| In-app wheel (browse) | W / S, or scroll on the screen | LT / RT |
| In-app wheel press | D | right stick click |

The hint bar at the bottom of the screen always shows what each button does right now.

## Layout

- `src/input/controls.ts`: control events, layered handlers (talk > approvals > sheets > screen > global), keyboard and gamepad.
- `src/net/client.ts`: the WebSocket, last snapshot cache, offline notes queue.
- `src/voice/capture.ts`: microphone (MediaRecorder + on-device recognition) and scripted voice.
- `src/sim/Device3D.tsx`: the 3D twin. The screen stays real DOM (CSS3DRenderer) behind a hole in the WebGL canvas. Loaded lazily, so kiosk and dock never download Three.js.
- `src/sim/StudioPage.tsx`, `studio.ts`, `clock.ts`: studio mode, its `window.studio` API, and the clock a recorder can freeze and step.
- `studio/`: the recorder (`pnpm --filter device studio frame|record`), run by Node with a headless browser. Not part of the Device app.
- `src/app/`: the screen shell, overlays (talk, fire approval, soft approval, function switcher) and screens.
- `src/bot/Bot.tsx`: the agent bots, ported from `prototype/`.
- `prototype/` and `design-directions/`: the original single-file designs this app is built from. Kept as reference.

Rules: thin client, types from `@app/protocol`, CSS transforms for animation, vibration API for haptics where available.
