// Notes (ADR 0011): the list of notes on the left, the open note on a ruled legal pad on the
// right. Every note is its own sheet: browsing lifts the sheet off the pad or drops the last one back.
// Holding the mic pushes the app down and the main agent appears above it on black. It listens,
// thinks, and the server decides where the words go (the open note, another note, or a new one).
// The result stays up for 5 seconds so you can see what happened.
import { useEffect, useRef, useState, type Ref } from "react";
import type { Note, VoiceTarget } from "@app/protocol";
import { Bot, type BotState } from "../../bot/Bot";
import { useControls, step } from "../../input/controls";
import { net, useNet } from "../../net/client";
import { startCapture, blobToBase64, nextPadSample, type Capture, type VoiceSource } from "../../voice/capture";
import { useApp } from "../context";
import { useTick } from "../ui";
import { useAllNotes } from "./NoteView";

const DONE_MS = 5000;
const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/** A note's text as a title (first sentence of the first line) and a body (the rest). */
export function splitNote(text: string) {
  const t = text.trim(), nl = t.indexOf("\n");
  const first = nl < 0 ? t : t.slice(0, nl), rest = nl < 0 ? "" : t.slice(nl + 1).trim();
  let title = first, more = "";
  const m = first.match(/^(.{3,}?[.!?])\s+(.+)$/);
  if (m) { title = m[1]; more = m[2]; }
  else {
    const w = first.split(/\s+/);
    if (w.length > 12) { title = w.slice(0, 8).join(" ") + "…"; more = "…" + w.slice(8).join(" "); }
  }
  return { title: title.replace(/[.!?]$/, ""), body: [more, rest].filter(Boolean).join("\n") };
}

const when = (iso: string) => {
  const d = new Date(iso), days = Math.floor((Date.now() - d.getTime()) / 864e5);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return days < 2 ? "Yesterday" : d.toLocaleDateString([], { weekday: "long" });
};

type Phase = "listen" | "think" | "done" | "miss";
interface Dict { phase: Phase; heard: string; about: string; label: string; bot: BotState }
type Flip = { from: string; dir: 1 | -1; k: number };

export function Notes() {
  const { voice, toast, push, online } = useApp();
  const notes = useAllNotes();
  const [selId, setSelId] = useState<string | null>(notes[0]?.id ?? null);
  const found = notes.findIndex(n => n.id === selId);
  const i = found < 0 ? 0 : found;
  const cur = notes[i] as Note | undefined;
  const [open, setOpen] = useState(false);
  const [flip, setFlip] = useState<Flip | null>(null);
  const [hl, setHl] = useState<{ noteId: string; text: string } | null>(null);
  const read = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const curRef = useRef(cur);
  curRef.current = cur;

  /* ---------- Browsing ---------- */
  const select = (id: string, dir?: 1 | -1) => {
    if (id === selId) return;
    const from = cur?.id;
    const to = notesRef.current.findIndex(n => n.id === id);
    const d = dir ?? (to > i ? 1 : -1);
    if (from) setFlip({ from, dir: d, k: Date.now() });
    setSelId(id);
  };
  useEffect(() => {
    if (!flip) return;
    const t = setTimeout(() => setFlip(null), 360);
    return () => clearTimeout(t);
  }, [flip?.k]);
  // Keep the selected row in view.
  useEffect(() => {
    const box = list.current, row = box?.querySelector<HTMLElement>(".np-row.sel");
    if (!box || !row) return;
    const pad = 36, top = row.offsetTop, bot = top + row.offsetHeight;
    if (top - pad < box.scrollTop) box.scrollTo({ top: Math.max(0, top - pad), behavior: "smooth" });
    else if (bot + pad > box.scrollTop + box.clientHeight) box.scrollTo({ top: bot + pad - box.clientHeight, behavior: "smooth" });
  }, [i, notes.length]);

  /* ---------- Dictation ---------- */
  const [dict, setDict] = useState<Dict | null>(null);
  const lastDict = useRef<Dict | null>(null);
  if (dict) lastDict.current = dict;
  const [level, setLevel] = useState(0);
  const cap = useRef<Capture | null>(null);
  const streamId = useRef("");
  const streaming = useRef(false);
  const released = useRef(false);
  const timers = useRef<number[]>([]);
  const stopWait = useRef<(() => void) | null>(null);
  const alive = useRef(true);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; stopWait.current?.(); stopWait.current = null; };
  const patch = (p: Partial<Dict>) => setDict(d => (d ? { ...d, ...p } : d));

  const close = () => {
    clearTimers();
    if (cap.current) {
      cap.current.cancel();
      cap.current = null;
      if (streaming.current) net.send({ type: "voice.cancel", streamId: streamId.current });
    }
    setDict(null);
    setLevel(0);
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; close(); }; }, []);
  useEffect(() => {
    if (dict?.phase !== "listen") return;
    const id = setInterval(() => cap.current && setLevel(cap.current.level()), 90);
    return () => clearInterval(id);
  }, [dict?.phase]);

  const openTarget = (): VoiceTarget => {
    const id = curRef.current?.id ?? null;
    return { kind: "auto", openNoteId: id && !id.startsWith("local:") ? id : null };
  };
  const miss = () => { patch({ phase: "miss", bot: "sad", about: "" }); later(close, 2200); };

  const start = () => {
    clearTimers();
    if (cap.current) { cap.current.cancel(); cap.current = null; }
    released.current = false;
    streaming.current = false;
    streamId.current = "vs_" + Math.random().toString(36).slice(2, 10);
    setOpen(false);
    setDict({ phase: "listen", heard: "", about: "", label: "", bot: "wide" }); // perks up when the mic goes down
    later(() => setDict(d => (d && d.phase === "listen" ? { ...d, bot: "listen" } : d)), 380);
    const sid = streamId.current;
    const begin = async (source: VoiceSource) => {
      try {
        const c = await startCapture(source, {
          purpose: "note",
          line: source === "script" ? nextPadSample() : undefined,
          onPartial: t => alive.current && sid === streamId.current && setDict(d => (d && d.phase === "listen" ? { ...d, heard: t } : d)),
          onChunk: async b => {
            if (streaming.current && sid === streamId.current) net.send({ type: "voice.chunk", streamId: sid, audio: await blobToBase64(b) });
          },
        });
        if (!alive.current || sid !== streamId.current) return c.cancel();
        cap.current = c;
        if (c.source === "mic" && net.online) {
          streaming.current = net.send({ type: "voice.start", streamId: sid, mime: c.mime, target: openTarget() });
        }
        if (released.current) void finish();
      } catch {
        if (source === "mic") {
          toast("No microphone access. Using the scripted voice.");
          return begin("script");
        }
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
    if (r.durationMs < 600 || !heard && c.source === "script") {
      if (streaming.current) net.send({ type: "voice.cancel", streamId: streamId.current });
      return miss();
    }
    const openNote = curRef.current;
    const t0 = Date.now();
    patch({ phase: "think", bot: "think", heard: heard || lastDict.current?.heard || "", about: openNote ? `Reading the open note, “${short(splitNote(openNote.text).title)}”` : "Reading your notes" });

    // Offline: keep it on the Device as a new note; the server sorts it later.
    if (!net.online) {
      const localId = streamId.current;
      net.saveOffline({ localId, text: heard || `Voice note (${Math.round(r.durationMs / 1000)}s)`, createdAt: new Date().toISOString(), durationMs: r.durationMs, editedByUser: false, mime: r.mime, cloudText: r.cloudText });
      later(() => {
        select("local:" + localId, 1);
        patch({ phase: "done", bot: "wink", label: "Kept on the Device", about: "Offline, so it’s a new note for now" });
        later(close, DONE_MS);
      }, 900);
      return;
    }

    const target = openTarget();
    if (c.source === "mic" && streaming.current) net.send({ type: "voice.end", streamId: streamId.current, durationMs: r.durationMs, hint: heard || undefined });
    else if (heard) net.send({ type: "voice.scripted", text: heard, cloudText: r.cloudText, durationMs: r.durationMs, target });
    else return miss();

    const sid = streamId.current, scripted = c.source === "script" || !streaming.current;
    const stop = net.on(m => {
      if (m.type !== "note.routed" || (!scripted && m.streamId !== sid)) return;
      stop();
      clearTimeout(slow);
      stopWait.current = null;
      // "Reading the open note" for at least a second, then why, then the result.
      const showWhy = Math.max(0, 1100 - (Date.now() - t0));
      later(() => patch({ about: m.why }), showWhy);
      later(() => {
        const target = notesRef.current.find(n => n.id === m.noteId);
        if (m.action === "new") select(m.noteId, 1);
        else select(m.noteId);
        setHl({ noteId: m.noteId, text: m.added });
        later(() => setHl(null), 4500);
        patch(m.action === "append"
          ? { phase: "done", bot: "happy", label: `Added to “${short(target ? splitNote(target.text).title : "the note")}”`, about: `Added “${short(m.added.replace(/[.!?]$/, ""), 40)}” to the end` }
          : { phase: "done", bot: "wink", label: "New note", about: `Saved as “${short(splitNote(m.added).title, 40)}”` });
        later(close, DONE_MS); // stays up long enough to read
      }, showWhy + 1100);
    });
    const slow = window.setTimeout(() => {
      stop();
      patch({ phase: "done", bot: "idle", label: "Saved", about: "The server is slow. It’ll show up in a moment" });
      later(close, 3000);
    }, 9000);
    stopWait.current = () => { stop(); clearTimeout(slow); };
  };

  /* ---------- Controls ---------- */
  const noteKeys = cur && !cur.id.startsWith("local:") ? { d: cur.suggestionState === "ready" ? "Review tasks" : "Suggest tasks", c: "Delete" } : {};
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
    // C deletes (a risky action: the server asks for the push bar). D suggests or reviews tasks.
    const local = !cur || cur.id.startsWith("local:");
    if (e.c === "c" && !local) { net.send({ type: "note.delete", noteId: cur!.id }); return true; }
    if (e.c === "d" && !local) {
      if (!online) { toast("I’ll suggest tasks once you’re back online"); return true; }
      if (cur!.suggestionState !== "ready") net.send({ type: "note.suggest", noteId: cur!.id });
      push({ name: "suggest", noteId: cur!.id });
      return true;
    }
    if (open) {
      if (e.c === "a" && cur && cur.taskIds.length) { push({ name: "note", noteId: cur.id }); return true; }
      if (e.c === "appWheel" || e.c === "up" || e.c === "down") {
        const d = e.c === "appWheel" ? e.dir || 1 : e.c === "up" ? -1 : 1;
        read.current?.scrollBy({ top: d * 44, behavior: "smooth" });
        return true;
      }
      if (e.c === "b") { setOpen(false); return true; }
      return false;
    }
    const n = step(i, e, notes.length);
    if (n !== null) { if (notes[n]) select(notes[n].id, n > i ? 1 : -1); return true; }
    if (e.c === "a" && cur) { setOpen(true); return true; }
    return false;
  }, dict
    ? { mic: dict.phase === "listen" ? "Release to save" : dict.phase === "done" ? "Hold to talk again" : undefined, b: busy ? undefined : "Close" }
    : open
      ? { wheel: "Scroll", mic: "Hold to talk", b: "Back to list", a: cur?.taskIds.length ? "Its tasks" : undefined, ...noteKeys }
      : { wheel: notes.length ? "Browse" : undefined, a: cur ? "Read full width" : undefined, mic: "Hold to talk", ...noteKeys });

  /* ---------- Render ---------- */
  const shown = dict ?? lastDict.current;
  const prev = flip ? notes.find(n => n.id === flip.from) : undefined;
  const sheet = (n: Note | undefined, cls = "", ref?: Ref<HTMLDivElement>) => n ? <Sheet key={n.id + cls} note={n} cls={cls} hl={hl?.noteId === n.id ? hl.text : null} innerRef={ref} /> : null;

  return <div className={"np" + (dict ? " dictating" : "")}>
    <div className={"np-band " + (shown?.phase ?? "")} aria-live="polite">
      <div className="np-bot"><Bot size={76} seed={3} state={dict?.bot ?? "idle"} level={level} fps={dict ? 60 : 8} /></div>
      {shown && <div className="np-band-txt">
        <div className="np-label">
          {shown.phase === "listen" ? <><i className="np-live" />Listening</>
            : shown.phase === "think" ? <>Thinking<span className="np-dots"><i>.</i><i>.</i><i>.</i></span></>
            : shown.phase === "miss" ? "Didn’t catch that" : shown.label}
        </div>
        <div className="np-said">
          {shown.phase === "miss" ? <span className="np-wait">Hold the mic and talk. I’ll keep it as a note.</span>
            : shown.heard ? `“${shown.heard}”` : <span className="np-wait">Say what’s on your mind</span>}
        </div>
        {shown.about && <div className="np-about">{shown.about}</div>}
      </div>}
      {shown?.phase === "listen" && <span className="np-pill">Release to save</span>}
      {shown?.phase === "done" && <span className="np-pill">B to close</span>}
    </div>

    <div className="np-app">
      <div className={"np-head" + (open ? " full" : "")}>
        <PadStatus />
        <div className="np-title">{Folder}Notes</div>
        <span className="np-count">{notes.length} note{notes.length === 1 ? "" : "s"}</span>
      </div>
      {open && cur ? <div className="np-pane full">{sheet(cur, "scroll", read)}</div> : <>
        <div className="np-list" ref={list}>
          {notes.map((n, k) => {
            const { title, body } = splitNote(n.text);
            return <div key={n.id} className={"np-row" + (k === i ? " sel" : "") + (hl?.noteId === n.id ? " fresh" : "")}>
              <div className="np-row-t">{title || "Untitled"}</div>
              <div className="np-row-m">{when(n.createdAt)}{body ? " · " + body.replace(/\n/g, " ") : ""}</div>
            </div>;
          })}
          {!notes.length && <p className="np-empty">No notes yet. Hold the mic and say anything.</p>}
        </div>
        <div className="np-pane">
          {flip && prev && cur
            ? flip.dir > 0 ? <>{sheet(cur)}{sheet(prev, "lift")}</> : <>{sheet(prev)}{sheet(cur, "drop")}</>
            : cur ? sheet(cur) : <div className="np-sheet" />}
        </div>
      </>}
      <div className={"np-foot" + (open ? " full" : "")} />
    </div>
  </div>;
}

function Sheet({ note, cls, hl, innerRef }: { note: Note; cls: string; hl: string | null; innerRef?: Ref<HTMLDivElement> }) {
  const { title, body } = splitNote(note.text);
  const added = hl && body.endsWith(hl) ? hl : null;
  const local = note.id.startsWith("local:");
  return <div className={"np-sheet " + cls} ref={innerRef}>
    <div className="np-in">
      <div className="np-margin">{when(note.createdAt)}</div>
      <h2>{title || "Untitled"}</h2>
      {body ? <p>{added ? <>{body.slice(0, body.length - added.length)}<mark className="np-added">{added}</mark></> : body}</p>
        : <p className="np-none">No additional text. Hold the mic to add to it.</p>}
      <div className="np-chips">
        {local && <span className="chip warn"><i className="dot" />On device</span>}
        {note.suggestionState === "ready" && <span className="chip blue">{note.suggestions.length} suggested</span>}
        {note.taskIds.length > 0 && <span className="chip">{note.taskIds.length} task{note.taskIds.length > 1 ? "s" : ""}</span>}
      </div>
    </div>
  </div>;
}

function PadStatus() {
  const n = useNet();
  useTick(10000);
  return <div className="np-status">
    <span className="tnum">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    <span>
      {!n.online && <><i className="off-dot" />Offline</>}
      {n.mode === "dock" && "Docked"}
      <span className={"batt" + (n.mode === "dock" ? " charge" : "")}><i /></span>
    </span>
  </div>;
}

const Folder = <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h3.6c.6 0 1.2.24 1.6.66L12 6h6.5A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5z" /></svg>;
