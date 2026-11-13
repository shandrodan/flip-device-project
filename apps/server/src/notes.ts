// Dumps become notes instantly (ADR 0005), then get a better transcript and suggestions.
import type { Note, Task, VoiceTarget } from "@app/protocol";
import { state, id, now, noteById, log, save } from "./store.js";
import { routeTask } from "./tasks.js";
import { startTask } from "./agents/runner.js";
import { bus } from "./bus.js";
import { transcribe } from "./voice.js";
import { suggestTasks } from "./suggest.js";
import { routeDump } from "./route.js";
import { acceptVoiceMessage } from "./agents/coordination.js";
import { startTask } from "./agents/runner.js";

interface Stream {
  mime: string;
  target: VoiceTarget;
  chunks: Buffer[];
  started: number;
}
const streams = new Map<string, Stream>();

export function voiceStart(streamId: string, mime: string, target: VoiceTarget) {
  streams.set(streamId, { mime, target, chunks: [], started: Date.now() });
  bus.emit({ type: "state", state: "listening" });
}

export function voiceChunk(streamId: string, b64: string) {
  const s = streams.get(streamId);
  if (s && s.chunks.length < 4000) s.chunks.push(Buffer.from(b64, "base64"));
}

export function voiceCancel(streamId: string) {
  streams.delete(streamId);
  bus.emit({ type: "state", state: "idle" });
}

const fmt = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;

export async function voiceEnd(streamId: string, durationMs: number, hint?: string) {
  const s = streams.get(streamId);
  streams.delete(streamId);
  if (!s) return;
  const audio = Buffer.concat(s.chunks);
  const quick = (hint || "").trim();
  bus.emit({ type: "state", state: "thinking" });

  if (s.target.kind === "auto") {
    const stt = await transcribe(audio, s.mime);
    return routeAuto(stt?.text || quick, s.target.openNoteId, durationMs, stt?.by || "local", streamId);
  }

  if (s.target.kind === "task") {
    const stt = await transcribe(audio, s.mime);
    return routeTaskDump(stt?.text || quick, s.target.listId, durationMs, stt?.by || "local", streamId);
  }

  if (s.target.kind === "append") {
    const stt = await transcribe(audio, s.mime);
    const text = stt?.text || quick;
    appendToNote(s.target.noteId, text);
    return;
  }

  if (s.target.kind === "main" || s.target.kind === "agent" || s.target.kind === "app") {
    const stt = await transcribe(audio, s.mime);
    const text = stt?.text || quick;
    if (!text.trim()) {
      bus.notice("No speech was transcribed. Try again.", "warn");
      bus.emit({ type: "state", state: "idle" });
      return;
    }
    return sendToAgent(s.target, text, streamId);
  }

  // Save first, with whatever text we already have, so the screen reacts at once.
  const note = createNote(quick || "Transcribing…", "local", durationMs);
  bus.emit({ type: "note.saved", note, streamId });
  const stt = await transcribe(audio, s.mime);
  const current = noteById(note.id);
  if (!current) return;
  if (stt && !current.editedByUser) {
    current.text = stt.text;
    current.transcribedBy = stt.by;
  } else if (!stt && !quick) {
    current.text = `Voice note (${fmt(durationMs)}). Set up speech to text on the server to transcribe it.`;
    current.suggestionState = "none";
    save();
    bus.changed();
    return;
  }
  save();
  bus.changed();
  await runSuggestions(current);
}

/** Hand speech to a Task agent. A refusal (agent gone, empty, too long) reaches the Device instead of leaving the mic busy. */
function sendToAgent(target: Extract<VoiceTarget, { kind: "main" | "agent" | "app" }>, text: string, streamId: string) {
  try {
    const task = acceptVoiceMessage(target, text, streamId, startTask);
    bus.emit({ type: "voice.accepted", streamId, taskId: task.id, agentId: task.agentId! });
  } catch (error) {
    bus.emit({ type: "voice.rejected", streamId, reason: (error as Error).message });
    bus.emit({ type: "state", state: "idle" });
  }
}

/** Scripted voice for rehearsals: `text` is what was "heard" live, `cloudText` the cloud's version. */
export async function voiceScripted(text: string, cloudText: string | undefined, durationMs: number, target: VoiceTarget, streamId = id("voice")) {
  if (target.kind === "append") return appendToNote(target.noteId, cloudText || text);
  if (target.kind === "auto") return routeAuto(cloudText || text, target.openNoteId, durationMs, cloudText ? "cloud" : "local", streamId);
  if (target.kind === "task") return routeTaskDump(cloudText || text, target.listId, durationMs, cloudText ? "cloud" : "local", streamId);
  if (target.kind === "main" || target.kind === "agent" || target.kind === "app") {
    return sendToAgent(target, cloudText || text, streamId);
  }
  const note = createNote(text, "local", durationMs);
  bus.emit({ type: "note.saved", note });
  await new Promise(r => setTimeout(r, 350));
  const current = noteById(note.id);
  if (!current) return;
  if (cloudText && !current.editedByUser) {
    current.text = cloudText;
    current.transcribedBy = "cloud";
  }
  save();
  bus.changed();
  await runSuggestions(current);
}

/** A note saved on the Device while it was offline. */
export async function syncOfflineNote(n: { localId: string; text: string; createdAt: string; durationMs: number; editedByUser: boolean; audio?: string; mime?: string; cloudText?: string }) {
  const note = createNote(n.text, "local", n.durationMs, n.createdAt);
  note.editedByUser = n.editedByUser;
  bus.emit({ type: "note.saved", note, localId: n.localId });
  // Re-transcribe with the cloud, but never over the user's own edits.
  if (!note.editedByUser) {
    const stt = n.audio ? await transcribe(Buffer.from(n.audio, "base64"), n.mime || "audio/webm") : null;
    if (stt?.by === "cloud") { note.text = stt.text; note.transcribedBy = "cloud"; }
    else if (n.cloudText) { note.text = n.cloudText; note.transcribedBy = "cloud"; }
  }
  save();
  bus.changed();
  await runSuggestions(note);
  return note.transcribedBy === "cloud";
}

function createNote(text: string, by: "cloud" | "local", durationMs: number, createdAt = now()): Note {
  const note: Note = { id: id("n"), text, createdAt, transcribedBy: by, editedByUser: false, durationMs, suggestionState: "pending", suggestions: [], taskIds: [] };
  state.notes.unshift(note);
  log("main", "Saved a note");
  save();
  bus.changed();
  return note;
}

/** Dumps in Notes (ADR 0011): the main agent decides between the open note, another note, or a new one. */
async function routeAuto(raw: string, openNoteId: string | null, durationMs: number, by: "cloud" | "local", streamId?: string) {
  const text = raw.trim();
  if (!text) {
    bus.notice("Didn't catch that.", "warn");
    bus.emit({ type: "state", state: "idle" });
    return;
  }
  const r = await routeDump(text, openNoteId);
  if (r.action === "append" && r.noteId && noteById(r.noteId)) {
    // A new line, so a list stays a list.
    appendToNote(r.noteId, r.text, { sep: "\n", quiet: true });
    bus.emit({ type: "note.routed", noteId: r.noteId, action: "append", added: r.text, why: r.why, streamId });
    return;
  }
  const note = createNote(r.text, by, durationMs);
  bus.emit({ type: "note.saved", note, streamId });
  bus.emit({ type: "note.routed", noteId: note.id, action: "new", added: r.text, why: r.why, streamId });
  await runSuggestions(note);
}

/** Dumps in To-Do (ADR 0016): kept as a note, then made one task. No suggestions: the task is the answer. */
async function routeTaskDump(raw: string, listId: string | null, durationMs: number, by: "cloud" | "local", streamId?: string) {
  const text = raw.trim();
  if (!text) {
    bus.notice("Didn't catch that.", "warn");
    bus.emit({ type: "state", state: "idle" });
    return;
  }
  const r = await routeTask(text, listId);
  const note = createNote(/[.!?]$/.test(text) ? text : text + ".", by, durationMs);
  const t = now();
  const task: Task = { id: id("t"), noteId: note.id, title: r.title, target: r.agentId ? "agent" : "todo", agentId: r.agentId, status: "todo", steps: [], createdAt: t, updatedAt: t, due: r.due, projectId: r.projectId };
  state.tasks.unshift(task);
  note.taskIds.push(task.id);
  note.suggestionState = "accepted"; // createNote already logged it; a second entry in the same ms would share its key
  save();
  bus.changed();
  bus.emit({ type: "note.saved", note, streamId });
  bus.emit({ type: "task.routed", taskId: task.id, noteId: note.id, label: r.label, why: r.why, streamId });
  bus.emit({ type: "state", state: "idle" });
  if (task.agentId) startTask(task);
}

function appendToNote(noteId: string, text: string, o: { sep?: string; quiet?: boolean } = {}) {
  const note = noteById(noteId);
  if (!note || !text.trim()) {
    bus.notice("Didn't catch that.", "warn");
    bus.emit({ type: "state", state: "idle" });
    return;
  }
  note.text = `${note.text.replace(/\s+$/, "")}${o.sep ?? " "}${text.trim()}`;
  note.editedByUser = true; // your words now: the cloud never overwrites them
  if (note.suggestionState !== "accepted") note.suggestionState = "pending";
  save();
  bus.changed();
  if (!o.quiet) bus.notice("Added to the note", "ok");
  if (note.suggestionState === "pending") void runSuggestions(note);
}

export async function runSuggestions(note: Note) {
  note.suggestionState = "pending";
  bus.emit({ type: "state", state: "thinking" });
  bus.changed();
  try {
    note.suggestions = await suggestTasks(note);
    note.suggestionState = note.suggestions.length ? "ready" : "none";
  } catch (err) {
    console.warn("[suggest]", (err as Error).message);
    note.suggestionState = "none";
  }
  save();
  bus.emit({ type: "suggestions", noteId: note.id, suggestions: note.suggestions });
  bus.emit({ type: "state", state: "idle" });
  bus.changed();
}
