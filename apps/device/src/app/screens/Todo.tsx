// To-Do (ADR 0016): a light app like Notes, but blue. Lists on the left (Today, Inbox, Scheduled,
// Completed, then projects), tasks on the right. The selected task opens into a white card in place and
// the rest stay one line; Scheduled is a board of days. Holding the mic pushes the app down and the main
// agent appears above it on black, like Notes: it makes one task from what you said and files it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Agent, Note, Task } from "@app/protocol";
import { CalendarDaysIcon, CalendarIcon, CheckCircleIcon, CheckIcon, InboxIcon, PlusIcon } from "@heroicons/react/20/solid";
import { Bot, type BotState } from "../../bot/Bot";
import { useControls, step, LAYER } from "../../input/controls";
import { net } from "../../net/client";
import { startCapture, blobToBase64, nextTodoSample, type Capture, type VoiceSource } from "../../voice/capture";
import { useApp } from "../context";
import { AgentBot, useTick } from "../ui";
import { PadStatus } from "./Notes";

/* ------------------------------ Dates (local days, "YYYY-MM-DD") ------------------------------ */
const pad2 = (n: number) => String(n).padStart(2, "0");
export function localDay(offset = 0) {
  const n = new Date(), d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + offset);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export const dayOf = (t: Task) => (t.due ? t.due.slice(0, 10) : null);
export const timeOf = (t: Task) => (t.due && t.due.length > 10 ? t.due.slice(11, 16) : null);
const diff = (day: string) => Math.round((Date.parse(day + "T12:00") - Date.parse(localDay() + "T12:00")) / 864e5);
const asDate = (day: string) => new Date(day + "T12:00");
function dayWord(day: string, long = false) {
  const n = diff(day);
  if (n === 0) return "Today";
  if (n === 1) return "Tomorrow";
  if (n === -1) return "Yesterday";
  if (Math.abs(n) < 7) return asDate(day).toLocaleDateString("en-GB", { weekday: long ? "long" : "short" });
  return asDate(day).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
function dueText(t: Task) {
  const day = dayOf(t), time = timeOf(t);
  if (!day) return null;
  return time ? `${dayWord(day)} ${time}` : dayWord(day);
}
const tone = (t: Task) => { const d = dayOf(t); return !d ? "" : diff(d) < 0 ? "late" : diff(d) === 0 ? "today" : ""; };
const byDue = (a: Task, b: Task) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || a.createdAt.localeCompare(b.createdAt);
const doneWhen = (t: Task) => {
  if (!t.completedAt) return "";
  const d = new Date(t.completedAt), day = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return diff(day) === 0 ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : dayWord(day);
};

/* ------------------------------ Lists ------------------------------ */
type ListId = "today" | "inbox" | "scheduled" | "completed" | string;
interface List { id: ListId; name: string; icon?: ReactNode; color?: string }
const ico = (C: typeof InboxIcon) => <C width={20} height={20} aria-hidden="true" />;
const BASE: List[] = [
  { id: "today", name: "Today", icon: ico(CalendarIcon) },
  { id: "inbox", name: "Inbox", icon: ico(InboxIcon) },
  { id: "scheduled", name: "Scheduled", icon: ico(CalendarDaysIcon) },
  { id: "completed", name: "Completed", icon: ico(CheckCircleIcon) },
];

export function tasksIn(id: ListId, all: Task[]): Task[] {
  if (id === "completed") return all.filter(t => t.status === "done").sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  const open = all.filter(t => t.status !== "done");
  const today = localDay();
  if (id === "today") return open.filter(t => { const d = dayOf(t); return !!d && d <= today; }).sort(byDue);
  if (id === "inbox") return open.filter(t => !t.projectId).sort(byDue);
  if (id === "scheduled") return open.filter(t => !!t.due).sort(byDue);
  return open.filter(t => t.projectId === id).sort(byDue);
}

export interface Col { key: string; label: string; late?: boolean; tasks: Task[] }
/** Scheduled: Overdue (only when there is any), the next seven days, then Later. */
export function columns(all: Task[]): Col[] {
  const open = tasksIn("scheduled", all), today = localDay(), last = localDay(6);
  const cols: Col[] = [];
  const late = open.filter(t => dayOf(t)! < today);
  if (late.length) cols.push({ key: "late", label: "Overdue", late: true, tasks: late });
  for (let i = 0; i < 7; i++) {
    const day = localDay(i), d = asDate(day);
    const name = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-GB", { weekday: "long" });
    cols.push({ key: day, label: `${d.getDate()} ${d.toLocaleDateString("en-GB", { month: "short" })} · ${name}`, tasks: open.filter(t => dayOf(t) === day) });
  }
  const later = open.filter(t => dayOf(t)! > last);
  if (later.length) cols.push({ key: "later", label: "Later", tasks: later });
  return cols;
}

/** What an agent is doing with a task, in a few words. */
function agentLine(t: Task, ag: Agent | undefined) {
  if (!ag) return null;
  switch (t.status) {
    case "running": return `Working · ${ag.name}`;
    case "awaiting-approval": case "held": return `Waiting for your press · ${ag.name}`;
    case "paused": return `Paused · ${ag.name}`;
    case "failed": return `Didn’t work · ${ag.name}`;
    case "done": return `by ${ag.name}`;
    default: return ag.name;
  }
}
const busyAgent = (t: Task) => !!t.agentId && ["running", "awaiting-approval", "held"].includes(t.status);

/* ------------------------------ Dictation (same flow as Notes) ------------------------------ */
const DONE_MS = 5000;
type Phase = "listen" | "think" | "done" | "miss";
interface Dict { phase: Phase; heard: string; about: string; label: string; bot: BotState }
const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/* ================================ Screen ================================ */
export function Todo() {
  const { snap, push, toast, voice, online } = useApp();
  useTick(60000); // "Today" moves at midnight
  const projects = snap.projects ?? [];
  const lists: List[] = [...BASE, ...projects.map(p => ({ id: p.id, name: p.name, color: p.color }))];
  const [side, setSide] = useState(0);
  const [focus, setFocus] = useState<"side" | "tasks">("tasks");
  const [sel, setSel] = useState(0);
  const [col, setCol] = useState(0);
  const [leaving, setLeaving] = useState<{ id: string; how: "done" | "gone" | "back" } | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const list = lists[Math.min(side, lists.length - 1)];
  const board = list.id === "scheduled";
  const cols = board ? columns(snap.tasks) : [];
  const items = board ? [] : tasksIn(list.id, snap.tasks);
  const ci = Math.min(col, Math.max(0, cols.length - 1));
  const shown = board ? cols[ci]?.tasks ?? [] : items;
  const i = Math.min(sel, Math.max(0, shown.length - 1));
  const cur = shown[i] as Task | undefined;
  const isDone = list.id === "completed";
  const agentOf = (t: Task) => snap.agents.find(a => a.id === t.agentId);
  const noteOf = (t: Task) => (t.noteId ? snap.notes.find(n => n.id === t.noteId) : undefined);

  // Next layout runs without transitions (first paint, switching lists).
  const still = useRef(true);
  const openList = (k: number) => { setSide(k); setSel(0); setCol(0); still.current = true; };

  /* ---------- Actions ---------- */
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  const complete = () => {
    if (!cur || leaving) return;
    if (isDone) {
      setLeaving({ id: cur.id, how: "back" });
      later(() => { net.send({ type: "task.reopen", taskId: cur.id }); setLeaving(null); toast("Back in your list"); }, 320);
      return;
    }
    if (busyAgent(cur)) { toast("The agent is still on it. Open it with A to stop it."); return; }
    setLeaving({ id: cur.id, how: "done" });
    later(() => setLeaving({ id: cur.id, how: "gone" }), 380);
    later(() => { net.send({ type: "task.complete", taskId: cur.id }); setLeaving(null); }, 380 + 300);
  };
  const toToday = (t: Task) => net.send({ type: "task.reschedule", taskId: t.id, due: localDay() + (timeOf(t) ? "T" + timeOf(t) : "") });
  const reschedule = () => {
    if (board && cols[ci]?.late) {
      for (const t of cols[ci].tasks) toToday(t);
      toast(`Moved ${cols[ci].tasks.length} to Today`);
      setCol(0); setSel(0);
      return;
    }
    if (!cur) return;
    toToday(cur);
    toast("Moved to Today");
  };
  const canToday = !!cur && !isDone && dayOf(cur) !== localDay() && !(board && cols[ci]?.key === localDay());

  /* ---------- Dictation ---------- */
  const [dict, setDict] = useState<Dict | null>(null);
  const lastDict = useRef<Dict | null>(null);
  if (dict) lastDict.current = dict;
  const [level, setLevel] = useState(0);
  const cap = useRef<Capture | null>(null);
  const streamId = useRef("");
  const streaming = useRef(false);
  const released = useRef(false);
  const dTimers = useRef<number[]>([]);
  const stopWait = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const landed = useRef<string | null>(null);
  const tasksRef = useRef(snap.tasks);
  tasksRef.current = snap.tasks;
  const listRef = useRef(list);
  listRef.current = list;
  const dLater = (fn: () => void, ms: number) => { dTimers.current.push(window.setTimeout(fn, ms)); };
  const clearD = () => { dTimers.current.forEach(clearTimeout); dTimers.current = []; stopWait.current?.(); stopWait.current = null; };
  const patch = (p: Partial<Dict>) => setDict(d => (d ? { ...d, ...p } : d));

  const close = () => {
    clearD();
    if (cap.current) {
      cap.current.cancel();
      cap.current = null;
      if (streaming.current) net.send({ type: "voice.cancel", streamId: streamId.current });
    }
    setDict(null);
    setLevel(0);
    // The new task, if it's in the open list, opens with the usual morph as the app comes back up.
    const id = landed.current;
    landed.current = null;
    if (!id) return;
    const l = listRef.current;
    if (l.id === "scheduled") {
      const cs = columns(tasksRef.current), c = cs.findIndex(x => x.tasks.some(t => t.id === id));
      if (c >= 0) { setCol(c); setSel(cs[c].tasks.findIndex(t => t.id === id)); setFocus("tasks"); }
    } else {
      const k = tasksIn(l.id, tasksRef.current).findIndex(t => t.id === id);
      if (k >= 0) { setSel(k); setFocus("tasks"); }
    }
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; close(); }; }, []);
  useEffect(() => {
    if (dict?.phase !== "listen") return;
    const id = setInterval(() => cap.current && setLevel(cap.current.level()), 90);
    return () => clearInterval(id);
  }, [dict?.phase]);

  const target = () => ({ kind: "task" as const, listId: listRef.current.id });
  const miss = () => { patch({ phase: "miss", bot: "sad", about: "" }); dLater(close, 2200); };

  const start = () => {
    clearD();
    if (cap.current) { cap.current.cancel(); cap.current = null; }
    released.current = false;
    streaming.current = false;
    landed.current = null;
    streamId.current = "vs_" + Math.random().toString(36).slice(2, 10);
    setPicking(null);
    setDict({ phase: "listen", heard: "", about: "", label: "", bot: "wide" });
    dLater(() => setDict(d => (d && d.phase === "listen" ? { ...d, bot: "listen" } : d)), 380);
    const sid = streamId.current;
    const begin = async (source: VoiceSource) => {
      try {
        const c = await startCapture(source, {
          purpose: "note",
          line: source === "script" ? nextTodoSample() : undefined,
          onPartial: t => alive.current && sid === streamId.current && setDict(d => (d && d.phase === "listen" ? { ...d, heard: t } : d)),
          onChunk: async b => {
            if (streaming.current && sid === streamId.current) net.send({ type: "voice.chunk", streamId: sid, audio: await blobToBase64(b) });
          },
        });
        if (!alive.current || sid !== streamId.current) return c.cancel();
        cap.current = c;
        if (c.source === "mic" && net.online) streaming.current = net.send({ type: "voice.start", streamId: sid, mime: c.mime, target: target() });
        if (released.current) void finish();
      } catch {
        if (source === "mic") { toast("No microphone access. Using the scripted voice."); return begin("script"); }
        close();
      }
    };
    void begin(voice);
  };

  const finish = async () => {
    released.current = true;
    const c = cap.current;
    if (!c) return; // still starting; begin() calls finish once ready
    cap.current = null;
    setLevel(0);
    const r = await c.stop();
    const heard = r.hint.trim().replace(/…$/, "");
    if (r.durationMs < 600 || (!heard && c.source === "script")) {
      if (streaming.current) net.send({ type: "voice.cancel", streamId: streamId.current });
      return miss();
    }
    const t0 = Date.now();
    patch({ phase: "think", bot: "think", heard: heard || lastDict.current?.heard || "", about: `Reading your lists, starting with “${short(listRef.current.name)}”` });

    // Offline: it's still a dump, so it's kept on the Device as a note.
    if (!net.online) {
      net.saveOffline({ localId: streamId.current, text: heard || `Voice note (${Math.round(r.durationMs / 1000)}s)`, createdAt: new Date().toISOString(), durationMs: r.durationMs, editedByUser: false, mime: r.mime, cloudText: r.cloudText });
      dLater(() => { patch({ phase: "done", bot: "wink", label: "Kept on the Device as a note", about: "Offline. Make it a task from Notes once you’re back" }); dLater(close, DONE_MS); }, 900);
      return;
    }
    const tgt = target();
    if (c.source === "mic" && streaming.current) net.send({ type: "voice.end", streamId: streamId.current, durationMs: r.durationMs, hint: heard || undefined });
    else if (heard) net.send({ type: "voice.scripted", text: heard, cloudText: r.cloudText, durationMs: r.durationMs, target: tgt });
    else return miss();

    const sid = streamId.current, scripted = c.source === "script" || !streaming.current;
    const stop = net.on(m => {
      if (m.type !== "task.routed" || (!scripted && m.streamId !== sid)) return;
      stop();
      clearTimeout(slow);
      stopWait.current = null;
      // "Reading your lists" for at least a second, then why, then where it went.
      const showWhy = Math.max(0, 1100 - (Date.now() - t0));
      dLater(() => patch({ about: m.why }), showWhy);
      dLater(() => {
        landed.current = m.taskId;
        const t = tasksRef.current.find(x => x.id === m.taskId);
        const when = t ? dueText(t) : null;
        patch({ phase: "done", bot: t?.agentId ? "wink" : "happy", label: m.label, about: t ? `“${short(t.title, 40)}”${when ? " · " + when : ""}` : m.why });
        dLater(close, DONE_MS);
      }, showWhy + 1100);
    });
    const slow = window.setTimeout(() => {
      stop();
      patch({ phase: "done", bot: "idle", label: "Saved", about: "The server is slow. It’ll show up in a moment" });
      dLater(close, 3000);
    }, 9000);
    stopWait.current = () => { stop(); clearTimeout(slow); };
  };

  /* ---------- Controls ---------- */
  const busy = !!dict && (dict.phase === "listen" || dict.phase === "think");
  useControls(e => {
    if (e.c === "mic") {
      if (e.phase === "down" && !busy) start();
      if (e.phase === "up" && dict?.phase === "listen") void finish();
      return true;
    }
    if (dict) {
      if (e.c === "b" && !busy) { close(); return true; }
      return e.c !== "systemWheel"; // the system wheel still switches functions
    }
    if (focus === "side") {
      const n = step(side, e, lists.length);
      if (n !== null) { openList(n); return true; }
      if (e.c === "right" || e.c === "a") { setFocus("tasks"); return true; }
      return false; // B: back to Home
    }
    if (e.c === "b") { setFocus("side"); return true; }
    if (board && (e.c === "left" || e.c === "right")) {
      const c = ci + (e.c === "left" ? -1 : 1);
      if (c < 0) { setFocus("side"); return true; }
      if (c < cols.length) { setCol(c); setSel(s => Math.min(s, Math.max(0, cols[c].tasks.length - 1))); }
      return true;
    }
    if (!board && e.c === "left") { setFocus("side"); return true; }
    const n = step(i, e, shown.length);
    if (n !== null) { setSel(n); return true; }
    if (e.c === "pushBar") { complete(); return true; }
    if (e.c === "a" && cur) { push({ name: "task", taskId: cur.id }); return true; }
    if (e.c === "d" && cur && !cur.agentId && !isDone) { setPicking(cur.id); return true; }
    if (e.c === "c" && !isDone && (canToday || (board && cols[ci]?.late))) { reschedule(); return true; }
    return false;
  }, dict
    ? { mic: dict.phase === "listen" ? "Release to save" : dict.phase === "done" ? "Hold to talk again" : undefined, b: busy ? undefined : "Close" }
    : focus === "side"
      ? { wheel: "Lists", a: "Open", mic: "Hold to add a task" }
      : {
        wheel: shown.length ? "Browse" : undefined,
        dpad: board ? "Days" : undefined,
        push: cur ? (isDone ? "Restore" : busyAgent(cur) ? undefined : "Complete") : undefined,
        a: cur ? "Open" : undefined,
        d: cur && !cur.agentId && !isDone ? "Hand to agent" : undefined,
        c: board && cols[ci]?.late ? "Reschedule all" : canToday ? "Move to Today" : undefined,
        b: "Lists",
        mic: "Hold to add a task",
      });

  /* ---------- Layout: heights and offsets the CSS animates ---------- */
  const pane = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = pane.current;
    if (!box) return;
    const bar = box.parentElement?.querySelector<HTMLElement>(".td-sidebar"), row = bar?.querySelector<HTMLElement>(".td-srow.sel");
    if (bar && row) {
      if (row.offsetTop - 8 < bar.scrollTop) bar.scrollTop = row.offsetTop - 8;
      else if (row.offsetTop + row.offsetHeight + 44 > bar.scrollTop + bar.clientHeight) bar.scrollTop = row.offsetTop + row.offsetHeight + 44 - bar.clientHeight;
    }
    const stillNow = still.current;
    still.current = false;
    if (board) {
      const strip = box.querySelector<HTMLElement>(".td-cols");
      if (!strip) return;
      if (stillNow) strip.classList.add("still");
      const secs = [...strip.querySelectorAll<HTMLElement>(".td-col")], stepW = 222 + 14;
      secs.forEach((sec, k) => {
        const cin = sec.querySelector<HTMLElement>(".td-cin")!, body = sec.querySelector<HTMLElement>(".td-cbody")!;
        const card = k === ci ? sec.querySelectorAll<HTMLElement>(".td-card")[i] : undefined;
        const off = card ? Math.max(0, card.offsetTop + card.offsetHeight - (body.clientHeight - 46)) : 0;
        cin.style.transform = `translateY(${-off}px)`;
      });
      // The open day sits in the second slot, so the day before it stays in sight.
      const max = Math.max(0, 32 + secs.length * stepW - 14 - box.clientWidth);
      strip.style.transform = `translateX(${-Math.min(max, Math.max(0, (ci - 1) * stepW))}px)`;
      if (stillNow) { void strip.offsetHeight; strip.classList.remove("still"); }
      return;
    }
    const track = box.querySelector<HTMLElement>(".td-track");
    if (!track) return;
    if (stillNow) track.classList.add("still");
    let y = 12, top = 0;
    track.querySelectorAll<HTMLElement>(".td-t").forEach((r, k) => {
      const on = k === i;
      const h = on ? r.querySelector<HTMLElement>(".td-in")!.offsetHeight : 38;
      r.style.height = h + "px";
      if (on) top = y;
      if (!r.classList.contains("gone") && !r.classList.contains("back")) y += h + 4;
    });
    // Rows above the open one end up closed, so its final top is known before anything moves.
    const max = Math.max(0, y + 44 - box.clientHeight);
    track.style.transform = `translateY(${-Math.min(max, Math.max(0, top - 56))}px)`;
    if (stillNow) { void track.offsetHeight; track.classList.remove("still"); }
  });

  /* ---------- Render ---------- */
  const shownDict = dict ?? lastDict.current;
  const openCount = snap.tasks.filter(t => t.status !== "done").length;
  const doneToday = snap.tasks.filter(t => t.status === "done" && t.completedAt && new Date(t.completedAt).toDateString() === new Date().toDateString()).length;
  const count = board ? cols.reduce((n, c) => n + c.tasks.length, 0) : items.length;
  const lateToday = tasksIn("today", snap.tasks).some(t => tone(t) === "late");

  return <div className={"np td" + (dict ? " dictating" : "") + (focus === "side" ? " td-side-focus" : "")}>
    <div className={"np-band " + (shownDict?.phase ?? "")} aria-live="polite">
      <div className="np-bot"><Bot size={76} seed={3} state={dict?.bot ?? "idle"} level={level} fps={dict ? 60 : 8} /></div>
      {shownDict && <div className="np-band-txt">
        <div className="np-label">
          {shownDict.phase === "listen" ? <><i className="np-live" />Listening</>
            : shownDict.phase === "think" ? <>Thinking<span className="np-dots"><i>.</i><i>.</i><i>.</i></span></>
            : shownDict.phase === "miss" ? "Didn’t catch that" : shownDict.label}
        </div>
        <div className="np-said">
          {shownDict.phase === "miss" ? <span className="np-wait">Hold the mic and talk. I’ll turn it into a task.</span>
            : shownDict.heard ? `“${shownDict.heard}”` : <span className="np-wait">Say what needs doing</span>}
        </div>
        {shownDict.about && <div className="np-about">{shownDict.about}</div>}
      </div>}
      {shownDict?.phase === "listen" && <span className="np-pill">Release to save</span>}
      {shownDict?.phase === "done" && <span className="np-pill">B to close</span>}
    </div>

    <div className="np-app td-app">
      <div className="td-head">
        <PadStatus />
        <div className="np-title">{ico(CheckCircleIcon)}To-Do</div>
        <div className="td-view">{short(list.name, 30)}<span>{count || ""}</span></div>
        <div className="td-sum">{online ? `${openCount} open · ${doneToday} done today` : "Offline · changes wait"}</div>
      </div>

      <div className="td-sidebar">
        {lists.map((l, k) => {
          const n = l.id === "scheduled" ? tasksIn("scheduled", snap.tasks).length : tasksIn(l.id, snap.tasks).length;
          return <div key={l.id} className={"td-srow" + (k === side ? " sel" : "")}>
            <span className="td-ic">{l.icon ?? <i className="td-pdot" style={{ background: l.color }} />}</span>
            <span className="td-nm">{l.name}</span>
            <span className={"td-ct" + (l.id === "today" && lateToday ? " late" : "")}>{n || ""}</span>
          </div>;
        }).flatMap((row, k) => k === 4 ? [<div key="lbl" className="td-slabel"><span>Projects</span><span>{projects.length}</span></div>, row] : [row])}
      </div>

      <div className="td-pane" ref={pane}>
        {board ? <div className="td-board">
          <div className="td-cols still">
            {cols.map((c, k) => <section key={c.key} className={"td-col" + (k === ci ? " cur" : "") + (c.late ? " late" : "")}>
              <header><b>{c.label}</b><span className="td-n">{c.tasks.length || ""}</span>{c.late && <span className="td-rs"><i className="g c">C</i>Reschedule</span>}</header>
              <div className="td-cbody"><div className="td-cin">
                {c.tasks.map((t, j) => {
                  const ag = agentOf(t), p = projects.find(x => x.id === t.projectId);
                  const time = c.late ? dueText(t) : timeOf(t);
                  return <div key={t.id} className={"td-card" + (k === ci && j === i && focus === "tasks" ? " on" : k === ci && j === i ? " on dim" : "") + (leaving?.id === t.id ? " " + leaving.how : "")}>
                    <Check t={t} />
                    <div className="td-bd">
                      <span className="td-tt">{t.title}</span>
                      <span className="td-meta">
                        {time && <span className={"td-due " + (c.late ? "late" : "")}>{time}</span>}
                        {ag && <span className="td-ag">{agentLine(t, ag)}</span>}
                        <Proj p={p} />
                      </span>
                    </div>
                    {ag && <AgentBot agent={ag} size={22} state={t.status === "running" ? "think" : "idle"} fps={20} />}
                  </div>;
                })}
                <div className="td-add">{<PlusIcon width={16} height={16} aria-hidden="true" />}Hold the mic to add</div>
              </div></div>
            </section>)}
          </div>
        </div>
          : !items.length ? <div className="td-empty"><div><b>{isDone ? "Nothing completed yet" : list.id === "today" ? "Nothing left for today" : "No tasks here"}</b>
            {isDone ? "Press the push bar on a task to finish it." : "Hold the mic and say what needs doing."}</div></div>
          : <div className="td-list"><div className="td-track still">
            {items.map((t, k) => {
              const ag = agentOf(t), p = projects.find(x => x.id === t.projectId), note = noteOf(t);
              const right = isDone ? doneWhen(t) : dueText(t);
              const details = detailsFor(t, note, isDone);
              // The list already says the project (or that it's Inbox), so the card doesn't repeat it.
              const showProj = isDone || (list.id !== "inbox" && list.id !== t.projectId);
              const meta = <span className="td-meta">
                {isDone ? <span>Completed {/^\d/.test(right ?? "") ? "today at " + right : (right ?? "").toLowerCase()}</span> : right && <span className={"td-due " + tone(t)}>{right}</span>}
                {ag && <span className="td-ag">{agentLine(t, ag)}</span>}
                {showProj && <Proj p={p} full />}
              </span>;
              // Nothing to show under the title: the open card centres the title instead.
              const bare = !isDone && !right && !ag && !showProj && !details;
              const cls = ["td-t", k === i ? "on" : "", ag ? "has-bot" : "", isDone ? "fin" : "", bare ? "bare" : "", leaving?.id === t.id ? leaving.how : ""].filter(Boolean).join(" ");
              return <div key={t.id} className={cls}>
                <Check t={t} done={isDone} />
                {right && <span className={"td-due td-right " + (isDone ? "" : tone(t))}>{right}</span>}
                {ag && <span className="td-bot"><AgentBot agent={ag} size={22} state={t.status === "running" ? "think" : "idle"} fps={20} /></span>}
                <div className="td-in">
                  <span className="td-tt">{t.title}</span>
                  {!bare && <div className="td-more">{meta}{details}</div>}
                </div>
              </div>;
            })}
          </div></div>}
      </div>
      <div className="td-foot" />
    </div>
    {picking && <AgentPicker onPick={agentId => { const id = picking; setPicking(null); net.send({ type: "task.assign", taskId: id, agentId }); }} onClose={() => setPicking(null)} />}
  </div>;
}

function Check({ t, done }: { t: Task; done?: boolean }) {
  return <span className={"td-chk" + (done || t.status === "done" ? " on" : "")}><CheckIcon width={12} height={12} aria-hidden="true" /></span>;
}

function Proj({ p, full }: { p?: { name: string; color: string }; full?: boolean }) {
  return <span className="td-proj"><i style={{ background: p ? p.color : "var(--td-ink-3)" }} />{p ? (full || p.name.length <= 24 ? p.name : p.name.slice(0, 23) + "…") : "Inbox"}</span>;
}

/** What the open card shows under the meta line: the agent's latest steps, its answer, or the note it came from. */
function detailsFor(t: Task, note: Note | undefined, isDone: boolean): ReactNode {
  if (isDone && (t.detail || t.result)) return <div className="td-box">{t.detail || t.result}</div>;
  if (t.steps.length) return <div className="td-steps">{t.steps.slice(-3).map(s => <div key={s.id} className={s.state === "done" ? "ok" : s.state === "running" ? "run" : s.state === "asking" ? "ask" : s.state === "failed" || s.state === "declined" ? "bad" : ""}><i />{s.text}</div>)}</div>;
  if (t.detail) return <div className="td-box">{t.detail}</div>;
  if (note) return <div className="td-box"><b>From a note.</b> {note.text}</div>;
  return null;
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
