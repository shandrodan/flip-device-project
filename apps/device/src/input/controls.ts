// Physical controls (device-controls.md). The screen is not touch: everything goes through here.
// Sources: the simulator's drawn hardware, the keyboard, the mouse wheel and a gamepad.
// Real firmware would feed the same events from GPIO.
import { useEffect, useRef, useSyncExternalStore } from "react";

export type Control =
  | "systemWheel" // rotate only: switch functions
  | "appWheel" // rotate: browse inside a function
  | "appWheelPress" // reserved, apps may use it
  | "pushBar" // press only: the approval press, start/stop focus, complete a todo
  | "mic" // hold to record
  | "a" | "b" | "c" | "d"
  | "up" | "down" | "left" | "right";

export interface ControlEvent {
  c: Control;
  /** Wheels: -1 = up/back, +1 = down/forward. */
  dir?: 1 | -1;
  /** Mic only: down when pressed, up when released. Other buttons fire on press. */
  phase?: "down" | "up";
}

export interface Hints {
  a?: string;
  b?: string;
  c?: string;
  d?: string;
  push?: string;
  mic?: string;
  /** The in-app wheel. */
  wheel?: string;
  /** The system wheel. */
  sys?: string;
  dpad?: string;
}

/** Controls next to the screen: prompted with a glow on the screen edge they sit behind (EdgeCues). */
export const EDGE_KEYS = ["push", "wheel", "sys", "mic"] as const;
export type EdgeKey = typeof EDGE_KEYS[number];
/** What a screen passes to useControls. `cue` lists the controls beside the screen that are
 *  clearly the next thing to do here, so they glow on the screen edge. Approvals and talk glow
 *  whatever they list. Once the user has used a glowing control for a prompt, that prompt
 *  stops glowing for the session: they know where the control is now. */
export type HintSpec = Hints & { cue?: EdgeKey[] };
/** Controls on the tray, far below the screen: prompted in the hint bar. */
export const TRAY_KEYS = ["a", "b", "c", "d", "dpad"] as const;

type Handler = (e: ControlEvent) => boolean | void;
interface Entry { id: number; layer: number; handler: { current: Handler }; hints: { current: HintSpec | null }; }

/** Who gets a control first: higher layers win, then the most recently mounted. */
export const LAYER = { global: 0, screen: 1, sheet: 2, approval: 3, talk: 4 } as const;
const ordered = () => [...stack].sort((a, b) => b.layer - a.layer || b.id - a.id);

let seq = 0;
const stack: Entry[] = [];
let hintVersion = 0;
const hintSubs = new Set<() => void>();
const pressSubs = new Set<(e: ControlEvent) => void>();

/** Prompts the user has already answered with the control: "push:Start", "mic:Hold to dictate". */
const learned = new Set<string>();
const EDGE_OF: Partial<Record<Control, EdgeKey>> = { pushBar: "push", appWheel: "wheel", appWheelPress: "wheel", systemWheel: "sys", mic: "mic" };

function bumpHints() {
  hintVersion++;
  for (const s of hintSubs) s();
}

/* ------------------------------ Haptics ------------------------------ */
let audio: AudioContext | null = null;
function click(strong: boolean) {
  try {
    navigator.vibrate?.(strong ? 22 : 6);
  } catch { /* not supported */ }
  if (!strong) return;
  try {
    audio = audio || new AudioContext();
    const t = audio.currentTime, o = audio.createOscillator(), g = audio.createGain();
    o.type = "square";
    o.frequency.setValueAtTime(1800, t);
    o.frequency.exponentialRampToValueAtTime(400, t + 0.03);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(audio.destination);
    o.start(t);
    o.stop(t + 0.06);
  } catch { /* no audio */ }
}

/* ------------------------------ Dispatch ------------------------------ */
export function emit(e: ControlEvent) {
  for (const s of pressSubs) s(e);
  const k = EDGE_OF[e.c];
  if (k && e.phase !== "up") {
    const now = collect();
    if (now.cued.has(k) && !now.urgent.has(k)) { learned.add(`${k}:${now.out[k]}`); bumpHints(); }
  }
  if (e.c === "pushBar") click(true);
  else if (e.phase !== "up") click(false);
  for (const entry of ordered()) {
    if (entry.handler.current(e) === true) return;
  }
}

/** For the simulator: light up the drawn control that was pressed. */
export function onPress(fn: (e: ControlEvent) => void) {
  pressSubs.add(fn);
  return () => { pressSubs.delete(fn); };
}

/**
 * Register a control handler (topmost mounted wins). Return true when handled.
 * `hints` tell the hint bar what A/B/C/D and the push bar do right now (device-controls.md).
 */
export function useControls(handler: Handler, hints: HintSpec | null = null, active = true, layer: number = LAYER.screen) {
  const h = useRef(handler);
  h.current = handler;
  const hr = useRef<HintSpec | null>(hints);
  const key = JSON.stringify(hints);
  useEffect(() => {
    hr.current = hints;
    bumpHints();
  }, [key]);
  useEffect(() => {
    if (!active) return;
    const entry: Entry = { id: ++seq, layer, handler: h, hints: hr };
    stack.push(entry);
    bumpHints();
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
      bumpHints();
    };
  }, [active]);
}

/** The hints in force right now. `cued`: edge controls that should glow (EdgeCues).
 *  `urgent`: hints from an approval or talk layer, which breathe and keep their label. */
export function useActiveHints(): Hints & { urgent?: Set<keyof Hints>; cued?: Set<keyof Hints> } {
  useSyncExternalStore(
    fn => { hintSubs.add(fn); return () => hintSubs.delete(fn); },
    () => hintVersion,
  );
  const { out, urgent, cued } = collect();
  return Object.assign(out, { urgent, cued });
}

/** What each control does right now (the studio reads this outside React). */
export function activeHints(): Hints {
  return collect().out;
}

function collect() {
  // Hints merge downwards: a screen's hints sit on top of the global ones (mic, wheel, back).
  const out: Hints = {};
  const urgent = new Set<keyof Hints>(), cued = new Set<keyof Hints>();
  for (const e of ordered()) {
    const h = e.hints.current;
    if (!h) continue;
    for (const k of Object.keys(h) as (keyof Hints)[]) if (k !== ("cue" as string) && !(k in out)) {
      out[k] = h[k];
      if (e.layer >= LAYER.approval) urgent.add(k);
      if (e.layer >= LAYER.approval || (h.cue?.includes(k as EdgeKey) && !learned.has(`${k}:${h[k]}`))) cued.add(k);
    }
    if (e.layer >= LAYER.approval) break; // approvals and talk own the whole bar
  }
  for (const k of Object.keys(out) as (keyof Hints)[]) if (!out[k]) delete out[k];
  return { out, urgent, cued };
}

/* ------------------------------ Tray ------------------------------ */
// The Device is a slider. Slid closed, the screen covers the tray's D-pad and A–D buttons; the
// push bar and in-app wheel sit on the top edge either way, the system wheel on the left edge
// (upper third closed, lower third open). Real firmware would read this from a hall sensor.
let trayOpen = true;
const traySubs = new Set<() => void>();
export function setTrayOpen(open: boolean) {
  if (open === trayOpen) return;
  trayOpen = open;
  for (const s of traySubs) s();
  bumpHints();
}
export function useTrayOpen() {
  return useSyncExternalStore(fn => { traySubs.add(fn); return () => traySubs.delete(fn); }, () => trayOpen);
}

/* ------------------------------ Mouse wheel ------------------------------ */
/** Turn mouse-wheel deltas into wheel clicks. */
export function wheelHandler(c: "systemWheel" | "appWheel") {
  let acc = 0, last = 0;
  return (ev: { deltaY: number; preventDefault(): void }) => {
    ev.preventDefault();
    const now = performance.now();
    if (now - last > 250) acc = 0;
    last = now;
    acc += ev.deltaY;
    while (Math.abs(acc) >= 40) {
      emit({ c, dir: acc > 0 ? 1 : -1 });
      acc -= Math.sign(acc) * 40;
    }
  };
}

/* ------------------------------ Keyboard ------------------------------ */
// Space hold = mic · Enter = push bar · K/L/I/J = A/B/C/D · arrows = D-pad
// Q/E = system wheel · W/S = in-app wheel · D = in-app wheel press · Esc/Backspace = B
export const KEYMAP: Record<string, ControlEvent> = {
  Enter: { c: "pushBar" },
  KeyK: { c: "a" }, KeyL: { c: "b" }, KeyI: { c: "c" }, KeyJ: { c: "d" },
  Escape: { c: "b" }, Backspace: { c: "b" },
  ArrowUp: { c: "up" }, ArrowDown: { c: "down" }, ArrowLeft: { c: "left" }, ArrowRight: { c: "right" },
  KeyQ: { c: "systemWheel", dir: -1 }, KeyE: { c: "systemWheel", dir: 1 },
  KeyW: { c: "appWheel", dir: -1 }, KeyS: { c: "appWheel", dir: 1 }, KeyD: { c: "appWheelPress" },
};

let installed = false;
export function installInputs() {
  if (installed) return;
  installed = true;
  let micDown = false;
  window.addEventListener("keydown", e => {
    if ((e.target as HTMLElement)?.closest?.("input, textarea, select")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!micDown) { micDown = true; emit({ c: "mic", phase: "down" }); }
      return;
    }
    const m = KEYMAP[e.code];
    if (!m) return;
    e.preventDefault();
    if (e.repeat && !m.c.endsWith("Wheel") && !["up", "down", "left", "right"].includes(m.c)) return;
    emit({ ...m });
  });
  window.addEventListener("keyup", e => {
    if (e.code === "Space" && micDown) { micDown = false; emit({ c: "mic", phase: "up" }); }
  });
  window.addEventListener("blur", () => {
    if (micDown) { micDown = false; emit({ c: "mic", phase: "up" }); }
  });
  installGamepad();
}

/* ------------------------------ Gamepad ------------------------------ */
// Standard mapping (Xbox layout, same as the Device): A B X Y, D-pad, LB/RB = system wheel,
// LT/RT = in-app wheel, right stick click = wheel press, Start = push bar, hold View = mic.
const PAD: Record<number, ControlEvent> = {
  0: { c: "a" }, 1: { c: "b" }, 2: { c: "d" }, 3: { c: "c" },
  4: { c: "systemWheel", dir: -1 }, 5: { c: "systemWheel", dir: 1 },
  6: { c: "appWheel", dir: -1 }, 7: { c: "appWheel", dir: 1 },
  11: { c: "appWheelPress" }, 9: { c: "pushBar" },
  12: { c: "up" }, 13: { c: "down" }, 14: { c: "left" }, 15: { c: "right" },
};
function installGamepad() {
  const prev: Record<string, boolean> = {};
  let running = false;
  const poll = () => {
    const pads = navigator.getGamepads?.() || [];
    let any = false;
    for (const p of pads) {
      if (!p) continue;
      any = true;
      p.buttons.forEach((b, i) => {
        const k = `${p.index}:${i}`, down = b.pressed || b.value > 0.5;
        if (down && !prev[k]) {
          if (i === 8) emit({ c: "mic", phase: "down" });
          else if (PAD[i]) emit({ ...PAD[i] });
        } else if (!down && prev[k] && i === 8) emit({ c: "mic", phase: "up" });
        prev[k] = down;
      });
    }
    if (any) requestAnimationFrame(poll);
    else running = false;
  };
  window.addEventListener("gamepadconnected", () => {
    if (!running) { running = true; requestAnimationFrame(poll); }
  });
}

/* ------------------------------ List navigation ------------------------------ */
/**
 * Move an index with the D-pad (up/down) and/or the in-app wheel.
 * The in-app wheel always cycles: past the last option it comes back to the first, and the
 * other way round, so it never hits an end. The D-pad stops at the edges unless `wrap` is set.
 */
export function step(i: number, e: ControlEvent, count: number, opts: { wheel?: boolean; dpad?: "vertical" | "horizontal" | "grid"; cols?: number; wrap?: boolean } = {}) {
  const { wheel = true, dpad = "vertical", cols = 1 } = opts;
  const wrap = opts.wrap || e.c === "appWheel";
  if (count <= 0) return null;
  let d = 0;
  if (wheel && e.c === "appWheel") d = e.dir || 0;
  else if (dpad === "vertical" && (e.c === "up" || e.c === "down")) d = e.c === "up" ? -1 : 1;
  else if (dpad === "horizontal" && (e.c === "left" || e.c === "right")) d = e.c === "left" ? -1 : 1;
  else if (dpad === "grid") {
    if (e.c === "left") d = -1;
    else if (e.c === "right") d = 1;
    else if (e.c === "up") d = -cols;
    else if (e.c === "down") d = cols;
  }
  if (!d) return null;
  let n = i + d;
  if (wrap) n = ((n % count) + count) % count;
  else n = Math.max(0, Math.min(count - 1, n));
  return n;
}
