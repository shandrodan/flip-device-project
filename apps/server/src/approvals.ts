// Approval requests (ADR 0004). An agent awaits a promise; the Device answers with an
// approval press. "Not now" holds a task's request until the user resumes it.
import type { ApprovalRequest } from "@app/protocol";
import { state, id, now, taskById, patchTask, saveNow } from "./store.js";
import { bus } from "./bus.js";

export class Cancelled extends Error {
  constructor() {
    super("Stopped");
  }
}

const waiters = new Map<string, (approved: boolean) => void>();

export function requestApproval(req: Omit<ApprovalRequest, "requestId" | "createdAt" | "held">): Promise<boolean> {
  const full: ApprovalRequest = { ...req, requestId: id("ap"), createdAt: now(), held: false };
  state.approvals.push(full);
  if (full.taskId) {
    const t = taskById(full.taskId);
    if (t) patchTask(t, { status: "awaiting-approval" });
  }
  saveNow();
  bus.emit({ type: "approval.request", request: full });
  bus.changed();
  return new Promise(resolve => waiters.set(full.requestId, resolve));
}

function settle(requestId: string, approved: boolean) {
  const i = state.approvals.findIndex(a => a.requestId === requestId);
  if (i < 0) return;
  const [req] = state.approvals.splice(i, 1);
  if (req.taskId && approved) {
    const t = taskById(req.taskId);
    if (t) patchTask(t, { status: "running" });
  }
  waiters.get(requestId)?.(approved);
  waiters.delete(requestId);
  saveNow();
  bus.emit({ type: "approval.resolved", requestId, approved });
  bus.changed();
}

/** The Device pressed approve (push bar / A) or "Not now" (B). */
export function press(requestId: string, approved: boolean) {
  const req = state.approvals.find(a => a.requestId === requestId);
  if (!req) return;
  if (approved) return settle(requestId, true);
  if (req.taskId) {
    // Hold it: the agent keeps waiting, the screen lets go.
    req.held = true;
    const t = taskById(req.taskId);
    if (t) patchTask(t, { status: "held" });
    saveNow();
    bus.emit({ type: "approval.resolved", requestId, approved: false });
    bus.changed();
  } else settle(requestId, false);
}

export function resumeHeld(taskId: string) {
  const req = state.approvals.find(a => a.taskId === taskId && a.held);
  if (!req) return false;
  req.held = false;
  const t = taskById(taskId);
  if (t) patchTask(t, { status: "awaiting-approval" });
  saveNow();
  bus.emit({ type: "approval.request", request: req });
  bus.changed();
  return true;
}

export function cancelForTask(taskId: string) {
  for (const a of [...state.approvals]) if (a.taskId === taskId) settle(a.requestId, false);
}
