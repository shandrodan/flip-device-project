// A command spoken in Notes or To-Do goes to that app's Task agent (ADR 0031). The dictation band
// stays up and follows the agent's Task: its current step, a press it needs, then its answer.
import type { Task } from "@app/protocol";
import type { BotState } from "../../bot/Bot";

export interface FollowView {
  /** work: the agent is still going. done: final, the band can close after a while. */
  phase: "work" | "done";
  bot: BotState;
  label: string;
  about: string;
  /** The agent's answer, shown in place of what you said. */
  reply?: string;
}

/** How long the answer stays up, so a two-line reply can be read. */
export const REPLY_MS = 9000;

export function followView(task: Task | undefined, agentName: string): FollowView {
  const step = task?.steps[task.steps.length - 1]?.text ?? "";
  switch (task?.status) {
    case undefined:
    case "queued":
      return { phase: "work", bot: "think", label: `Sent to ${agentName}`, about: task?.status === "queued" ? "Waiting for a free agent" : "Starting" };
    case "running":
    case "waiting":
      return { phase: "work", bot: "think", label: `${agentName} is on it`, about: step || "Working" };
    case "awaiting-approval":
      return { phase: "work", bot: "wide", label: `${agentName} needs your press`, about: step || "Waiting for your approval" };
    case "held":
      return { phase: "done", bot: "idle", label: "On hold", about: "You pressed Not now. Resume it from the Agents app" };
    case "done":
      return { phase: "done", bot: "happy", label: agentName, about: "", reply: task.detail || "Done." };
    case "failed":
      return { phase: "done", bot: "sad", label: `${agentName} couldn’t do that`, about: "", reply: task.detail || "Something went wrong." };
    case "paused":
      return { phase: "done", bot: "idle", label: "Paused", about: "", reply: task.detail || "Paused. It will try again." };
    case "todo":
      return { phase: "done", bot: "idle", label: "Stopped", about: "Nothing else changed" };
  }
}
