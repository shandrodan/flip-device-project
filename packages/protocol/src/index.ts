// Shared WebSocket protocol between Device, Dock, server and PC agent.
// This is what real firmware would speak. Change it in a PR everyone sees.
//
// Shape of the conversation:
//   Device/Dock  <->  server   over ws://server:8787/ws      (DeviceMessage / ServerMessage)
//   server       <->  PC agent over ws://<tailscale-ip>:7077  (PcAgentCommand / PcAgentResult)
//
// The server is the source of truth. After every change it broadcasts a full `snapshot`
// (the state is small), plus a few event messages for things the screen reacts to at once.

export const PROTOCOL_VERSION = 2;

/* ============================== Basic words ============================== */

export type DeviceMode = "handheld" | "dock";
export type PermissionMode = "manual" | "auto" | "full";
export type Hosting = "cloud" | "vm" | "self";
export type DeviceState = "idle" | "listening" | "thinking" | "acting" | "awaiting-approval" | "done" | "error";
export type ClientKind = "device" | "dock";

/** Hard-rule categories. Always need an approval press, except in Full mode (ADR 0004). */
export type RiskKind = "send" | "delete" | "pay" | "leave";

/* ============================== Records ============================== */

export interface Note {
  id: string;
  text: string;
  createdAt: string; // ISO
  transcribedBy: "cloud" | "local";
  editedByUser: boolean;
  durationMs?: number;
  /** Where the task suggestions for this note are. */
  suggestionState: "pending" | "ready" | "accepted" | "dismissed" | "none" | "offline";
  suggestions: Suggestion[];
  taskIds: string[];
}

export interface Suggestion {
  id: string;
  title: string;
  /** Agent that would do it, or null for a plain todo. */
  agentId: string | null;
  /** Short line under the title, e.g. "Mail agent, asks before it sends". */
  why?: string;
}

export type TaskStatus =
  | "todo" // plain todo, kept by the user
  | "running" // an agent is working on it
  | "awaiting-approval" // paused on an approval request shown on screen
  | "held" // the user pressed "Not now" on an approval
  | "paused" // can't reach a machine, or the server restarted
  | "done"
  | "failed";

export interface TaskStep {
  id: string;
  text: string;
  state: "running" | "done" | "failed" | "asking" | "declined";
  risk?: RiskKind;
}

export interface Task {
  id: string;
  noteId?: string;
  title: string;
  target: "todo" | "agent";
  agentId: string | null;
  status: TaskStatus;
  steps: TaskStep[];
  /** One-line reason for paused/failed, or the agent's final answer when done. */
  detail?: string;
  /** Longer output (e.g. a research summary). */
  result?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** When it's due, in local time: "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm" with a time. None: no date. */
  due?: string | null;
  /** The project it belongs to. None: it sits in Inbox. */
  projectId?: string | null;
}

/** A list of tasks in the To-Do app (ADR 0012). */
export interface Project {
  id: string;
  name: string;
  color: string;
}

export type AgentShape = "circle" | "squircle" | "capsule" | "pebble" | "cloud" | "drop" | "hexagon" | "triangle" | "flower";
export type AgentPurpose = "main" | "mail" | "pc" | "research" | "writer" | "files" | "custom";

export interface Agent {
  id: string;
  name: string;
  purpose: AgentPurpose;
  shape: AgentShape;
  color: string;
  seed: number;
  role: string;
  builtin: boolean;
}

export interface ApprovalRequest {
  requestId: string;
  taskId?: string;
  agentId: string;
  /** "risky" = a hard rule: the fire screen and the push bar. "step" = Manual/Auto ask, soft card. */
  kind: "risky" | "step";
  risk?: RiskKind;
  title: string; // "Can I delete 16 files?"
  body?: string;
  preview?: { to?: string; subject?: string; body?: string; attach?: string; files?: string[] };
  createdAt: string;
  /** True while the user has pressed "Not now". Held approvals are not shown until resumed. */
  held: boolean;
}

export interface Activity {
  at: string;
  agentId: string;
  text: string;
}

export interface Machine {
  id: string;
  name: string;
  url: string;
  online: boolean;
  platform?: string;
  roots?: string[];
  actions?: PcAction[];
  lastSeen?: string;
}

export interface Focus {
  lengthMs: number;
  running: boolean;
  endsAt: string | null;
  /** Remaining time when not running. */
  remainingMs: number;
  round: number;
  kind: "focus" | "break";
}

export interface Limits {
  resetAt: string | null;
  back: boolean;
  source: "claude-code" | "manual" | "none";
  machine?: string;
}

export interface Settings {
  permissionMode: PermissionMode;
  hosting: Hosting;
  serverUrl: string;
  provider: "anthropic";
  keySet: boolean;
  keyHint?: string; // last 4 chars
  model: string;
  setupUrl: string;
}

export interface Services {
  /** Claude reachable with a key: real agents. Otherwise the built-in planner runs. */
  llm: "claude" | "planner";
  stt: "cloud" | "local" | "device";
  smtp: boolean;
}

export interface Snapshot {
  version: number;
  serverTime: string;
  notes: Note[];
  tasks: Task[];
  projects: Project[];
  agents: Agent[];
  activity: Activity[];
  approvals: ApprovalRequest[];
  machines: Machine[];
  settings: Settings;
  focus: Focus;
  limits: Limits;
  services: Services;
  devices: { handheld: number; dock: number; mode: DeviceMode };
}

/* ============================== Device -> server ============================== */

/**
 * Where a dump goes. "auto" (the Notes app, ADR 0011): the main agent reads the open note and decides.
 * Same topic, or "add to this note …": appended there. Clearly another note: appended there.
 * Otherwise, or "new note …": a new note. The answer comes back as note.routed.
 */
/**
 * "task" (the To-Do app, ADR 0012): saved as a note first, then the main agent makes it one task with a date,
 * a project and maybe an agent. listId is the open list ("today", "inbox", "scheduled", "completed" or a
 * project id). The answer comes back as task.routed.
 */
export type VoiceTarget =
  | { kind: "note" }
  | { kind: "append"; noteId: string }
  | { kind: "auto"; openNoteId: string | null }
  | { kind: "task"; listId: string | null };

export type DeviceMessage =
  | { type: "hello"; deviceId: string; mode: DeviceMode; client: ClientKind; protocol: number }
  | { type: "mode.changed"; mode: DeviceMode }
  // Voice: audio streams in while the mic button is held.
  | { type: "voice.start"; streamId: string; mime: string; target: VoiceTarget }
  | { type: "voice.chunk"; streamId: string; audio: string } // base64
  | { type: "voice.end"; streamId: string; durationMs: number; hint?: string } // hint: on-device transcript
  | { type: "voice.cancel"; streamId: string }
  // Scripted voice for rehearsals: the text plays as if spoken. cloudText is what the cloud would hear.
  | { type: "voice.scripted"; text: string; cloudText?: string; durationMs: number; target: VoiceTarget }
  // A note saved while offline, sent once the Device is back online.
  | { type: "note.sync"; note: { localId: string; text: string; createdAt: string; durationMs: number; editedByUser: boolean; audio?: string; mime?: string; cloudText?: string } }
  | { type: "note.delete"; noteId: string } // risky: answered with an approval request
  | { type: "note.suggest"; noteId: string }
  | { type: "suggestion.accept"; noteId: string; suggestionIds: string[]; asTodos: boolean }
  | { type: "suggestion.dismiss"; noteId: string }
  | { type: "task.complete"; taskId: string }
  | { type: "task.reopen"; taskId: string }
  | { type: "task.assign"; taskId: string; agentId: string }
  | { type: "task.resume"; taskId: string }
  | { type: "task.cancel"; taskId: string }
  | { type: "task.reschedule"; taskId: string; due: string | null }
  | { type: "approval.press"; requestId: string; approved: boolean; via: "push-bar" | "a-button" | "b-button" }
  | { type: "focus.start"; minutes: number; kind: "focus" | "break" }
  | { type: "focus.stop" }
  | { type: "limits.ack" }
  | { type: "limits.start-window" }
  | { type: "settings.update"; patch: Partial<Pick<Settings, "permissionMode" | "hosting">> }
  | { type: "agent.create"; agent: Pick<Agent, "name" | "purpose" | "shape" | "color"> }
  | { type: "agent.delete"; agentId: string } // risky: answered with an approval request
  | { type: "machine.check"; machineId: string }
  | { type: "demo.reset" }
  | { type: "ping"; t: number };

/* ============================== Server -> device ============================== */

export type ServerMessage =
  | { type: "welcome"; serverId: string; protocol: number }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "state"; state: DeviceState }
  | { type: "transcript.partial"; streamId: string; text: string }
  | { type: "note.saved"; note: Note; streamId?: string; localId?: string }
  | { type: "suggestions"; noteId: string; suggestions: Suggestion[] }
  /** Where an "auto" dump went: `added` is the text that was saved, `why` one short line the Device shows. */
  | { type: "note.routed"; noteId: string; action: "new" | "append"; added: string; why: string; streamId?: string }
  | { type: "task.progress"; taskId: string; step: string }
  /** Where a To-Do dump went: `label` is the headline ("Added to Pitch deck"), `why` one short line. */
  | { type: "task.routed"; taskId: string; noteId: string; label: string; why: string; streamId?: string }
  | { type: "approval.request"; request: ApprovalRequest }
  | { type: "approval.resolved"; requestId: string; approved: boolean }
  | { type: "agent.created"; agentId: string }
  | { type: "notice"; text: string; tone: "info" | "ok" | "warn" | "happy" }
  | { type: "pong"; t: number }
  | { type: "error"; message: string };

/* ============================== Server <-> PC agent ============================== */

/**
 * Everything a PC agent may do. Paths must sit inside the agent's allowed roots.
 * "fs.trash" never deletes: it moves files into ~/.flip-trash so a delete can be undone.
 * "shell" exists only when the PC agent was started with --allow-shell.
 */
export type PcAction =
  | "fs.list"
  | "fs.read"
  | "fs.write"
  | "fs.mkdir"
  | "fs.move"
  | "fs.trash"
  | "fs.duplicates"
  | "open"
  | "notify"
  | "shell"
  | "claude.window";

export type PcAgentCommand =
  | { type: "pc.auth"; token: string; server: string }
  | { type: "pc.run"; requestId: string; action: PcAction; args: Record<string, unknown> }
  | { type: "pc.ping"; t: number };

export interface PcHello {
  type: "pc.hello";
  machineId: string;
  name: string;
  platform: string;
  home: string;
  roots: string[];
  actions: PcAction[];
}

export type PcAgentResult =
  | PcHello
  | { type: "pc.progress"; requestId: string; step: string }
  | { type: "pc.done"; requestId: string; ok: boolean; output?: string; data?: unknown }
  | { type: "pc.pong"; t: number }
  | { type: "pc.error"; message: string };

/** Result shapes for the PC actions that return data. */
export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: string;
}

/* ============================== Helpers ============================== */

export const RISK_LABEL: Record<RiskKind, string> = {
  send: "Send",
  delete: "Delete",
  pay: "Pay",
  leave: "Leaving your machines",
};

export function parseDeviceMessage(raw: string): DeviceMessage | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m.type === "string" ? (m as DeviceMessage) : null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m.type === "string" ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}
