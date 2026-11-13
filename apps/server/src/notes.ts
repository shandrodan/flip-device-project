// Dumps become notes instantly (ADR 0005), then get a better transcript and suggestions.
import type { Note, VoiceTarget } from "@app/protocol";
import { state, id, now, noteById, log, save } from "./store.js";
import { bus } from "./bus.js";
import { transcribe } from "./voice.js";
import { suggestTasks } from "./suggest.js";

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

  if (s.target.kind === "append") {
    const stt = await transcribe(audio, s.mime);
    const text = stt?.text || quick;
    appendToNote(s.target.noteId, text);
    return;
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

/** Scripted voice for rehearsals: `text` is what was "heard" live, `cloudText` the cloud's version. */
export async function voiceScripted(text: string, cloudText: string | undefined, durationMs: number, target: VoiceTarget) {
  if (target.kind === "append") return appendToNote(target.noteId, cloudText || text);
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

function appendToNote(noteId: string, text: string) {
  const note = noteById(noteId);
  if (!note || !text.trim()) {
    bus.notice("Didn't catch that.", "warn");
    bus.emit({ type: "state", state: "idle" });
    return;
  }
  note.text = `${note.text.replace(/\s+$/, "")} ${text.trim()}`;
  note.editedByUser = true; // your words now: the cloud never overwrites them
  if (note.suggestionState !== "accepted") note.suggestionState = "pending";
  save();
  bus.changed();
  bus.notice("Added to the note", "ok");
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
