// The studio recorder: stills and video of the 3D twin with its live screen, made by a
// headless browser. For agents and scripts; people can also use the Studio page itself.
//
//   pnpm --filter device studio frame  [--shot hero] [--out still.png]
//   pnpm --filter device studio record studio/scenarios/tour.ts [--out take.mp4]
//
// Needs the Device app running (pnpm dev). See docs/STUDIO.md.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { chromium } from "playwright-core";
import { Stage, type Scenario, type ScenarioOptions } from "./stage";
import type { Studio } from "../src/sim/studio";

declare const studio: Studio;

const HELP = `Studio recorder

  studio frame  [options]              one PNG of the Device
  studio record <scenario.ts> [options]  a video of a scenario

Options
  --out <file>        where to save (default: renders/studio/…)
  --url <url>         the Device app (default: http://localhost:5173)
  --size <WxH>        picture size in CSS pixels (default: 1920x1080)
  --scale <n>         pixels per CSS pixel; 2 gives 4K from 1920x1080 (default: 1, frame: 2)
  --fps <n>           frames per second (default: 30)
  --draft             quick look: half size, 15 fps, three to four times faster
  --shot <name>       starting shot: front, hero, left, screen, controls, top, wheel, back, wide, closed
  --backdrop <name>   studio, white, black, warm, green, none (transparent PNG), or any CSS colour
  --no-rings          do not mark presses on the model
  --captions          name each press in the frame
  --onboarding        start on the first-run onboarding instead of Home
  --wait <seconds>    frame only: let the screen settle this long first (default: 1)
  --headed            show the browser window (uses the GPU where there is one)
`;

const { values: flag, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string" }, url: { type: "string" }, size: { type: "string" }, scale: { type: "string" },
    fps: { type: "string" }, shot: { type: "string" }, backdrop: { type: "string" }, wait: { type: "string" },
    "no-rings": { type: "boolean" }, draft: { type: "boolean" }, captions: { type: "boolean" }, onboarding: { type: "boolean" },
    headed: { type: "boolean" }, help: { type: "boolean" },
  },
});
const [command, file] = positionals;
if (flag.help || (command !== "frame" && command !== "record") || (command === "record" && !file)) {
  console.log(HELP);
  process.exit(flag.help ? 0 : 1);
}

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
// pnpm runs scripts from apps/device; paths on the command line are meant from where the person stood.
const from = (p: string) => path.resolve(process.env.INIT_CWD || process.cwd(), p);

const loaded = command === "record" ? await import(pathToFileURL(from(file)).href) as { default: Scenario; options?: ScenarioOptions } : null;
if (loaded && typeof loaded.default !== "function") throw new Error(`${file} must have a default export: async (s: Stage) => { … }`);
const opt = loaded?.options ?? {};

const [width, height] = (flag.size ?? opt.size ?? "1920x1080").split("x").map(Number);
if (!width || !height) throw new Error("--size wants WxH, like 1920x1080");
const scale = flag.draft ? 0.5 : Number(flag.scale ?? opt.scale ?? (command === "frame" ? 2 : 1));
const fps = flag.draft ? 15 : Number(flag.fps ?? opt.fps ?? 30);
const backdrop = flag.backdrop ?? opt.backdrop ?? "studio";
const rings = flag["no-rings"] ? false : opt.rings ?? true;
const captions = flag.captions ?? opt.captions ?? false;
const onboarding = flag.onboarding ?? opt.onboarding ?? false;
const url = (flag.url ?? process.env.STUDIO_URL ?? "http://localhost:5173").replace(/\/$/, "");
const name = file ? path.basename(file).replace(/\.[^.]+$/, "") : flag.shot ?? "hero";
const out = flag.out ? from(flag.out) : path.join(repo, "renders/studio", `${name}${flag.draft ? ".draft" : ""}.${command === "frame" ? "png" : "mp4"}`);
mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch({
  channel: "chromium",
  headless: !flag.headed,
  // Draw with the GPU where there is one, and in software where there is not.
  args: ["--ignore-gpu-blocklist", "--enable-unsafe-swiftshader", "--hide-scrollbars"],
}).catch(e => {
  throw new Error(`Could not start Chromium. Install it once with: pnpm --filter device exec playwright-core install chromium\n${e.message}`);
});

try {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale });
  await context.addInitScript(skip => {
    if (skip) localStorage.setItem("flip-device-onboarding-v1", "done");
    else localStorage.removeItem("flip-device-onboarding-v1");
  }, !onboarding);
  const page = await context.newPage();
  page.on("pageerror", e => console.error("[page]", e.message));
  const q = new URLSearchParams({ studio: "1", panel: "0", backdrop, rings: rings ? "1" : "0", captions: captions ? "1" : "0", shot: flag.shot ?? "hero" });
  await page.goto(`${url}/?${q}`).catch(() => { throw new Error(`Nothing answers at ${url}. Start the app first: pnpm dev`); });
  await page.waitForFunction(() => (window as unknown as { studio?: Studio }).studio?.state().ready, null, { timeout: 120_000 });
  await page.evaluate(() => document.fonts.ready.then(() => { }));
  // Give the server a moment to send the first snapshot, then stop time.
  await page.waitForFunction(() => studio.state().conn !== "connecting", null, { timeout: 10_000 }).catch(() => { });
  await page.evaluate(() => studio.clock.freeze());

  if (command === "frame") {
    const s = new Stage(page, fps, null);
    await s.wait(Number(flag.wait ?? 1));
    await s.still(out);
    console.log(`Saved ${path.relative(process.cwd(), out)} (${width * scale}×${height * scale})`);
  } else {
    const ffmpeg = spawn(process.env.FFMPEG || ffmpegStatic || "ffmpeg", [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-",
      // Even sides, then H.264 that plays everywhere and holds fine text.
      "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p",
      "-movflags", "+faststart", out,
    ], { stdio: ["pipe", "inherit", "inherit"] });
    let failed: Error | null = null;
    ffmpeg.on("error", e => { failed = new Error(`ffmpeg did not start: ${e.message}`); });
    ffmpeg.stdin.on("error", () => { /* reported when ffmpeg exits */ });

    const started = Date.now();
    let frames = 0;
    const stage = new Stage(page, fps, async () => {
      if (failed) throw failed;
      if (!ffmpeg.stdin.write(await page.screenshot({ type: "png" }))) await once(ffmpeg.stdin, "drain");
      if (++frames % fps === 0) process.stdout.write(`\r${(frames / fps).toFixed(0)} s filmed · ${((Date.now() - started) / 1000).toFixed(0)} s spent `);
    });
    let crash: unknown = null;
    try {
      await stage.wait(1 / fps); // the opening frame
      await loaded!.default(stage);
    } catch (e) { crash = e; }
    ffmpeg.stdin.end();
    const [code] = await once(ffmpeg, "close");
    process.stdout.write("\n");
    if (crash) {
      console.error(`The scenario stopped at ${stage.time.toFixed(1)} s. What was filmed until then is in ${path.relative(process.cwd(), out)}.`);
      throw crash;
    }
    if (code !== 0) throw new Error(`ffmpeg failed (exit ${code})`);
    console.log(`Saved ${path.relative(process.cwd(), out)} (${width * scale}×${height * scale}, ${fps} fps, ${(frames / fps).toFixed(1)} s)`);
  }
} finally {
  await browser.close();
}
