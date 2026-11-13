import { useEffect, useRef, useState } from "react";
import type { Note } from "@app/protocol";
import { useControls, step } from "../../input/controls";
import { net, offlineAsNotes, useNet } from "../../net/client";
import { useApp, useTalkTarget } from "../context";
import { ago, Empty, statusChip, useScrollSel } from "../ui";

function sourceChip(n: Note) {
  if (n.suggestionState === "offline") return <span className="chip warn"><i className="dot" />On device, re-checks when online</span>;
  if (n.transcribedBy === "local") return <span className="chip warn"><i className="dot" />On device{n.editedByUser ? ", your words" : ""}</span>;
  if (n.editedByUser) return <span className="chip">You added to this, kept your version</span>;
  return <span className="chip">Cloud transcript</span>;
}

export function useAllNotes() {
  const n = useNet();
  return [...offlineAsNotes(n.offlineNotes), ...(n.snap?.notes ?? [])];
}

export function Notes() {
  const { push } = useApp();
  const notes = useAllNotes();
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, Math.max(0, notes.length - 1));
  useScrollSel(i);
  useTalkTarget({ kind: "note" }, []);
  useControls(e => {
    const n = step(i, e, notes.length);
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a" && notes[i]) { push({ name: "note", noteId: notes[i].id }); return true; }
    return false;
  }, { wheel: notes.length ? "Browse" : undefined, a: notes.length ? "Open" : undefined });

  return <div className="scr">
    <p className="h1 in">Notes</p>
    <div className="mute in" style={{ fontSize: 14 }}>Every dump, saved first</div>
    <div className="scroll in in-2" style={{ position: "absolute", left: 14, right: 28, top: 104, bottom: 40 }}>
      {notes.map((n, k) => <div key={n.id} className={"row" + (k === i ? " sel" : "")} style={{ display: "block" }}>
        <div style={{ fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n.text}</div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 6 }}>
          <span className="mute" style={{ fontSize: 13 }}>{ago(n.createdAt)}</span>
          {sourceChip(n)}
          {n.suggestionState === "ready" && <span className="chip blue">{n.suggestions.length} suggested</span>}
          {n.taskIds.length > 0 && <span className="chip ok">{n.taskIds.length} task{n.taskIds.length > 1 ? "s" : ""}</span>}
        </div>
      </div>)}
      {!notes.length && <Empty>No notes yet. Hold the mic to make one.</Empty>}
    </div>
  </div>;
}

export function NoteView({ id }: { id: string }) {
  const { snap, push, online, toast } = useApp();
  const notes = useAllNotes();
  const n = notes.find(x => x.id === id);
  const tasks = n ? snap.tasks.filter(t => n.taskIds.includes(t.id)) : [];
  const [sel, setSel] = useState(-1); // -1 = the text, else a task row
  const box = useRef<HTMLDivElement>(null);
  useTalkTarget(n ? { kind: "append", noteId: n.id } : null, [n?.id]);
  useEffect(() => { if (sel >= 0) document.querySelector(".screen .sel")?.scrollIntoView({ block: "nearest" }); }, [sel]);
  const local = id.startsWith("local:");

  useControls(e => {
    if (!n) return false;
    if (e.c === "appWheel" && sel < 0 && box.current && box.current.scrollHeight > box.current.clientHeight + 4) {
      box.current.scrollTop += (e.dir || 0) * 36;
      return true;
    }
    const k = step(sel + 1, e, tasks.length + 1);
    if (k !== null) { setSel(k - 1); return true; }
    if (e.c === "a" && sel >= 0 && tasks[sel]) { push({ name: "task", taskId: tasks[sel].id }); return true; }
    if (e.c === "x" && !local) {
      if (!online) { toast("I’ll suggest tasks once you’re back online"); return true; }
      if (n.suggestionState === "ready") push({ name: "suggest", noteId: n.id });
      else if (n.suggestionState !== "accepted") { net.send({ type: "note.suggest", noteId: n.id }); push({ name: "suggest", noteId: n.id }); }
      else { net.send({ type: "note.suggest", noteId: n.id }); push({ name: "suggest", noteId: n.id }); }
      return true;
    }
    if (e.c === "y" && !local) { net.send({ type: "note.delete", noteId: n.id }); return true; }
    return false;
  }, n ? {
    mic: "Hold to add to it",
    a: sel >= 0 ? "Open task" : undefined,
    x: local ? undefined : n.suggestionState === "ready" ? "Review tasks" : "Suggest tasks",
    y: local ? undefined : "Delete",
    wheel: "Scroll",
  } : null);

  if (!n) return <div className="scr"><p className="say">That note is gone.</p></div>;
  return <div className="scr">
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 4 }}>
      <span className="mute" style={{ fontSize: 13 }}>{new Date(n.createdAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
      {sourceChip(n)}
      {n.durationMs ? <span className="chip">{Math.max(1, Math.round(n.durationMs / 1000))}s</span> : null}
    </div>
    <div ref={box} className={"scroll" + (sel < 0 ? "" : "")} style={{ marginTop: 12, maxHeight: tasks.length ? 200 : 330, fontSize: 21, lineHeight: 1.42, letterSpacing: "-0.012em", whiteSpace: "pre-wrap" }}>{n.text}</div>
    {tasks.length > 0 && <div style={{ position: "absolute", left: 14, right: 28, bottom: 42 }}>
      <div className="label" style={{ margin: "0 0 4px 10px" }}>Tasks from this note</div>
      {tasks.map((t, k) => <div key={t.id} className={"row" + (k === sel ? " sel" : "")}><span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>{statusChip(t, snap)}</div>)}
    </div>}
  </div>;
}
