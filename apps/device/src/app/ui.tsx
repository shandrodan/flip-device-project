import { useEffect, useState, type ReactNode } from "react";
import { useApp } from "./context";
import { AppGlyph, appOfBot, botColor, type Tone } from "./tone";
import type { Agent, Snapshot, Task } from "@app/protocol";
import { Bot, type BotState } from "../bot/Bot";
import { EDGE_KEYS, TRAY_KEYS, onPress, useActiveHints, useTrayOpen, type EdgeKey, type Hints } from "../input/controls";
import {
  ArrowLeftIcon, ArrowPathIcon, ArrowRightIcon, ArrowUpIcon, ComputerDesktopIcon,
  CheckIcon, DocumentIcon, DocumentTextIcon, MicrophoneIcon, PaperClipIcon, PlusIcon,
} from "@heroicons/react/20/solid";

// App icons are our own glyphs (tone.tsx); the rest come from the Heroicons Mini set (20px solid).
const ico = (C: typeof DocumentTextIcon, s: number) => <C width={s} height={s} aria-hidden="true" />;
export const Ico = {
  notes: <AppGlyph fn="notes" />,
  tasks: <AppGlyph fn="todo" />,
  build: <AppGlyph fn="build" />,
  agents: <AppGlyph fn="agents" />,
  focus: <AppGlyph fn="focus" />,
  settings: <AppGlyph fn="settings" />,
  dock: ico(ComputerDesktopIcon, 22),
  mic: (s = 16) => <MicrophoneIcon width={s} height={s} aria-hidden="true" />,
  check: (s = 12) => <CheckIcon width={s} height={s} aria-hidden="true" />,
  arrow: ico(ArrowRightIcon, 16),
  plus: ico(PlusIcon, 26),
  clip: ico(PaperClipIcon, 14),
  laptop: ico(ComputerDesktopIcon, 18),
  file: ico(DocumentIcon, 14),
};

export const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
export const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 6e4);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 24 * 60 ? `${Math.round(m / 60)}h` : m < 48 * 60 ? "Yesterday" : `${Math.round(m / 1440)}d`;
};

/** Re-render every `ms` (for clocks and countdowns). */
export function useTick(ms = 1000) {
  const [, set] = useState(0);
  useEffect(() => { const id = setInterval(() => set(x => x + 1), ms); return () => clearInterval(id); }, [ms]);
}

export const ACTIVE = ["queued", "running", "waiting", "awaiting-approval", "held", "paused"];

export function moodFor(t: Task | undefined): BotState {
  if (!t) return "idle";
  return ({ queued: "wide", running: "think", waiting: "wide", "awaiting-approval": "warn", held: "wide", paused: "sad", failed: "sad", done: "happy" } as Record<string, BotState>)[t.status] || "idle";
}

/** A bot linked to an app wears the app's bright colour. Pass `onTone` where it sits on that
 *  bright colour (the Home comb, the flywheel): then it is drawn in the dark one. */
export function AgentBot({ agent, size, state = "idle", fps, morphFrom, eyesOnly, onTone }: { agent: Agent; size: number; state?: BotState; fps?: number; morphFrom?: Agent["shape"]; eyesOnly?: boolean; onTone?: Tone }) {
  const snap = useApp()?.snap;
  const color = onTone ? onTone.ink : botColor(agent, appOfBot(snap, agent.id));
  return <Bot shape={agent.shape} color={color} seed={agent.seed} size={size} state={state} fps={fps || (size < 90 ? 30 : 60)} morphFrom={morphFrom} eyesOnly={eyesOnly} />;
}

export function statusChip(t: Task, snap: Snapshot) {
  const ag = snap.agents.find(a => a.id === t.agentId), who = ag ? ag.name : "You";
  switch (t.status) {
    case "done": return <span className="chip ok">{ag ? who + " · done" : "Done"}</span>;
    case "running": return <span className="chip blue"><i className="dot" />{who} · working</span>;
    case "queued": return <span className="chip blue"><i className="dot" />{who} · queued</span>;
    case "waiting": return <span className="chip blue"><i className="dot" />{who} · waiting for Task agents</span>;
    case "awaiting-approval":
    case "held": return <span className="chip warn"><i className="dot" />{who} · waiting for your press</span>;
    case "paused": return <span className="chip"><i className="dot" />{who} · paused</span>;
    case "failed": return <span className="chip red"><i className="dot" />{who} · didn’t work</span>;
    default: return <span className="chip">{who}</span>;
  }
}

/* ------------------------------ Hint bar ------------------------------ */
export const Glyph = ({ k }: { k: keyof Hints }) =>
  k === "push" ? <i className="g g-push" /> :
  k === "mic" ? <i className="g g-mic">{Ico.mic(10)}</i> :
  k === "wheel" || k === "sys" ? <i className="g g-wheel"><ArrowPathIcon width={11} height={11} aria-hidden="true" /></i> :
  k === "dpad" ? <i className="g g-dpad"><PlusIcon width={12} height={12} aria-hidden="true" /></i> :
  <i className={`g ${k}`}>{k.toUpperCase()}</i>;

/** The D-pad and A–D sit on the tray, far below the screen: they keep a plain bar along the
 *  bottom. Slid closed or docked they are out of reach, so they are not offered at all.
 *  The controls next to the screen are shown by EdgeCues instead. */
export function HintBar({ ink }: { ink?: boolean }) {
  const h = useActiveHints();
  const reach = useTrayOpen() && !useApp()?.docked;
  if (!reach) return null;
  const right: (keyof Hints)[] = ["c", "d", "b", "a"];
  const item = (k: keyof Hints) => h[k] ? <span className="hint" key={k}><Glyph k={k} />{h[k]}</span> : null;
  if (!TRAY_KEYS.some(k => h[k])) return null;
  return <div className={"hints" + (ink ? " ink" : "")}>
    {item("dpad")}
    <span className="grow" />{right.map(item)}
  </div>;
}

/* ------------------------------ Edge cues ------------------------------ */
// Where each control sits around the 784 × 504 screen, seen from the front. Measured on the
// Blender model (web-render/device-handoff): the screen is 121.8 × 78 mm, centred on the housing.
type Edge = { side: "top" | "left"; from: number; to: number };
const SPOT = {
  push: () => ({ side: "top", from: 14, to: 696 }), // the long bar, top edge, left of the wheel
  wheel: () => ({ side: "top", from: 712, to: 768 }), // top edge, near the top-right corner
  sys: (open: boolean) => open ? { side: "left", from: 313, to: 380 } : { side: "left", from: 106, to: 174 }, // rides on the tray
  mic: () => ({ side: "left", from: 299, to: 492 }), // the red bar, lower left edge
} satisfies Record<EdgeKey, (open: boolean) => Edge>;
/** How long a new prompt keeps its label out before only the glow stays. Urgent ones keep it. */
const LABEL_MS = 2600;

/** One glow on the screen edge, at the control it prompts. Screens can also place one
 *  themselves to point at a control, as the first-run guide does. */
export function EdgeCue({ k, label, urgent }: { k: EdgeKey; label?: string; urgent?: boolean }) {
  const open = useTrayOpen();
  const spot = SPOT[k](open);
  const [shown, setShown] = useState(true);
  const [hit, setHit] = useState(0);
  useEffect(() => {
    setShown(true);
    if (urgent) return;
    const t = setTimeout(() => setShown(false), LABEL_MS);
    return () => clearTimeout(t);
  }, [label, urgent, open]);
  // Pressing the control flashes its glow, so the link between the two is felt.
  useEffect(() => onPress(e => {
    const c = e.c === "pushBar" ? "push" : e.c === "appWheel" || e.c === "appWheelPress" ? "wheel" : e.c === "systemWheel" ? "sys" : e.c;
    if (c === k && e.phase !== "up") setHit(Date.now());
  }), [k]);
  useEffect(() => {
    if (!hit) return;
    const t = setTimeout(() => setHit(0), 180);
    return () => clearTimeout(t);
  }, [hit]);
  const top = spot.side === "top";
  const style = top ? { left: spot.from, width: spot.to - spot.from } : { transform: `translateY(${spot.from}px)`, height: spot.to - spot.from };
  const Arrow = top ? ArrowUpIcon : ArrowLeftIcon;
  return <div className={`cue cue-${spot.side} cue-${k}` + (urgent ? " urgent" : "") + (hit ? " hit" : "") + (k === "wheel" ? " end" : "")} style={style} aria-hidden={!label}>
    <i className="cue-glow" />
    {label && <span className={"cue-label" + (shown ? " on" : "")} role="status"><Arrow width={12} height={12} aria-hidden="true" />{label}</span>}
  </div>;
}

/** The prompts for the controls next to the screen: a glow on the edge each one sits behind,
 *  only while that control is clearly the thing to use (see HintSpec.cue). */
export function EdgeCues({ ink }: { ink?: boolean }) {
  const h = useActiveHints();
  return <div className={"cues" + (ink ? " ink" : "")}>
    {EDGE_KEYS.map(k => h[k] && h.cued?.has(k) ? <EdgeCue key={k} k={k} label={h[k]} urgent={h.urgent?.has(k)} /> : null)}
  </div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="mute" style={{ fontSize: 15, padding: "8px 10px" }}>{children}</p>;
}

/** Keep the selected row visible inside a scroll box. */
export function useScrollSel(dep: unknown) {
  useEffect(() => {
    const el = document.querySelector(".screen .sel");
    el?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, [dep]);
}
