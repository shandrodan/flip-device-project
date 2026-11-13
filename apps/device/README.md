# apps/device

React + Vite PWA. The Device screen (784 × 504, non-touch) and the Dock screen, on one WebSocket.

- `/` the device twin: the flip device drawn open with every control from `device-controls.md`, plus a dev panel (dock, offline, voice source).
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
- `src/app/`: the screen shell, overlays (talk, fire approval, soft approval, function switcher) and screens.
- `src/bot/Bot.tsx`: the agent bots, ported from `prototype/`.
- `prototype/` and `design-directions/`: the original single-file designs this app is built from. Kept as reference.

Rules: thin client, types from `@app/protocol`, CSS transforms for animation, vibration API for haptics where available.
