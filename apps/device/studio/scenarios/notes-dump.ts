// A Dump in under 7 seconds: the Device turns on, Notes opens, a thought is spoken and saved.
//   pnpm --filter device studio record studio/scenarios/notes-dump.ts
// Start the server on an empty data folder so the Dump lands as a new note.
import type { Stage, ScenarioOptions } from "../stage";

export const options: ScenarioOptions = { fps: 30, size: "1920x1080" };

export default async function notesDump(s: Stage) {
  // Dark screen, then on. Bring the camera in to the screen while it wakes.
  await s.shot("hero");
  await s.power(false, 0.6);
  await s.click("power", { after: 0 }); // a real press on the power button, so it shows

  await s.shot("screen", 1.1, { ease: "inOut" });

  // Home has Notes selected: A opens it.
  await s.press("a", { after: 0.5 });

  // Hold the mic and dump a thought.
  await s.say("Remind me to send the demo video to the team tomorrow", { after: 0 });

  // The main agent files it (its thinking steps run on the film clock, so they roll), then hold on the saved note.
  // Done when the result is up: "Saved as" a new note, or added to one.
  await s.until(() => (window as unknown as { studio: { state(): { hints: { mic?: string } } } }).studio.state().hints.mic === "Hold to talk again");
  await s.wait(1.4);
}
