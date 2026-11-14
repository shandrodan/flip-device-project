// The studio clock. Real time by default. Frozen, time only moves when someone calls step(),
// so a recorder can take one picture per step and get a video with no dropped frames, however
// slow the machine is. It drives timers, animation frames, Date.now, performance.now and every
// CSS animation and transition on the page.
//
// Loaded only in studio mode, before anything else, so no module keeps a reference to the
// real timers.

interface Timer { id: number; fn: () => void; due: number; every: number | null; real: number | null }

const real = {
  setTimeout: window.setTimeout.bind(window),
  clearTimeout: window.clearTimeout.bind(window),
  raf: window.requestAnimationFrame.bind(window),
  caf: window.cancelAnimationFrame.bind(window),
  perfNow: performance.now.bind(performance),
  dateNow: Date.now.bind(Date),
};

let installed = false;
let frozen = false;
/** Frozen: the time on the clock. */
let at = 0;
/** How far the clock is behind real time, after time spent frozen. Keeps time moving forward. */
let lag = 0;
/** Wall clock minus the performance clock, fixed at load. */
const epoch = real.dateNow() - real.perfNow();
let seq = 0;
const timers = new Map<number, Timer>();
const frames = new Map<number, { fn: FrameRequestCallback; real: number | null }>();
/** CSS animations already under the clock's control. */
const seen = new WeakSet<Animation>();

const now = () => (frozen ? at : real.perfNow() - lag);

function armReal(t: Timer) {
  t.real = real.setTimeout(() => {
    t.real = null;
    if (t.every === null) timers.delete(t.id);
    else { t.due = now() + t.every; armReal(t); }
    t.fn();
  }, Math.max(0, t.due - now()));
}

function addTimer(fn: TimerHandler, delay: number | undefined, every: boolean, args: unknown[]) {
  const ms = Math.max(0, Number(delay) || 0);
  const call = typeof fn === "function" ? () => (fn as (...a: unknown[]) => void)(...args) : () => { (0, eval)(String(fn)); };
  const t: Timer = { id: ++seq, fn: call, due: now() + ms, every: every ? Math.max(1, ms) : null, real: null };
  timers.set(t.id, t);
  if (!frozen) armReal(t);
  return t.id;
}

function dropTimer(id: number | undefined) {
  const t = id === undefined ? undefined : timers.get(id);
  if (!t) return;
  if (t.real !== null) real.clearTimeout(t.real);
  timers.delete(t.id);
}

function addFrame(fn: FrameRequestCallback) {
  const id = ++seq;
  const f = { fn, real: null as number | null };
  frames.set(id, f);
  if (!frozen) f.real = real.raf(() => { frames.delete(id); fn(now()); });
  return id;
}

function dropFrame(id: number) {
  const f = frames.get(id);
  if (!f) return;
  if (f.real !== null) real.caf(f.real);
  frames.delete(id);
}

/** Take over every CSS animation that started since the last look. New ones wait at their start. */
function holdAnimations(advance: number) {
  for (const a of document.getAnimations()) {
    if (!seen.has(a)) {
      seen.add(a);
      a.pause();
      // A negative time is a start delay still running; keep it.
      a.currentTime = Math.min(0, Number(a.currentTime) || 0);
      continue;
    }
    if (!advance || a.playState !== "paused") continue;
    const t = (Number(a.currentTime) || 0) + advance * a.playbackRate;
    const end = a.effect?.getComputedTiming().endTime;
    if (typeof end === "number" && Number.isFinite(end) && t >= end) a.finish(); // fires transitionend / animationend
    else a.currentTime = t;
  }
}
const onAnimation = () => { if (frozen) holdAnimations(0); };

/** A real moment for the page to settle: React commits and the browser paints. */
const settle = () => new Promise<void>(done => {
  const ch = new MessageChannel();
  ch.port1.onmessage = () => real.raf(() => real.raf(() => done()));
  ch.port2.postMessage(0);
});

function install() {
  if (installed) return;
  installed = true;
  const w = window as unknown as Record<string, unknown>;
  w.setTimeout = (fn: TimerHandler, ms?: number, ...args: unknown[]) => addTimer(fn, ms, false, args);
  w.setInterval = (fn: TimerHandler, ms?: number, ...args: unknown[]) => addTimer(fn, ms, true, args);
  w.clearTimeout = dropTimer;
  w.clearInterval = dropTimer;
  w.requestAnimationFrame = addFrame;
  w.cancelAnimationFrame = dropFrame;
  performance.now = now;
  Date.now = () => Math.round(epoch + now());
  for (const type of ["transitionrun", "animationstart"]) document.addEventListener(type, onAnimation, true);
}

export const clock = {
  install,
  now,
  get frozen() { return frozen; },

  /** Stop time. Nothing moves until step(). */
  freeze() {
    install();
    if (frozen) return;
    at = now();
    frozen = true;
    for (const t of timers.values()) if (t.real !== null) { real.clearTimeout(t.real); t.real = null; }
    for (const f of frames.values()) if (f.real !== null) { real.caf(f.real); f.real = null; }
    holdAnimations(0);
  },

  /** Move time forward by `ms` and draw one frame. Resolves once the page has painted it. */
  async step(ms: number) {
    if (!frozen) throw new Error("studio.clock.step: freeze the clock first");
    const end = at + ms;
    holdAnimations(ms);
    // Timers run in the order they fall due, each seeing its own time.
    for (let guard = 0; guard < 10000; guard++) {
      let next: Timer | undefined;
      for (const t of timers.values()) if (t.due <= end && (!next || t.due < next.due || (t.due === next.due && t.id < next.id))) next = t;
      if (!next) break;
      at = Math.max(at, next.due);
      if (next.every === null) timers.delete(next.id);
      else next.due += next.every;
      try { next.fn(); } catch (e) { console.error(e); }
    }
    at = end;
    await settle(); // let messages and React updates from those timers land before the frame
    const run = [...frames.values()];
    frames.clear();
    for (const f of run) { try { f.fn(at); } catch (e) { console.error(e); } }
    await settle();
    holdAnimations(0);
  },

  /** Back to real time. */
  resume() {
    if (!frozen) return;
    lag = real.perfNow() - at;
    frozen = false;
    for (const t of timers.values()) armReal(t);
    for (const [id, f] of frames) f.real = real.raf(() => { frames.delete(id); f.fn(now()); });
    for (const a of document.getAnimations()) if (seen.has(a) && a.playState === "paused") a.play();
  },
};
