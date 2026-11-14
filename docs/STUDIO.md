# Studio

Studio mode turns the 3D twin into a film set: stills and video of the Device with its live screen, for the demo video. Open `/?studio=1`, or press **Studio** on the twin page.

It is a render of a web app. Never present it as real hardware (ADR 0002, ADR 0023).

Both the model (WebGL) and the Device screen (real DOM behind it) are in every frame and every take.

## For people

The panel on the right has everything:

- **Capture.** *Save frame* saves a PNG. *Record video* starts a take, *Stop* saves it. The first capture asks to share this tab (Chrome or Edge); the picture is cut to the stage. Files land in Downloads.
- **Shot.** Named camera positions, a full turn, push in, pull back, tray, kickstand, power, dock. You can also drag the model to turn it, scroll or pinch to zoom, right-drag to move.
- **Set.** Backdrop (`green` for chroma key, `none` for transparent stills), frame shape, press rings, press captions, shadow.
- **Controls.** Every Device control as a button. Or press them on the model, or use the keyboard or a gamepad as on the twin.

Every press shows on the model: the part moves, and with **Press rings** on a ring marks it. **Press captions** also names the press in the frame.

## For agents

The Device is button-only (ADR 0007). Drive it the way a person does: through its controls. There are three ways in, and they can be mixed.

### 1. The page, like a person

Open `http://localhost:5173/?studio=1` in any browser tool.

- The panel buttons are real buttons with labels: `A button`, `B button`, `C button`, `D button`, `D-pad up` / `down` / `left` / `right`, `Push bar`, `Microphone, hold`, `System wheel back` / `forward`, `In-app wheel back` / `forward`, `In-app wheel press`. Each also has `data-control`.
- The model takes real clicks: click a button, hold the mic, scroll or drag on a wheel. `studio.locate("a")` gives the point to click and says whether the camera can see it.
- Keyboard: Space (hold) mic, Enter push bar, K / L / I / J for A / B / C / D, arrows D-pad, Q / E system wheel, W / S in-app wheel, D wheel press.

### 2. `window.studio`

| Call | What it does |
| --- | --- |
| `await studio.ready` | The model is on stage. |
| `studio.state()` | The view, the words on the Device screen (`screen`), what each control does right now (`hints`), mode, connection. Read this instead of guessing. |
| `studio.press("a")` | Press `a` `b` `c` `d` `up` `down` `left` `right` `pushBar` `appWheelPress`. `{ times, interval }` repeats. |
| `studio.turn("appWheel", 3)` | Turn `appWheel` or `systemWheel` by clicks. Negative turns back. |
| `studio.hold(2500, "Remind me to…")` | Hold the mic and speak the line with the scripted voice. Also `micDown(line)`, `micUp()`, `say(line)`. |
| `studio.shot("hero", { duration: 900 })` | Go to a named shot: `front` `hero` `left` `screen` `controls` `top` `wheel` `back` `wide` `closed`. |
| `studio.camera({ yaw, pitch, zoom, x, y, open }, { duration, ease })` | Any view. Radians, zoom 1 = whole Device, x / y in mm. No duration: a cut. Ease: `linear` `in` `out` `inOut`. |
| `studio.orbit(1, { duration: 8000 })` | Turn the Device around. |
| `studio.tray(true)` `kickstand(true)` `power(false)` `dock(true)` | The moving parts and the dock. |
| `studio.backdrop("black")` `aspect("9:16")` `rings(true)` `captions(true)` `shadow(false)` `panel(false)` | The set. `backdrop` also takes any CSS colour. |
| `studio.locate("pushBar")` | `{ x, y, visible }` on the page. Also `up` `down` `left` `right` on the D-pad, `mic`, `systemWheel`, `appWheel`, `power`, `kickstand`. |
| `studio.stage()` | The stage's box on the page, to crop a screenshot. |
| `studio.clock.freeze()` `step(ms)` `resume()` | Frame-by-frame time (below). |

Where the controls are: A / B / C / D and the D-pad are on the tray (front). The push bar and the in-app wheel are on the top edge (`top` shot). The system wheel and the mic are on the left side (`wheel` shot). What each one does is in `device-controls.md`.

### 3. The recorder

For finished stills and video. It runs a headless browser, so it needs the app running (`pnpm dev`).

```sh
# One still (3840×2160 by default)
pnpm --filter device studio frame --shot hero --out renders/studio/hero.png
pnpm --filter device studio frame --shot screen --backdrop none      # transparent PNG

# A video of a scenario
pnpm --filter device studio record apps/device/studio/scenarios/tour.ts --draft   # quick look
pnpm --filter device studio record apps/device/studio/scenarios/tour.ts           # 1920×1080, 30 fps
pnpm --filter device studio record my-scenario.ts --scale 2 --fps 60              # 4K, 60 fps
```

`--help` lists every option. Output goes to `renders/studio/` unless `--out` says otherwise.

A scenario is a TypeScript file. Each line takes a known amount of film time:

```ts
import type { Stage } from "../stage";

export default async function demo(s: Stage) {
  await s.shot("hero");                       // cut to a shot
  await s.wait(1);                            // one second passes
  await s.turn("appWheel", 2);                // two clicks, then half a second
  await s.press("a");                         // press A, then half a second
  await s.shot("screen", 1.2);                // move the camera over 1.2 s
  await s.say("Remind me to call the bank");  // hold the mic and speak
  await s.until("Suggestion");                // roll until the screen says so
  await s.click("a");                         // a real mouse click on the model
  await s.orbit(0.25, 3, { wait: false });    // start a move and carry on during it
  await s.press("pushBar");
}
```

`Stage` (`apps/device/studio/stage.ts`) has the full list: `wait`, `cut`, `until`, `press`, `turn`, `say`, `click`, `scroll`, `camera`, `shot`, `orbit`, `tray`, `kickstand`, `power`, `dock`, `backdrop`, `rings`, `captions`, `state`, `still`, and `page` (the Playwright page) for anything else. `apps/device/studio/scenarios/tour.ts` is a working example.

Work like this: look at `await s.state()` (or a `--draft` take) to learn what the screen shows after each step, then write the next step.

### How a take is recorded

The recorder freezes the page's clock (`studio.clock`). For each frame it steps time by one frame, lets the page draw, and takes a picture. Timers, animation frames, CSS animations and transitions all follow that clock, so the video is smooth and the same script gives the same take, however slow the machine is.

- The server does not follow the clock. Agent work that takes ten real seconds may pass in one second of film. Use `s.until(...)` to wait for a result, and `s.cut(seconds)` to wait without filming.
- Without a GPU it is slow: a frame takes 1 to 2 s, so one second of film takes about 20 s as a draft and about a minute at full quality. Use `--draft` while writing a scenario, and film the final take once. On a machine with a GPU, add `--headed`.
- The browser is the Chromium that Playwright installs. If it is missing: `pnpm --filter device exec playwright-core install chromium`.
