import { useEffect, useRef, useState } from "react";
import { useControls } from "../../input/controls";
import { net } from "../../net/client";
import { useApp } from "../context";
import { AgentBot, Ico, moodFor, statusChip } from "../ui";
import { AgentPicker } from "./Todo";

export function TaskView({ id }: { id: string }) {
  const { snap, back, go, online } = useApp();
  const t = snap.tasks.find(x => x.id === id);
  const [picking, setPicking] = useState(false);
  const [scroll, setScroll] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const ag = t ? snap.agents.find(a => a.id === t.agentId) : undefined;

  // Follow the newest step.
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [t?.steps.length]);
  useEffect(() => { if (box.current) box.current.scrollTop += scroll * 40; }, [scroll]);

  const s = t?.status;
  useControls(e => {
    if (!t) return false;
    if (e.c === "appWheel" || e.c === "up" || e.c === "down") { setScroll(x => x + (e.c === "up" ? -1 : e.c === "down" ? 1 : e.dir || 0)); return true; }
    if (e.c === "a") {
      if (s === "held" || s === "paused" || s === "failed") net.send({ type: "task.resume", taskId: t.id });
      else if (s === "done") { back(); go("home"); }
      else return false;
      return true;
    }
    if (e.c === "x" && (s === "todo" || s === "paused" || s === "failed")) { setPicking(true); return true; }
    if (e.c === "y" && ["running", "held", "paused", "awaiting-approval", "failed"].includes(s!) && t.agentId) { net.send({ type: "task.cancel", taskId: t.id }); return true; }
    if (e.c === "pushBar" && s === "todo") { net.send({ type: "task.complete", taskId: t.id }); back(); return true; }
    return false;
  }, t ? {
    a: s === "held" ? "Review again" : s === "paused" || s === "failed" ? "Try again" : s === "done" ? "Home" : undefined,
    x: s === "todo" ? "Hand to agent" : s === "paused" || s === "failed" ? "Other agent" : undefined,
    y: t.agentId && ["running", "held", "paused", "awaiting-approval", "failed"].includes(s!) ? "Stop, keep as todo" : undefined,
    push: s === "todo" ? "Done" : undefined,
    wheel: t.steps.length > 6 ? "Scroll" : undefined,
  } : null);

  if (!t) return <div className="scr"><p className="say">That task is gone.</p></div>;
  return <div className="scr">
    {ag && <div style={{ position: "absolute", left: 20, top: 96 }}><AgentBot agent={ag} size={220} state={moodFor(t)} /></div>}
    <div style={{ position: "absolute", left: ag ? 286 : 28, right: 28, top: 52, bottom: 40, display: "flex", flexDirection: "column" }}>
      <div className="label in" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center" }}>{ag ? ag.name : "Todo"} {statusChip(t, snap)}{!online && s === "running" && <span className="chip warn">waiting for connection</span>}</div>
      <p className="say in" style={{ fontSize: t.title.length > 40 ? 24 : 28, marginTop: 6 }}>{t.title}</p>
      <div ref={box} className="scroll in in-2" style={{ marginTop: 12, flex: 1, minHeight: 0 }}>
        {t.steps.map(st => {
          const now = st.state === "running" || st.state === "asking";
          const color = st.state === "failed" || st.state === "declined" ? "#ff8a80" : st.state === "done" ? "rgba(235,235,245,0.7)" : st.state === "asking" ? "#ff9a4d" : "#fff";
          return <div key={st.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: "5px 0", fontSize: 15, color }}>
            <span className={"check" + (st.state === "done" ? " on" : "")} style={{ width: 18, height: 18, borderColor: now ? "currentColor" : undefined }}>{st.state === "done" && Ico.check(10)}</span>
            <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{st.text}</span>
            {st.state === "asking" && <span className="chip warn">{st.risk ? "asks first" : "your press"}</span>}
          </div>;
        })}
        {!t.steps.length && !t.agentId && <p className="mute" style={{ margin: 0 }}>A plain todo. Press the push bar when it’s done, or hand it to an agent with X.</p>}
        {t.detail && <p style={{ margin: "12px 0 0", fontSize: 15.5, lineHeight: 1.45, color: s === "failed" ? "#ff8a80" : s === "done" ? "#fff" : "rgba(235,235,245,0.7)" }}>{t.detail}</p>}
        {t.result && <p className="mute" style={{ margin: "10px 0 0", fontSize: 14, lineHeight: 1.5, whiteSpace: "pre-line" }}>{t.result}</p>}
      </div>
    </div>
    {picking && <AgentPicker onPick={agentId => { setPicking(false); net.send({ type: "task.assign", taskId: t.id, agentId }); }} onClose={() => setPicking(false)} />}
  </div>;
}
