import { useState } from "react";
import { useControls, step, LAYER } from "../../input/controls";
import { net } from "../../net/client";
import { useApp } from "../context";
import { AgentBot, Empty, statusChip, useScrollSel } from "../ui";

// device-controls.md, To-Do mode: in-app wheel browses, push bar completes, done tasks disappear.
export function Todo() {
  const { snap, push, toast } = useApp();
  const open = snap.tasks.filter(t => t.status !== "done");
  const doneToday = snap.tasks.filter(t => t.status === "done" && t.completedAt && new Date(t.completedAt).toDateString() === new Date().toDateString()).length;
  const [sel, setSel] = useState(0);
  const [picking, setPicking] = useState<string | null>(null);
  const [leaving, setLeaving] = useState<string | null>(null);
  const i = Math.min(sel, Math.max(0, open.length - 1));
  const cur = open[i];
  useScrollSel(i);

  useControls(e => {
    const n = step(i, e, open.length);
    if (n !== null) { setSel(n); return true; }
    if (!cur) return false;
    if (e.c === "pushBar") {
      if (cur.agentId && cur.status !== "todo") { toast("Agent tasks finish themselves. Stop it first with C."); return true; }
      setLeaving(cur.id);
      setTimeout(() => { net.send({ type: "task.complete", taskId: cur.id }); setLeaving(null); }, 260);
      return true;
    }
    if (e.c === "a") { push({ name: "task", taskId: cur.id }); return true; }
    if (e.c === "d" && !cur.agentId) { setPicking(cur.id); return true; }
    if (e.c === "c" && cur.agentId && cur.status !== "todo") { net.send({ type: "task.cancel", taskId: cur.id }); return true; }
    return false;
  }, {
    wheel: open.length ? "Browse" : undefined,
    push: cur && (!cur.agentId || cur.status === "todo") ? "Complete" : undefined,
    a: cur ? "Open" : undefined,
    d: cur && !cur.agentId ? "Hand to agent" : undefined,
    c: cur?.agentId && cur.status !== "todo" ? "Stop agent" : undefined,
  });

  return <div className="scr">
    <p className="h1 in">To-Do</p>
    <div className="mute in" style={{ fontSize: 14 }}>{open.length} open · {doneToday} done today</div>
    <div className="scroll in in-2" style={{ position: "absolute", left: 28, right: 28, top: 104, bottom: 64 }}>
      {open.map((t, k) => {
        const ag = snap.agents.find(a => a.id === t.agentId);
        return <div key={t.id} className={"row" + (k === i ? " sel" : "")} style={{ opacity: leaving === t.id ? 0 : 1, transform: leaving === t.id ? "translateX(30px)" : "none", transition: "opacity 240ms ease, transform 240ms var(--ease), background-color 150ms" }}>
          {ag ? <AgentBot agent={ag} size={24} state={t.status === "running" ? "think" : "idle"} /> : <span className="check" style={leaving === t.id ? { background: "#fff", borderColor: "#fff" } : undefined} />}
          <span style={{ flex: 1, fontSize: 16, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
          {statusChip(t, snap)}
        </div>;
      })}
      {!open.length && <Empty>All done. Hold the mic to add something.</Empty>}
    </div>
    <div className="label" style={{ position: "absolute", left: 24, bottom: 42 }}>Our own list · Todoist coming soon</div>
    {picking && <AgentPicker onPick={agentId => { const id = picking; setPicking(null); net.send({ type: "task.assign", taskId: id, agentId }); push({ name: "task", taskId: id }); }} onClose={() => setPicking(null)} />}
  </div>;
}

/** Bottom sheet: pick an agent with the wheel or D-pad, A to hand it over. */
export function AgentPicker({ onPick, onClose }: { onPick: (agentId: string) => void; onClose: () => void }) {
  const { snap } = useApp();
  const [sel, setSel] = useState(0);
  useControls(e => {
    const n = step(sel, e, snap.agents.length, { dpad: "horizontal" }) ?? step(sel, e, snap.agents.length, { wheel: false });
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a") { onPick(snap.agents[sel].id); return true; }
    if (e.c === "b") { onClose(); return true; }
    return e.c !== "mic" && e.c !== "systemWheel";
  }, { a: "Hand over", b: "Cancel", wheel: "Pick" }, true, LAYER.sheet);
  return <div className="sheet">
    <div className="sheet-in">
      <div className="label" style={{ marginBottom: 10 }}>Hand to which agent?</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {snap.agents.map((a, k) => <div key={a.id} className={"card" + (k === sel ? " sel" : "")} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px 8px 8px" }}>
          <AgentBot agent={a} size={30} /><b style={{ fontSize: 14 }}>{a.name}</b>
        </div>)}
      </div>
      <div className="mute" style={{ fontSize: 13, marginTop: 10 }}>{snap.agents[sel]?.role}</div>
    </div>
  </div>;
}
