// Studio mode: the 3D twin as a film set. One place holds what the set looks like, and
// `window.studio` lets a person in the console or an agent in a browser drive all of it:
// press the controls, move the camera, freeze time, take a frame. See docs/STUDIO.md.
import { useSyncExternalStore } from "react";
import { activeHints, emit, onPress, type ControlEvent } from "../input/controls";
import { net } from "../net/client";
import { queueLine } from "../voice/capture";
import { clock } from "./clock";
import type { Ease, Target, Twin, View } from "./Device3D";

/* ------------------------------ The set ------------------------------ */
export const BACKDROPS = {
  studio: "radial-gradient(120% 95% at 50% 30%, #dcdee1 0%, #c6c9cd 58%, #b2b6bb 100%)",
  white: "radial-gradient(120% 95% at 50% 30%, #ffffff 0%, #f1f2f4 60%, #e3e5e8 100%)",
  black: "radial-gradient(120% 95% at 50% 30%, #33363b 0%, #17181b 60%, #08090a 100%)",
  warm: "radial-gradient(120% 95% at 50% 30%, #f1e9de 0%, #dccfbf 60%, #c4b39f 100%)",
  green: "#00b140", // chroma key
  none: "transparent", // PNG frames keep the alpha
} as const;
export type Backdrop = keyof typeof BACKDROPS;
export const ASPECTS = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5 } as const;
export type Aspect = keyof typeof ASPECTS;

/** A camera position with a name. `open` also slides the tray. */
export type Shot = View & { open?: boolean };
export const SHOTS: Record<string, Shot> = {
  front: { yaw: 0, pitch: 0, zoom: 1, x: 0, y: 0 },
  hero: { yaw: -0.46, pitch: 0.24, zoom: 0.9, x: 0, y: 0 },
  left: { yaw: 0.5, pitch: 0.2, zoom: 0.9, x: 0, y: 0 },
  screen: { yaw: 0, pitch: 0, zoom: 1.4, x: 0, y: 19 },
  controls: { yaw: 0, pitch: 0.3, zoom: 1.7, x: 0, y: -40 },
  top: { yaw: -0.25, pitch: 0.8, zoom: 1.2, x: 0, y: 2 },
  wheel: { yaw: 0.95, pitch: 0.16, zoom: 1.5, x: 0, y: 12 },
  back: { yaw: Math.PI, pitch: 0.12, zoom: 1, x: 0, y: 0 },
  wide: { yaw: -0.3, pitch: 0.18, zoom: 0.6, x: 0, y: 0 },
  closed: { yaw: -0.4, pitch: 0.2, zoom: 1.2, x: 0, y: 0, open: false },
};

export interface StudioState {
  backdrop: Backdrop | string;
  aspect: Aspect;
  /** Mark presses on the model. */
  rings: boolean;
  /** Name each press in a corner of the frame. */
  captions: boolean;
  shadow: boolean;
  /** Tray out, controls showing. */
  open: boolean;
  /** The side panel. Off, the stage fills the window: what a recorder wants. */
  panel: boolean;
  /** Recording since this time, or not. */
  recording: number | null;
  ready: boolean;
}

const query = new URLSearchParams(location.search);
let state: StudioState = {
  backdrop: query.get("backdrop") || "studio",
  aspect: (query.get("aspect") as Aspect) in ASPECTS ? (query.get("aspect") as Aspect) : "16:9",
  rings: query.get("rings") !== "0",
  captions: query.get("captions") === "1",
  shadow: true,
  open: true,
  panel: query.get("panel") !== "0",
  recording: null,
  ready: false,
};
const subs = new Set<() => void>();
export function set(patch: Partial<StudioState>) {
  state = { ...state, ...patch };
  for (const s of subs) s();
}
export const get = () => state;
export function useStudio() {
  return useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn); }, get);
}
export const backdropCss = (b: string) => (BACKDROPS as Record<string, string>)[b] ?? b;
/** A flat key colour or no backdrop takes no shadow. */
export const castsShadow = (s: StudioState) => s.shadow && s.backdrop !== "green" && s.backdrop !== "none";

/* ------------------------------ The twin ------------------------------ */
let twin: Twin | null = null;
let stageEl: HTMLElement | null = null;
let onReady = () => { };
const ready = new Promise<void>(r => { onReady = r; });
export function bind(t: Twin, stage: HTMLElement) {
  twin = t;
  stageEl = stage;
  t.setView(SHOTS[query.get("shot") || ""] || SHOTS.hero);
  set({ ready: true });
  onReady();
}
const need = () => {
  if (!twin) throw new Error("studio: the model is still loading, await studio.ready first");
  return twin;
};
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

type Button = "a" | "b" | "c" | "d" | "up" | "down" | "left" | "right" | "pushBar" | "appWheelPress";
type WheelName = "systemWheel" | "appWheel";
export const BUTTONS: Button[] = ["a", "b", "c", "d", "up", "down", "left", "right", "pushBar", "appWheelPress"];

function camera(v: Partial<Shot>, opts: { duration?: number; ease?: Ease } = {}) {
  const { open, ...view } = v;
  if (typeof open === "boolean") set({ open });
  need().setView(view, opts);
}

/* ------------------------------ Capture in the browser ------------------------------ */
// A person records with the browser's own tab capture, cropped to the stage, so the video has
// both the model (WebGL) and the Device screen (DOM). Agents use the recorder (studio/cli.ts).
let stream: MediaStream | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];

async function tab() {
  if (stream?.active) return stream;
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error("This browser cannot capture a tab. Use Chrome or Edge, or the recorder: pnpm --filter device studio");
  stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: 60, width: { ideal: 3840 }, height: { ideal: 2160 }, cursor: "never" } as MediaTrackConstraints,
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: "include",
  } as DisplayMediaStreamOptions);
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => { stream = null; if (recorder) void stopRecording(); });
  const Crop = (window as unknown as { CropTarget?: { fromElement(el: Element): Promise<unknown> } }).CropTarget;
  if (Crop && stageEl && "cropTo" in track) {
    try { await (track as unknown as { cropTo(t: unknown): Promise<void> }).cropTo(await Crop.fromElement(stageEl)); }
    catch { /* another tab or a window was picked: record it whole */ }
  }
  return stream;
}

function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/** Save what the stage shows right now as a PNG. */
async function frame() {
  const s = await tab();
  const video = document.createElement("video");
  video.srcObject = s;
  video.muted = true;
  await video.play();
  await sleep(250); // the crop takes a few frames to apply
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d")!.drawImage(video, 0, 0);
  video.pause();
  video.srcObject = null;
  const blob = await new Promise<Blob | null>(r => c.toBlob(r, "image/png"));
  if (!blob) throw new Error("studio.frame: nothing to save");
  save(blob, `flip-frame-${stamp()}.png`);
  return { width: c.width, height: c.height };
}

async function startRecording() {
  if (recorder) return;
  const s = await tab();
  const type = ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp9", "video/webm"].find(t => MediaRecorder.isTypeSupported(t)) || "";
  chunks = [];
  recorder = new MediaRecorder(s, { mimeType: type, videoBitsPerSecond: 40_000_000 });
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.start(1000);
  set({ recording: Date.now() });
}

async function stopRecording() {
  const r = recorder;
  if (!r) return;
  recorder = null;
  await new Promise<void>(done => { r.onstop = () => done(); r.stop(); });
  set({ recording: null });
  const type = r.mimeType || "video/webm";
  save(new Blob(chunks, { type }), `flip-take-${stamp()}.${type.includes("mp4") ? "mp4" : "webm"}`);
  chunks = [];
}

/* ------------------------------ window.studio ------------------------------ */
export const studio = {
  /** Resolves when the model is on stage. */
  ready,
  shots: SHOTS,
  buttons: BUTTONS,

  /** Press a button, like a finger would. `times` repeats it. */
  async press(c: Button, opts: { times?: number; interval?: number } = {}) {
    if (!BUTTONS.includes(c)) throw new Error(`studio.press: no button "${c}". Buttons: ${BUTTONS.join(", ")}`);
    for (let i = 0; i < (opts.times || 1); i++) {
      if (i) await sleep(opts.interval ?? 260);
      emit({ c });
    }
  },
  /** Turn a wheel by a number of clicks. Negative turns it back. */
  async turn(wheel: WheelName, clicks = 1, opts: { interval?: number } = {}) {
    if (wheel !== "systemWheel" && wheel !== "appWheel") throw new Error(`studio.turn: no wheel "${wheel}". Wheels: systemWheel, appWheel`);
    for (let i = 0; i < Math.abs(clicks); i++) {
      if (i) await sleep(opts.interval ?? 130);
      emit({ c: wheel, dir: clicks > 0 ? 1 : -1 });
    }
  },
  /** Queue a line for the next mic hold to "speak" (scripted voice, no microphone needed). */
  say(text: string) { queueLine(text); },
  micDown(line?: string) { if (line) queueLine(line); emit({ c: "mic", phase: "down" }); },
  micUp() { emit({ c: "mic", phase: "up" }); },
  /** Hold the mic for `ms`, speaking `line` if given. */
  async hold(ms: number, line?: string) {
    studio.micDown(line);
    await sleep(ms);
    studio.micUp();
  },
  /** Any control event, as the hardware would send it. */
  emit(e: ControlEvent) { emit(e); },

  tray(open = !state.open) { set({ open }); return open; },
  kickstand(out?: boolean) { return need().kickstand(out); },
  power(on?: boolean) { return need().power(on); },
  dock(on = net.mode !== "dock") { net.setMode(on ? "dock" : "handheld"); return on; },

  /** Move the camera: `{ yaw, pitch, zoom, x, y, open }`. A duration in ms makes it travel. */
  camera,
  /** Go to a named shot. */
  shot(name: string, opts: { duration?: number; ease?: Ease } = {}) {
    const s = SHOTS[name];
    if (!s) throw new Error(`studio.shot: no shot "${name}". Shots: ${Object.keys(SHOTS).join(", ")}`);
    camera(s, opts);
  },
  /** Turn the Device around its axis. `turns` may be a fraction or negative. */
  orbit(turns = 1, opts: { duration?: number; ease?: Ease } = {}) {
    const t = need();
    t.setView({ yaw: t.view().yaw + turns * Math.PI * 2 }, { duration: opts.duration ?? 8000, ease: opts.ease ?? "linear" });
  },
  view: () => need().view(),

  backdrop(b: Backdrop | string) { set({ backdrop: b }); },
  aspect(a: Aspect) { if (a in ASPECTS) set({ aspect: a }); },
  rings(on: boolean) { set({ rings: on }); },
  captions(on: boolean) { set({ captions: on }); },
  shadow(on: boolean) { set({ shadow: on }); },
  panel(on: boolean) { set({ panel: on }); },

  /** Where a control is on the page (to click or scroll on it), and whether the camera sees it. */
  locate(t: Target) { return need().locate(t); },
  /** The stage's box on the page: the part of a screenshot that is the picture. */
  stage() {
    const r = stageEl?.getBoundingClientRect();
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  },
  /** Everything an agent needs to know where it is. */
  state() {
    return {
      ...state,
      view: twin?.view() ?? null,
      cameraMoving: twin?.moving() ?? false,
      mode: net.mode,
      conn: net.conn,
      frozen: clock.frozen,
      /** What each control does on the screen that is showing. */
      hints: activeHints(),
      /** The words on the Device screen. */
      screen: (stageEl?.querySelector(".screen") as HTMLElement | null)?.innerText ?? "",
    };
  },

  /** Frame-by-frame time, for recorders: freeze(), then step(ms) once per picture. */
  clock,
  /** Save the stage as a PNG (asks to share this tab the first time). */
  frame,
  record: { start: startRecording, stop: stopRecording },
};
export type Studio = typeof studio;

/** Tell the caption strip what was pressed. */
export function onCaption(fn: (text: string) => void) {
  const NAME: Record<string, string> = {
    a: "A", b: "B", c: "C", d: "D", up: "D-pad ↑", down: "D-pad ↓", left: "D-pad ←", right: "D-pad →",
    pushBar: "Push bar", appWheelPress: "In-app wheel · press",
  };
  return onPress(e => {
    if (e.c === "mic") { if (e.phase === "down") fn("Mic · hold"); return; }
    if (e.c === "systemWheel" || e.c === "appWheel") return fn(`${e.c === "systemWheel" ? "System wheel" : "In-app wheel"} ${e.dir === -1 ? "↺" : "↻"}`);
    fn(NAME[e.c] ?? e.c);
  });
}
