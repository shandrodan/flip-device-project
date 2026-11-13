// Shared WebSocket protocol between Device, Dock, server and PC agent.
// This is what real firmware would speak. Change it in a PR everyone sees.
//
// Shape of the conversation:
//   Device/Dock  <->  server   over ws://server:8787/ws      (DeviceMessage / ServerMessage)
//   server       <->  PC agent over ws://<tailscale-ip>:7077  (PcAgentCommand / PcAgentResult)
//
// The server is the source of truth. After every change it broadcasts a full `snapshot`
// (the state is small), plus a few event messages for things the screen reacts to at once.

export const PROTOCOL_VERSION = 5;

/* ============================== Basic words ============================== */

export type DeviceMode = "handheld" | "dock";
export type PermissionMode = "manual" | "auto" | "full";
export type Hosting = "cloud" | "vm" | "self";
export type DeviceState = "idle" | "listening" | "thinking" | "acting" | "awaiting-approval" | "done" | "error";
export type ClientKind = "device" | "dock";
export const APP_IDS = ["notes", "todo", "focus", "agents", "settings"] as const;
export type AppId = (typeof APP_IDS)[number];

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
  | "queued" // waits for a Task agent run slot
  | "running" // an agent is working on it
  | "waiting" // an agent waits for another Task agent
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
  parentTaskId?: string;
  sourceTaskId?: string;
  sourceCallId?: string;
  appRequest?: { app: AppId; tool: "read_app" | "change_app"; input: Record<string, unknown> };
  requestMessageId?: string;
  depth?: number;
  status: TaskStatus;
  steps: TaskStep[];
  /** One-line reason for paused/failed, or the agent's final answer when done. */
  detail?: string;
  /** Longer output (e.g. a research summary). */
  result?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type AgentShape = "circle" | "squircle" | "capsule" | "pebble" | "cloud" | "drop" | "hexagon" | "triangle" | "flower";
export type AgentPurpose = "main" | "mail" | "pc" | "research" | "writer" | "files" | "custom" | "app";

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

/** A saved user or Task agent message. The server owns delivery and task state. */
export interface AgentMessage {
  id: string;
  fromAgentId: string | "user";
  toAgentId: string;
  taskId: string;
  replyToMessageId?: string;
  kind: "request" | "reply" | "notice";
  text: string;
  createdAt: string;
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
  agents: Agent[];
  appAgents: Record<AppId, string[]>;
  messages: AgentMessage[];
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
 * Where voice goes. "note"/"append"/"auto" make or extend a Note; "main"/"app"/"agent" talk to a Task agent (ADR 0012). "auto" (the Notes app, ADR 0011): the main agent reads the open note and decides.
 * Same topic, or "add to this note …": appended there. Clearly another note: appended there.
 * Otherwise, or "new note …": a new note. The answer comes back as note.routed.
 */
export type VoiceTarget =
  | { kind: "note" }
  | { kind: "append"; noteId: string }
  | { kind: "auto"; openNoteId: string | null }
  | { kind: "main" }
  | { kind: "app"; app: AppId }
  | { kind: "agent"; agentId: string };

export type DeviceMessage =
  | { type: "hello"; deviceId: string; mode: DeviceMode; client: ClientKind; protocol: number }
  | { type: "mode.changed"; mode: DeviceMode }
  // Voice: audio streams in while the mic button is held.
  | { type: "voice.start"; streamId: string; mime: string; target: VoiceTarget }
  | { type: "voice.chunk"; streamId: string; audio: string } // base64
  | { type: "voice.end"; streamId: string; durationMs: number; hint?: string } // hint: on-device transcript
  | { type: "voice.cancel"; streamId: string }
  | { type: "voice.message"; requestId: string; target: Extract<VoiceTarget, { kind: "main" | "agent" | "app" }>; text: string; audio?: string; mime?: string }
  // Scripted voice for rehearsals: the text plays as if spoken. cloudText is what the cloud would hear.
  | { type: "voice.scripted"; streamId?: string; text: string; cloudText?: string; durationMs: number; target: VoiceTarget }
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
  | { type: "approval.press"; requestId: string; approved: boolean; via: "push-bar" | "a-button" | "b-button" }
  | { type: "focus.start"; minutes: number; kind: "focus" | "break" }
  | { type: "focus.stop" }
  | { type: "limits.ack" }
  | { type: "limits.start-window" }
  | { type: "settings.update"; patch: Partial<Pick<Settings, "permissionMode" | "hosting">> }
  | { type: "agent.create"; agent: Pick<Agent, "name" | "purpose" | "shape" | "color">; app?: AppId }
  | { type: "agent.delete"; agentId: string } // risky: answered with an approval request
  | { type: "app.agent.add"; app: AppId; agentId: string }
  | { type: "app.agent.replace"; app: AppId; oldAgentId: string; newAgentId: string }
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
  | { type: "voice.accepted"; streamId: string; taskId: string; agentId: string }
  | { type: "voice.rejected"; streamId: string; reason: string }
  | { type: "suggestions"; noteId: string; suggestions: Suggestion[] }
  /** Where an "auto" dump went: `added` is the text that was saved, `why` one short line the Device shows. */
  | { type: "note.routed"; noteId: string; action: "new" | "append"; added: string; why: string; streamId?: string }
  | { type: "task.progress"; taskId: string; step: string }
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
    if (!m || typeof m.type !== "string") return null;
    if (m.type === "voice.start" || m.type === "voice.scripted") {
      if (!isVoiceTarget(m.target)) return null;
      if (m.type === "voice.start" && (typeof m.streamId !== "string" || typeof m.mime !== "string")) return null;
      if (m.type === "voice.scripted" && (typeof m.text !== "string" || m.text.length > 10_000)) return null;
    }
    if (m.type === "voice.message" && (
      typeof m.requestId !== "string" || m.requestId.length > 100 ||
      !isVoiceTarget(m.target) || (m.target.kind !== "main" && m.target.kind !== "agent" && m.target.kind !== "app") ||
      typeof m.text !== "string" || m.text.length > 10_000 ||
      (m.audio !== undefined && (typeof m.audio !== "string" || m.audio.length > 2_500_000)) ||
      (m.mime !== undefined && (typeof m.mime !== "string" || m.mime.length > 100))
    )) return null;
    if (m.type === "app.agent.add" && (!APP_IDS.includes(m.app) || typeof m.agentId !== "string" || !m.agentId)) return null;
    if (m.type === "app.agent.replace" && (!APP_IDS.includes(m.app) || typeof m.oldAgentId !== "string" || !m.oldAgentId || typeof m.newAgentId !== "string" || !m.newAgentId)) return null;
    if (m.type === "agent.create" && m.app !== undefined && !APP_IDS.includes(m.app)) return null;
    return m as DeviceMessage;
  } catch {
    return null;
  }
}

function isVoiceTarget(value: unknown): value is VoiceTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  if (target.kind === "note" || target.kind === "main") return true;
  if (target.kind === "app") return APP_IDS.includes(target.app as AppId);
  if (target.kind === "append") return typeof target.noteId === "string" && target.noteId.length > 0;
  if (target.kind === "auto") return target.openNoteId === null || (typeof target.openNoteId === "string" && target.openNoteId.length > 0);
  return target.kind === "agent" && typeof target.agentId === "string" && target.agentId.length > 0;
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const m = JSON.parse(raw);
    return m && typeof m.type === "string" ? (m as ServerMessage) : null;
  } catch {
    return null;
  }
}
