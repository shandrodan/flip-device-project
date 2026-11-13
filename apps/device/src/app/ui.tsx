import { useEffect, useState, type ReactNode } from "react";
import type { Agent, Snapshot, Task } from "@app/protocol";
import { Bot, type BotState } from "../bot/Bot";
import { useActiveHints, type Hints } from "../input/controls";
import {
  AdjustmentsHorizontalIcon, ArrowPathIcon, ArrowRightIcon, CheckCircleIcon, ClockIcon, ComputerDesktopIcon,
  CheckIcon, DocumentIcon, DocumentTextIcon, MicrophoneIcon, PaperClipIcon, PlusIcon, UserGroupIcon,
} from "@heroicons/react/20/solid";

// All icons come from the Heroicons Mini set (20px solid).
const ico = (C: typeof DocumentTextIcon, s: number) => <C width={s} height={s} aria-hidden="true" />;
export const Ico = {
  notes: ico(DocumentTextIcon, 22),
  tasks: ico(CheckCircleIcon, 22),
  agents: ico(UserGroupIcon, 22),
  focus: ico(ClockIcon, 22),
  settings: ico(AdjustmentsHorizontalIcon, 22),
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

export const AgentBot = ({ agent, size, state = "idle", fps, morphFrom, eyesOnly }: { agent: Agent; size: number; state?: BotState; fps?: number; morphFrom?: Agent["shape"]; eyesOnly?: boolean }) => (
  <Bot shape={agent.shape} color={agent.color} seed={agent.seed} size={size} state={state} fps={fps || (size < 90 ? 30 : 60)} morphFrom={morphFrom} eyesOnly={eyesOnly} />
);

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
  k === "wheel" ? <i className="g g-wheel"><ArrowPathIcon width={11} height={11} aria-hidden="true" /></i> :
  k === "dpad" ? <i className="g g-dpad"><PlusIcon width={12} height={12} aria-hidden="true" /></i> :
  <i className={`g ${k}`}>{k.toUpperCase()}</i>;

export function HintBar({ ink }: { ink?: boolean }) {
  const h = useActiveHints();
  const right: (keyof Hints)[] = ["push", "c", "d", "b", "a"];
  const item = (k: keyof Hints) => h[k] ? <span className="hint" key={k}><Glyph k={k} />{h[k]}</span> : null;
  // Wheel and D-pad often do the same thing: one label, two glyphs.
  const same = h.wheel && h.dpad && h.wheel === h.dpad;
  return <div className={"hints" + (ink ? " ink" : "")}>
    {item("mic")}
    {same ? <span className="hint"><Glyph k="wheel" /><Glyph k="dpad" />{h.wheel}</span> : <>{item("wheel")}{item("dpad")}</>}
    <span className="grow" />{right.map(item)}
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
