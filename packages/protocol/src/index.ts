// Shared WebSocket protocol between device, server and PC agent.
// This is what real firmware would speak. Change it in a PR everyone sees.

export type DeviceMode = "handheld" | "dock";
export type PermissionMode = "manual" | "auto" | "full";
export type DeviceState = "idle" | "listening" | "thinking" | "acting" | "awaiting-approval" | "done" | "error";

export interface Note {
  id: string;
  text: string;
  createdAt: string; // ISO
  transcribedBy: "cloud" | "local";
  editedByUser: boolean;
}

export interface Task {
  id: string;
  noteId?: string;
  title: string;
  target: "todo" | "agent";
  status: "suggested" | "accepted" | "running" | "awaiting-approval" | "done" | "failed";
}

// Device -> server
export type DeviceMessage =
  | { type: "hello"; deviceId: string; mode: DeviceMode }
  | { type: "mode.changed"; mode: DeviceMode }
  | { type: "voice.start" }
  | { type: "voice.chunk"; audio: string } // base64
  | { type: "voice.end" }
  | { type: "suggestion.accept"; taskId: string }
  | { type: "suggestion.dismiss"; taskId: string }
  | { type: "approval.press"; requestId: string; approved: boolean };

// Server -> device
export type ServerMessage =
  | { type: "state"; state: DeviceState }
  | { type: "transcript.partial"; text: string }
  | { type: "note.saved"; note: Note }
  | { type: "suggestions"; noteId: string; tasks: Task[] }
  | { type: "task.progress"; taskId: string; step: string } // e.g. "opening editor..."
  | { type: "task.updated"; task: Task }
  | { type: "approval.request"; requestId: string; taskId: string; action: string; reason: string }
  | { type: "dock.widgets"; focusEndsAt?: string; todos: Task[]; claudeLimitResetAt?: string };

// Server -> PC agent (over Tailscale)
export type PcAgentCommand = {
  type: "pc.run";
  requestId: string;
  action: string; // TBD: allowed actions, see ADR 0006
  args: Record<string, unknown>;
};

export type PcAgentResult =
  | { type: "pc.progress"; requestId: string; step: string }
  | { type: "pc.done"; requestId: string; ok: boolean; output?: string };
