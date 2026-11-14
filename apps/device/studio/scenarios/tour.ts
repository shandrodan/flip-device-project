// A short tour: the Device arrives, the tray slides out, every control gets used once.
//   pnpm --filter device studio record studio/scenarios/tour.ts
// Copy this file to start your own scenario. See docs/STUDIO.md.
import type { Stage, ScenarioOptions } from "../stage";

export const options: ScenarioOptions = { fps: 30, size: "1920x1080" };

export default async function tour(s: Stage) {
  // Open on the closed Device and bring it round to the front.
  await s.shot("closed");
  await s.wait(0.6);
  await s.shot("hero", 1.6, { wait: false });
  await s.tray(true, 1.8);

  // Browse Home with the in-app wheel and the D-pad.
  await s.turn("appWheel", 3);
  await s.press("right", { times: 2 });
  await s.press("down");

  // Come closer to the controls and open what is selected.
  await s.shot("controls", 1.2);
  await s.press("a", { after: 0.4 });
  await s.shot("screen", 1.2);
  await s.wait(0.8);
  await s.press("b");

  // The system wheel: the app flywheel. It sits on the left side.
  await s.shot("wheel", 1.2);
  await s.turn("systemWheel", 3);
  await s.press("b");

  // The top edge: push bar and in-app wheel.
  await s.shot("top", 1.2);
  await s.press("pushBar");
  await s.turn("appWheel", -2);

  // A dump: hold the mic and talk.
  await s.shot("hero", 1.2);
  await s.say("Remind me to send the demo video to the team tomorrow morning");
  await s.wait(2);

  // Out on a slow turn.
  await s.orbit(-0.12, 2.5, { ease: "inOut" });
}
