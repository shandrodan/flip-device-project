import { useEffect, useState, type ReactNode } from "react";
import type { Agent, Snapshot, Task } from "@app/protocol";
import { Bot, type BotState } from "../bot/Bot";
import { useActiveHints, type Hints } from "../input/controls";

export const Ico = {
  notes: <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="4" y="3" width="14" height="16" rx="3" /><path d="M8 8h6M8 11.5h6M8 15h3.5" /></svg>,
  tasks: <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m7.5 11.2 2.4 2.4 4.6-5" /></svg>,
  agents: <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="8" cy="12" r="5" /><path d="M14.5 6.5a4 4 0 1 1 1.8 7.5" strokeLinecap="round" /></svg>,
  focus: <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="11" cy="12" r="7.5" /><path d="M11 8.5V12l2.5 1.5M9 2.5h4" /></svg>,
  settings: <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 6h8M16 6h2M4 11h2M10 11h8M4 16h10M18 16h0" /><circle cx="14" cy="6" r="2" /><circle cx="8" cy="11" r="2" /><circle cx="16" cy="16" r="2" /></svg>,
  dock: <svg width="22" height="22" viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><rect x="4" y="4" width="14" height="10" rx="2" /><path d="M7 18h8M11 14v4" /></svg>,
  mic: (s = 16) => <svg width={s} height={s} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5" /></svg>,
  check: (s = 12) => <svg width={s} height={s} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 6.2 5 8.5l4.5-5" /></svg>,
  arrow: <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 8h10M9 4l4 4-4 4" /></svg>,
  plus: <svg width="26" height="26" viewBox="0 0 26 26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M13 6v14M6 13h14" /></svg>,
  clip: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M10.5 4.5 5.8 9.2a1.5 1.5 0 0 0 2.1 2.1l5-5a3 3 0 0 0-4.2-4.2l-5 5a4.5 4.5 0 0 0 6.4 6.4l4-4" /></svg>,
  laptop: <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"><rect x="4" y="4.5" width="12" height="8.5" rx="1.5" /><path d="M2 15.5h16" strokeLinecap="round" /></svg>,
  file: <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></svg>,
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

export const ACTIVE = ["running", "awaiting-approval", "held", "paused"];

export function moodFor(t: Task | undefined): BotState {
  if (!t) return "idle";
  return ({ running: "think", "awaiting-approval": "warn", held: "wide", paused: "sad", failed: "sad", done: "happy" } as Record<string, BotState>)[t.status] || "idle";
}

export const AgentBot = ({ agent, size, state = "idle", fps, morphFrom, eyesOnly }: { agent: Agent; size: number; state?: BotState; fps?: number; morphFrom?: Agent["shape"]; eyesOnly?: boolean }) => (
  <Bot shape={agent.shape} color={agent.color} seed={agent.seed} size={size} state={state} fps={fps || (size < 90 ? 30 : 60)} morphFrom={morphFrom} eyesOnly={eyesOnly} />
);

export function statusChip(t: Task, snap: Snapshot) {
  const ag = snap.agents.find(a => a.id === t.agentId), who = ag ? ag.name : "You";
  switch (t.status) {
    case "done": return <span className="chip ok">{ag ? who + " · done" : "Done"}</span>;
    case "running": return <span className="chip blue"><i className="dot" />{who} · working</span>;
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
  k === "wheel" ? <i className="g g-wheel">◎</i> :
  k === "dpad" ? <i className="g g-dpad">✛</i> :
  <i className={`g ${k}`}>{k.toUpperCase()}</i>;

export function HintBar({ ink }: { ink?: boolean }) {
  const h = useActiveHints();
  const right: (keyof Hints)[] = ["push", "y", "x", "b", "a"];
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
