import { useEffect, useState } from "react";
import { Bot } from "../../bot/Bot";
import { useControls, step } from "../../input/controls";
import { net, offlineAsNotes } from "../../net/client";
import { useApp } from "../context";
import { AgentBot, Ico } from "../ui";

// "Saved. I hear 2 tasks." One press of A accepts (ADR 0005).
export function Suggest({ id }: { id: string }) {
  const { snap, back, push, go, online } = useApp();
  const note = id.startsWith("local:") ? offlineAsNotes(net.offlineNotes).find(n => n.id === id) : snap.notes.find(n => n.id === id);
  const sugg = note?.suggestions ?? [];
  const [picks, setPicks] = useState<string[]>(sugg.map(s => s.id));
  // Suggestions arrive after the note: pick them all by default.
  const key = sugg.map(s => s.id).join();
  useEffect(() => { setPicks(sugg.map(s => s.id)); setSel(sugg.length); }, [key]);

  const state = note?.suggestionState;
  const ready = state === "ready";
  // Focus order: each suggestion, then the buttons. Default focus is "Do it".
  const buttons = ready ? ["do", "todos", "note"] : ["ok"];
  const items = ready ? sugg.length + buttons.length : 1;
  const [sel, setSel] = useState(sugg.length);

  const accept = (asTodos: boolean) => {
    if (!note || !picks.length) return;
    net.send({ type: "suggestion.accept", noteId: note.id, suggestionIds: picks, asTodos });
    const firstAgent = !asTodos && sugg.find(s => picks.includes(s.id) && s.agentId);
    // Follow the first agent task once the server has made it.
    if (firstAgent) {
      const stop = net.on(m => {
        if (m.type !== "snapshot") return;
        const n = m.snapshot.notes.find(x => x.id === note.id);
        const t = n && m.snapshot.tasks.find(x => n.taskIds.includes(x.id) && x.agentId);
        if (t) { stop(); back(); push({ name: "task", taskId: t.id }); }
      });
      setTimeout(stop, 4000);
    } else { back(); go("todo"); }
  };
  const justNote = () => { if (note && ready) net.send({ type: "suggestion.dismiss", noteId: note.id }); back(); };

  useControls(e => {
    if (!note) return false;
    if (!ready) {
      if (e.c === "a") { back(); return true; }
      return false;
    }
    const n = step(sel, e, items);
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a") {
      if (sel < sugg.length) {
        const s = sugg[sel].id;
        setPicks(p => (p.includes(s) ? p.filter(x => x !== s) : [...p, s]));
      } else {
        const b = buttons[sel - sugg.length];
        if (b === "do") accept(false);
        else if (b === "todos") accept(true);
        else justNote();
      }
      return true;
    }
    if (e.c === "d") { accept(true); return true; }
    if (e.c === "c") { justNote(); return true; }
    return false;
  }, ready
    ? { a: sel < sugg.length ? (picks.includes(sugg[sel]?.id) ? "Leave out" : "Include") : sel === sugg.length ? "Do it" : sel === sugg.length + 1 ? "Keep as todos" : "Just the note", d: "Keep as todos", c: "Just the note", wheel: "Move", dpad: "Move" }
    : { a: "OK" });

  if (!note) return <div className="scr"><p className="say">That note is gone.</p></div>;
  const pending = state === "pending";
  const headline = state === "offline" ? "Saved on the Device." : pending ? "Saved. Looking for tasks…" : ready ? `Saved. I hear ${sugg.length === 1 ? "one task" : sugg.length + " tasks"}.` : "Saved.";
  const btn = (k: string, label: string, cls = "btn") => {
    const on = ready && sel === sugg.length + buttons.indexOf(k);
    return <span className={cls + (on ? " sel" : "") + (k === "do" && !picks.length ? " dim" : "")}>{label}</span>;
  };
  return <div className="scr">
    <div style={{ position: "absolute", left: 22, top: 70 }}><Bot state={pending ? "think" : ready ? "happy" : state === "offline" ? "wide" : "idle"} size={150} seed={3} /></div>
    <div style={{ position: "absolute", left: 200, right: 28, top: 56 }}>
      <p className="say in" style={{ fontSize: 30 }}>{headline}</p>
      <p className="mute in in-2" style={{ margin: "8px 0 14px", fontSize: 14.5, lineHeight: 1.45, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>“{note.text}”</p>
      {ready && <div className="in in-3" style={{ display: "grid", gap: 8 }}>
        {sugg.slice(0, 4).map((s, k) => {
          const ag = snap.agents.find(a => a.id === s.agentId), on = picks.includes(s.id);
          return <div key={s.id} className={"card" + (sel === k ? " sel" : "")} style={{ display: "flex", gap: 12, alignItems: "center", padding: "9px 14px" }}>
            <span className={"check" + (on ? " on" : "")}>{on && Ico.check()}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</div>
              <div className="mute" style={{ fontSize: 13 }}>{s.why || (ag ? ag.name : "A plain todo")}</div>
            </div>
            {ag && <AgentBot agent={ag} size={38} />}
          </div>;
        })}
      </div>}
      {state === "offline" && <p className="mute in in-3" style={{ fontSize: 15 }}>No connection. I’ll re-check it with the cloud and suggest tasks once you’re back{online ? "…" : "."}</p>}
      {state === "none" && <p className="mute in in-3" style={{ fontSize: 15 }}>No tasks in this one. It’s in Notes.</p>}
      <div className="in in-4" style={{ display: "flex", gap: 10, marginTop: 14 }}>
        {ready ? <>{btn("do", "Do it")}{btn("todos", "Keep as todos", "btn ghost")}{btn("note", "Just the note", "btn ghost")}</> : <span className={"btn" + (pending ? " ghost" : " sel")}>{pending ? "One moment…" : "OK"}</span>}
      </div>
    </div>
  </div>;
}
