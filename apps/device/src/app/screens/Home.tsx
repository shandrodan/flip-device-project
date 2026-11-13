import { useState } from "react";
import { Bot } from "../../bot/Bot";
import { useControls, step } from "../../input/controls";
import { useApp, useTalkTarget } from "../context";
import { AgentBot, ACTIVE, moodFor, useScrollSel } from "../ui";

export function Home() {
  const { snap, push, online } = useApp();
  useTalkTarget({ kind: "note" }, []);
  const active = snap.tasks.filter(t => t.agentId && ACTIVE.includes(t.status));
  const waiting = active.filter(t => ["held", "paused", "awaiting-approval"].includes(t.status));
  const running = active.filter(t => t.status === "running");
  const pending = snap.notes.find(n => n.suggestionState === "ready");
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, Math.max(0, active.length - 1));
  useScrollSel(i);

  const recent = Date.now() - Date.parse(snap.activity[0]?.at || "0") < 3000 && /^Finished/.test(snap.activity[0]?.text || "");
  const state = recent ? "happy" : running.length ? "think" : waiting.length ? "wide" : !online ? "sad" : "idle";
  const first = running[0], ag = first && snap.agents.find(a => a.id === first.agentId);
  const todo = snap.tasks.filter(t => t.status !== "done").length;

  useControls(e => {
    const n = step(i, e, active.length, { dpad: "horizontal" });
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a" && active[i]) { push({ name: "task", taskId: active[i].id }); return true; }
    if (e.c === "x" && pending) { push({ name: "suggest", noteId: pending.id }); return true; }
    return false;
  }, { a: active.length ? "Open task" : undefined, x: pending ? "Suggestions" : undefined, dpad: active.length > 1 ? "Pick" : undefined });

  const line = first ? `${ag?.name ?? "An agent"} is on it: ${first.title.charAt(0).toLowerCase() + first.title.slice(1)}`
    : waiting.length ? `${waiting.length} task${waiting.length > 1 ? "s" : ""} need${waiting.length > 1 ? "" : "s"} you`
    : "Hold the mic and just say it.";

  return <div className="scr">
    <div style={{ position: "absolute", left: 0, right: 0, top: 30, display: "grid", placeItems: "center" }}><Bot state={state} size={210} seed={3} /></div>
    <div className="in" style={{ position: "absolute", left: 0, right: 0, bottom: 40, textAlign: "center", padding: "0 24px" }}>
      <p className="say" style={{ fontSize: 26 }}>{line}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", alignItems: "center", marginTop: 14, minHeight: 44 }}>
        {active.length > 0 ? active.slice(0, 6).map((t, k) => {
          const a = snap.agents.find(x => x.id === t.agentId)!;
          return <div key={t.id} title={t.title} style={{ padding: 3, borderRadius: 14, boxShadow: k === i ? "inset 0 0 0 2px #fff" : "none", transition: "box-shadow 150ms" }}>
            <AgentBot agent={a} size={38} state={moodFor(t)} />
          </div>;
        }) : <>
          {pending && <span className="chip blue"><i className="dot" />{pending.suggestions.length} suggested</span>}
          <span className="chip">{todo} task{todo === 1 ? "" : "s"} today</span>
          {snap.focus.running && <span className="chip">Focus round {snap.focus.round}</span>}
          {!online && <span className="chip warn"><i className="dot" />Offline · notes still work</span>}
        </>}
      </div>
    </div>
  </div>;
}
