// The stage, as a script sees it. A scenario is a list of things that happen on the Device
// and to the camera, each taking a known amount of film time. While a take is being recorded
// the page's clock is frozen and every frame is stepped and photographed, so the video is
// smooth and repeatable on any machine. See docs/STUDIO.md.
import type { Page } from "playwright-core";
import type { Studio } from "../src/sim/studio";
import type { Ease, Target, View } from "../src/sim/Device3D";

declare const studio: Studio; // window.studio, inside page.evaluate

type Button = Studio["buttons"][number];
type Wheel = "systemWheel" | "appWheel";
type Shot = Partial<View> & { open?: boolean };
/** `wait: false` starts the move and returns at once, so other things can happen during it. */
interface Move { ease?: Ease; wait?: boolean }

export type Scenario = (s: Stage) => Promise<void>;
/** A scenario file may export these to set its own defaults. Command-line flags win. */
export interface ScenarioOptions {
  fps?: number;
  /** Picture size in CSS pixels, "1920x1080". */
  size?: string;
  /** Pixels per CSS pixel. 2 turns 1920x1080 into a 3840x2160 video. */
  scale?: number;
  backdrop?: string;
  rings?: boolean;
  captions?: boolean;
  /** Start on the first-run onboarding instead of Home. */
  onboarding?: boolean;
}

export class Stage {
  /** Film time so far, in seconds. */
  time = 0;
  private owed = 0;

  constructor(
    /** The Playwright page, for anything this class does not cover. */
    readonly page: Page,
    readonly fps: number,
    /** Photograph the page: called once per frame while recording. */
    private shoot: (() => Promise<void>) | null,
  ) { }

  /** Let `seconds` of film time pass. */
  async wait(seconds: number) {
    this.owed += seconds * this.fps;
    const frames = Math.round(this.owed);
    this.owed -= frames;
    for (let i = 0; i < frames; i++) {
      await this.page.evaluate(ms => studio.clock.step(ms), 1000 / this.fps);
      this.time += 1 / this.fps;
      await this.shoot?.();
    }
  }

  /** Let real time pass with the film stopped: a cut. For slow agent work that should not be in the video. */
  async cut(seconds: number) {
    await new Promise(r => setTimeout(r, seconds * 1000));
    await this.page.evaluate(() => studio.clock.step(0));
  }

  /**
   * Wait until the Device screen shows `text` (or `test` returns true in the page).
   * Film keeps rolling unless `roll` is false. Fails after `timeout` real seconds.
   */
  async until(test: string | (() => boolean), opts: { timeout?: number; roll?: boolean } = {}) {
    const deadline = Date.now() + (opts.timeout ?? 60) * 1000;
    const check = () => typeof test === "string"
      ? this.page.evaluate(t => studio.state().screen.toLowerCase().includes(t.toLowerCase()), test)
      : this.page.evaluate(test);
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`until: gave up waiting for ${typeof test === "string" ? JSON.stringify(test) : "the test"}. The screen says:\n${(await this.state()).screen}`);
      if (opts.roll === false) await this.cut(0.2);
      else await this.wait(1 / this.fps);
    }
  }

  /** Press a button. Then `after` seconds pass, so the press and its result are seen. */
  async press(button: Button, opts: { times?: number; interval?: number; after?: number } = {}) {
    for (let i = 0; i < (opts.times ?? 1); i++) {
      if (i) await this.wait(opts.interval ?? 0.3);
      await this.page.evaluate(b => { void studio.press(b); }, button);
    }
    await this.wait(opts.after ?? 0.5);
  }

  /** Turn a wheel by `clicks` (negative: back). */
  async turn(wheel: Wheel, clicks = 1, opts: { interval?: number; after?: number } = {}) {
    for (let i = 0; i < Math.abs(clicks); i++) {
      if (i) await this.wait(opts.interval ?? 0.14);
      await this.page.evaluate(([w, d]) => { void studio.turn(w, d); }, [wheel, Math.sign(clicks)] as const);
    }
    await this.wait(opts.after ?? 0.5);
  }

  /** Hold the mic and say `line` (scripted voice). The hold lasts as long as the line takes, or `seconds`. */
  async say(line: string, opts: { seconds?: number; after?: number } = {}) {
    await this.page.evaluate(l => studio.micDown(l), line);
    await this.wait(opts.seconds ?? line.split(" ").length * 0.095 + 0.6);
    await this.page.evaluate(() => studio.micUp());
    await this.wait(opts.after ?? 0.5);
  }

  /** A real mouse click on a control on the model. The camera must see it. */
  async click(target: Target, opts: { hold?: number; after?: number } = {}) {
    const p = await this.aim(target);
    await this.page.mouse.move(p.x, p.y);
    await this.page.mouse.down();
    await this.wait(opts.hold ?? 0.1);
    await this.page.mouse.up();
    await this.wait(opts.after ?? 0.5);
  }

  /** Real mouse-wheel scrolling over a wheel on the model. The camera must see it. */
  async scroll(wheel: Wheel, clicks = 1, opts: { interval?: number; after?: number } = {}) {
    const p = await this.aim(wheel);
    await this.page.mouse.move(p.x, p.y);
    for (let i = 0; i < Math.abs(clicks); i++) {
      if (i) await this.wait(opts.interval ?? 0.14);
      await this.page.mouse.wheel(0, 40 * Math.sign(clicks));
    }
    await this.wait(opts.after ?? 0.5);
  }

  private async aim(target: Target) {
    const p = await this.page.evaluate(t => studio.locate(t), target);
    if (!p) throw new Error(`The model has no "${target}"`);
    if (!p.visible) throw new Error(`The camera cannot see "${target}" from here. Move the camera first, or use press() / turn(), which work from any angle.`);
    return p;
  }

  /** Move the camera over `seconds` (0 or nothing: a cut). */
  async camera(view: Shot, seconds = 0, opts: Move = {}) {
    await this.page.evaluate(([v, d, e]) => studio.camera(v, { duration: d, ease: e }), [view, seconds * 1000, opts.ease] as const);
    await this.wait(opts.wait === false ? 0 : seconds);
  }

  /** Go to a named shot over `seconds` (0 or nothing: a cut). */
  async shot(name: string, seconds = 0, opts: Move = {}) {
    await this.page.evaluate(([n, d, e]) => studio.shot(n, { duration: d, ease: e }), [name, seconds * 1000, opts.ease] as const);
    await this.wait(opts.wait === false ? 0 : seconds);
  }

  /** Turn the Device around: `turns` full turns over `seconds`. */
  async orbit(turns: number, seconds: number, opts: Move = {}) {
    await this.page.evaluate(([t, d, e]) => studio.orbit(t, { duration: d, ease: e }), [turns, seconds * 1000, opts.ease ?? "linear"] as const);
    await this.wait(opts.wait === false ? 0 : seconds);
  }

  /** Slide the tray out or in. It takes about half a second. */
  async tray(open: boolean, after = 0.7) {
    await this.page.evaluate(o => { studio.tray(o); }, open);
    await this.wait(after);
  }
  async kickstand(out: boolean, after = 0.7) {
    await this.page.evaluate(o => { studio.kickstand(o); }, out);
    await this.wait(after);
  }
  async power(on: boolean, after = 0.5) {
    await this.page.evaluate(o => { studio.power(o); }, on);
    await this.wait(after);
  }
  async dock(on: boolean, after = 0.8) {
    await this.page.evaluate(o => { studio.dock(o); }, on);
    await this.wait(after);
  }

  backdrop(b: string) { return this.page.evaluate(x => studio.backdrop(x), b); }
  rings(on: boolean) { return this.page.evaluate(x => studio.rings(x), on); }
  captions(on: boolean) { return this.page.evaluate(x => studio.captions(x), on); }

  /** Where things stand: the view, the words on the Device screen, what each control does now. */
  state() { return this.page.evaluate(() => studio.state()); }

  /** Save the picture as it is now to a PNG, also in the middle of a take. */
  async still(path: string) {
    await this.page.screenshot({ path, omitBackground: true });
  }
}
