import type { AgentMessage, Task, VoiceTarget } from "@app/protocol";
import { bus } from "../bus.js";
import { agentById, id, now, pickAppAgent, saveNow, state } from "../store.js";

type AgentTarget = Extract<VoiceTarget, { kind: "main" | "agent" | "app" }>;
type Start = (task: Task) => void;
const childWaiters = new Map<string, Set<() => void>>();
const finished = new Set(["done", "failed", "paused", "todo"]);

function title(text: string) {
  return text.trim().replace(/\s+/g, " ").slice(0, 120);
}

export function requestText(task: Task): string {
  return state.messages.find(message => message.id === task.requestMessageId)?.text ?? task.title;
}

/** Accept one voice request. The request ID makes reconnect and replay safe. */
export function acceptVoiceMessage(target: AgentTarget, text: string, requestId: string, start: Start): Task {
  const existing = state.messages.find(message => message.id === requestId);
  if (existing) {
    const task = state.tasks.find(item => item.id === existing.taskId);
    if (task) return task;
  }
  const agentId = target.kind === "main" ? "main" : target.kind === "app" ? pickAppAgent(target.app).id : target.agentId;
  if (!agentById(agentId)) throw new Error("That Task agent is not available.");
  if (!text.trim()) throw new Error("No speech was transcribed. Try again.");
  if (text.length > 10_000) throw new Error("This speech request is too long.");
  const task: Task = {
    id: id("t"), title: title(text), target: "agent", agentId, status: "todo", steps: [],
    requestMessageId: requestId, depth: 0, createdAt: now(), updatedAt: now(),
    ...(target.kind === "app" ? { app: target.app } : {}),
  };
  const message: AgentMessage = {
    id: requestId, fromAgentId: "user", toAgentId: agentId, taskId: task.id,
    kind: "request", text: text.trim(), createdAt: now(),
  };
  state.tasks.unshift(task);
  state.messages.push(message);
  saveNow();
  bus.changed();
  start(task);
  return task;
}

/** Give a Task agent a saved request or notice from another Task agent. */
export function sendAgentMessage(parent: Task, recipientId: string, text: string, expectsReply: boolean, start: Start, callId: string, appRequest?: Task["appRequest"]): Task {
  const previous = state.tasks.find(task => task.sourceTaskId === parent.id && task.sourceCallId === callId);
  if (previous) return previous;
  const senderId = parent.agentId;
  if (!senderId || !agentById(senderId)) throw new Error("The sender is not available.");
  if (!agentById(recipientId) || recipientId === senderId) throw new Error("Choose another available Task agent.");
  const request = state.messages.find(message => message.id === parent.requestMessageId);
  if (request?.fromAgentId === recipientId) throw new Error("Do not send this request back to its sender.");
  if (!text.trim()) throw new Error("The message is empty.");
  if (text.length > 10_000) throw new Error("The Task agent message is too long.");
  if ((parent.depth ?? 0) >= 2) throw new Error("This request reached its delegation limit.");
  if (state.tasks.filter(task => task.sourceTaskId === parent.id).length >= 4)
    throw new Error("This Task already sent four requests.");
  const task: Task = {
    id: id("t"), title: title(text), target: "agent", agentId: recipientId, status: "todo", steps: [],
    parentTaskId: expectsReply ? parent.id : undefined, sourceTaskId: parent.id, sourceCallId: callId,
    appRequest,
    depth: (parent.depth ?? 0) + 1,
    createdAt: now(), updatedAt: now(),
  };
  const message: AgentMessage = {
    id: id("msg"), fromAgentId: senderId, toAgentId: recipientId, taskId: task.id,
    kind: expectsReply ? "request" : "notice", text: text.trim(), createdAt: now(),
  };
  task.requestMessageId = message.id;
  state.tasks.unshift(task);
  state.messages.push(message);
  saveNow();
  bus.changed();
  start(task);
  return task;
}

function children(parentId: string) {
  return state.tasks.filter(task => task.parentTaskId === parentId);
}

/** Wait for all replies without polling. Child completion wakes the parent. */
export async function waitForChildren(parentId: string): Promise<string | null> {
  const list = children(parentId);
  if (!list.length) return null;
  if (list.some(task => !finished.has(task.status))) {
    await new Promise<void>(resolve => {
      const waiters = childWaiters.get(parentId) ?? new Set<() => void>();
      waiters.add(resolve);
      childWaiters.set(parentId, waiters);
      if (children(parentId).every(task => finished.has(task.status))) resolve();
    });
  }
  return children(parentId).map(task =>
    `${agentById(task.agentId)?.name ?? "Task agent"}: ${task.status}. ${task.result ?? task.detail ?? "No result."}`,
  ).join("\n");
}

/** Record one reply before the parent continues. */
export function settleChild(task: Task) {
  if (!task.parentTaskId || !finished.has(task.status)) return;
  const parent = state.tasks.find(item => item.id === task.parentTaskId);
  const requestId = task.requestMessageId;
  if (parent?.agentId && requestId && !state.messages.some(message => message.replyToMessageId === requestId)) {
    state.messages.push({
      id: id("msg"), fromAgentId: task.agentId ?? "main", toAgentId: parent.agentId,
      taskId: task.id, replyToMessageId: requestId, kind: "reply",
      text: task.result ?? task.detail ?? task.status, createdAt: now(),
    });
    saveNow();
    bus.changed();
  }
  if (parent && children(parent.id).every(item => finished.has(item.status))) {
    for (const resolve of childWaiters.get(parent.id) ?? []) resolve();
    childWaiters.delete(parent.id);
  }
}

/** Put a final answer in the conversation that the Device shows. */
export function recordUserReply(task: Task) {
  if (task.parentTaskId || !task.requestMessageId || !task.agentId) return;
  if (state.messages.some(message => message.replyToMessageId === task.requestMessageId)) return;
  state.messages.push({
    id: id("msg"), fromAgentId: task.agentId, toAgentId: "user", taskId: task.id,
    replyToMessageId: task.requestMessageId, kind: "reply",
    text: task.result ?? task.detail ?? task.status, createdAt: now(),
  });
  saveNow();
  bus.changed();
}
