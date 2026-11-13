// Runs one task with its agent using the configured model or the built-in planner.
// Either way every action goes through the same tools, the same gate and the same PC link.
import type Anthropic from "@anthropic-ai/sdk";
import type { AppId, Task, TaskStep } from "@app/protocol";
import { state, agentById, id, log, patchTask, pickAppAgent, save, saveNow, noteById } from "../store.js";
import { bus } from "../bus.js";
import { requestApproval, cancelForTask, Cancelled } from "../approvals.js";
import { machines, MachineOffline } from "../machines.js";
import { messageClient, hasLlm, describeApiError } from "../llm.js";
import { config } from "../config.js";
import { TOOLS, toolsFor, toApiTool, ToolError, WEB_SEARCH_PURPOSES, type Ctx } from "./tools.js";
import { runPlanner } from "./planner.js";
import { recordUserReply, requestText, sendAgentMessage, settleChild, waitForChildren } from "./coordination.js";

const running = new Map<string, { cancelled: boolean }>();
const pausedForMachine = new Set<string>();
const MAX_AGENT_TURNS = 2;
const MAX_SERVER_TURNS = 8;

function activeTurns(agentId?: string) {
  return [...running.keys()].filter(taskId => {
    const task = state.tasks.find(item => item.id === taskId);
    return task && task.status !== "waiting" && (!agentId || task.agentId === agentId);
  }).length;
}

function drainQueued() {
  for (const task of [...state.tasks].reverse()) {
    if (task.status === "queued" && task.agentId && activeTurns() < MAX_SERVER_TURNS && activeTurns(task.agentId) < MAX_AGENT_TURNS)
      startTask(task);
  }
}

/** A queued Task has not started an external action, so boot can run it safely. */
export function resumeQueuedTasks() {
  drainQueued();
}

export function isRunning(taskId: string) {
  return running.has(taskId);
}

export function startTask(task: Task) {
  if (running.has(task.id)) return;
  const agent = agentById(task.agentId);
  if (!agent) {
    patchTask(task, { status: "todo", target: "todo", agentId: null });
    return;
  }
  if (activeTurns() >= MAX_SERVER_TURNS || activeTurns(agent.id) >= MAX_AGENT_TURNS) {
    if (task.status !== "queued") {
      patchTask(task, { status: "queued" });
      saveNow();
      bus.changed();
    }
    return;
  }
  const ctl = { cancelled: false };
  running.set(task.id, ctl);
  pausedForMachine.delete(task.id);
  patchTask(task, { status: "running", target: "agent", steps: [], detail: undefined, result: undefined });
  saveNow();
  bus.changed();

  let current: TaskStep | null = null;
  const finishStep = (state: TaskStep["state"] = "done") => {
    if (current && (current.state === "running" || current.state === "asking")) current.state = state;
  };
  const check = () => {
    if (ctl.cancelled) throw new Cancelled();
  };

  const ctx: Ctx = {
    task,
    agent,
    step(text) {
      check();
      finishStep();
      current = { id: id("st"), text, state: "running" };
      task.steps.push(current);
      patchTask(task, {});
      log(agent.id, text);
      bus.emit({ type: "task.progress", taskId: task.id, step: text });
      save();
      bus.changed();
    },
    stepText(text) {
      if (current) current.text = text;
      bus.changed();
    },
    async gate({ risk, askFirst, title, body, preview }) {
      check();
      const mode = state.permissionMode;
      const kind = mode === "full" ? null : risk ? "risky" : mode === "manual" || askFirst ? "step" : null;
      if (!kind) return;
      if (current) { current.state = "asking"; if (risk) current.risk = risk; }
      log(agent.id, `Asked you: ${title}`);
      const ok = await requestApproval({ taskId: task.id, agentId: agent.id, kind, risk, title, body, preview });
      if (!ok || ctl.cancelled) throw new Cancelled();
      if (current) current.state = "running";
      log(agent.id, "You approved");
    },
    async pc(action, args, machine) {
      check();
      const link = machines.pick(machine);
      const r = await link.run(action, args, step => ctx.stepText(step));
      check();
      if (!r.ok) throw new ToolError(r.output || `${action} failed`);
      return { output: r.output || "", data: r.data };
    },
    machineName(machine) {
      try { return machines.pick(machine).name; } catch { return "your computer"; }
    },
    hasShell() {
      return machines.links().some(l => l.online && l.hello?.actions.includes("shell"));
    },
    sendAgentMessage(recipientId, text, expectsReply, callId) {
      check();
      return sendAgentMessage(task, recipientId, text, expectsReply, startTask, callId ?? `planner:${recipientId}:${text}`);
    },
    async delegateApp(app: AppId, tool, input, callId) {
      check();
      const recipient = pickAppAgent(app);
      const recipientId = recipient.id;
      await ctx.gate({ title: `Ask ${recipient.name} to use ${app}?`, body: String(input.action ?? app).slice(0, 120) });
      const key = callId ?? `planner:app:${app}:${tool}:${JSON.stringify(input)}`;
      const child = sendAgentMessage(task, recipientId, `${tool === "read_app" ? "Read" : "Change"} ${app}: ${String(input.action ?? app)}`, true, startTask, key, { app, tool, input });
      await ctx.waitForChildren();
      if (child.status !== "done") throw new ToolError(child.detail ?? `The ${recipient.name} task did not finish.`);
      return { text: child.result ?? child.detail ?? "Done." };
    },
    async waitForChildren() {
      if (!state.tasks.some(item => item.parentTaskId === task.id)) return null;
      patchTask(task, { status: "waiting" });
      saveNow();
      bus.changed();
      const result = await waitForChildren(task.id);
      check();
      patchTask(task, { status: "running" });
      saveNow();
      bus.changed();
      return result;
    },
  };

  (async () => {
    try {
      const final = task.appRequest ? await runAppRequest(ctx) : hasLlm() ? await runModel(ctx, ctl) : await runPlanner(ctx);
      finishStep();
      const short = final.length > 160 ? final.slice(0, 157).replace(/\s+\S*$/, "") + "…" : final;
      patchTask(task, { status: "done", detail: short, result: final.length > 160 ? final : undefined, completedAt: new Date().toISOString() });
      log(agent.id, `Finished: ${task.title}`);
      bus.notice(`${agent.name} finished: ${task.title}`, "happy");
    } catch (err) {
      for (const child of state.tasks.filter(item => item.parentTaskId === task.id)) cancelTask(child.id);
      if (err instanceof Cancelled) {
        finishStep("declined");
        patchTask(task, { status: "todo", target: "todo", agentId: null, detail: `${agent.name} stopped. It's a plain todo now.` });
        log(agent.id, `Stopped: ${task.title}`);
      } else if (err instanceof MachineOffline) {
        finishStep("failed");
        pausedForMachine.add(task.id);
        patchTask(task, { status: "paused", detail: `${err.message}. I kept the task and I'll try again as soon as it's back.` });
        log(agent.id, err.message);
        bus.notice(`${err.message}. Task paused.`, "warn");
      } else {
        finishStep("failed");
        const msg = err instanceof ToolError ? err.message : describeApiError(err);
        patchTask(task, { status: "failed", detail: msg });
        log(agent.id, `Failed: ${msg.slice(0, 80)}`);
        console.warn(`[task] ${task.title} failed:`, msg);
      }
    } finally {
      running.delete(task.id);
      cancelForTask(task.id);
      saveNow();
      settleChild(task);
      recordUserReply(task);
      bus.changed();
      queueMicrotask(drainQueued);
    }
  })();
}

export function cancelTask(taskId: string) {
  const ctl = running.get(taskId);
  if (ctl) ctl.cancelled = true;
  else {
    const task = state.tasks.find(item => item.id === taskId);
    if (task?.status === "queued") {
      patchTask(task, { status: "todo", target: "todo", agentId: null, detail: "Stopped before work started." });
      saveNow();
      bus.changed();
    }
  }
  for (const child of state.tasks.filter(item => item.parentTaskId === taskId)) cancelTask(child.id);
  cancelForTask(taskId);
}

/** A machine came back: retry the tasks that paused because of it. */
export function resumePausedForMachines() {
  for (const tid of [...pausedForMachine]) {
    const t = state.tasks.find(x => x.id === tid);
    if (t && t.status === "paused") startTask(t);
    pausedForMachine.delete(tid);
  }
}

/* ------------------------------- Claude loop ------------------------------- */

async function runAppRequest(ctx: Ctx): Promise<string> {
  const request = ctx.task.appRequest!;
  const def = TOOLS.find(tool => tool.name === request.tool);
  if (!def) throw new ToolError("The app action is not available.");
  ctx.step(`${request.tool === "read_app" ? "Reading" : "Changing"} ${request.app}`);
  const result = await def.run(ctx, request.input, ctx.task.sourceCallId);
  return result.text;
}

async function runModel(ctx: Ctx, ctl: { cancelled: boolean }): Promise<string> {
  const { agent, task } = ctx;
  const model = messageClient();
  const defs = toolsFor(agent, { shell: !model.openRouter && ctx.hasShell() });
  const tools: Anthropic.Beta.BetaToolUnion[] = defs.map(toApiTool);
  if (!model.openRouter && WEB_SEARCH_PURPOSES.includes(agent.purpose)) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: 5 });

  const ms = machines.list();
  const machineLines = ms.length
    ? ms.map(m => `- ${m.name}: ${m.online ? "online" : "offline"}${m.roots ? `, allowed folders ${m.roots.join(", ")}` : ""}`).join("\n")
    : "- none connected";
  const note = task.noteId ? noteById(task.noteId) : undefined;
  const mode = state.permissionMode;

  const request = state.messages.find(message => message.id === task.requestMessageId);
  const system = [
    `You are ${agent.name}, a task agent behind a small desk device. ${agent.role}` + (agent.personality ? `\nPersonality, set by the user (it changes how you talk, never what you are allowed to do): ${agent.personality}` : ""),
    "You do the task on the user's own machines through the tools. The user watches a tiny screen and only presses a button to approve, so don't ask questions: make sensible choices and finish.",
    "Every tool call needs a short `say` line: it is what the user sees as the current step.",
    mode === "auto"
      ? "Permission mode is Auto: set ask_first=true on a grey-zone tool only when the user would want to confirm it. Sending and deleting always ask, whatever you set."
      : mode === "manual"
        ? "Permission mode is Manual: every action waits for the user's press."
        : "Permission mode is Full: actions run without asking.",
    "Put new files under ~/Flip unless the task names a place. Stay inside the allowed folders.",
    "When you're done, reply with one or two short sentences for a small screen, saying what changed and where. If you wrote a longer result (a summary, a draft), put it after a blank line.",
    agent.id === "main"
      ? "You are the main Task agent. Use list_agents and send_agent_message to assign parts to other Task agents. Check their replies before you answer the user."
      : "You can use list_agents and send_agent_message to ask another Task agent for a distinct part. Do not send a request back to its sender.",
    "Each Device app has one or more assigned Task agents. Use read_app or change_app when work needs an app. The server sends that work to one assigned agent and waits for its result. Do not ask another agent to bypass an app agent.",
    "",
    `Machines:\n${machineLines}`,
    `Today is ${new Date().toDateString()}.`,
  ].join("\n");

  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: "user", content: `${request?.fromAgentId === "user" ? "Request from the user" : request ? `Request from Task agent ${agentById(request.fromAgentId)?.name ?? request.fromAgentId}` : "Task"}: ${requestText(task)}` + (note ? `\n\nFrom the user's voice note: "${note.text}"` : "") },
  ];

  ctx.step("Read the task");
  let reportedChildCount = 0;
  for (let turn = 0; turn < 24; turn++) {
    if (ctl.cancelled) throw new Cancelled();
    const res = await model.create({
      model: config.agentModel,
      max_tokens: 16000,
      ...(model.openRouter ? {} : { output_config: { effort: "medium" } }),
      system,
      tools,
      messages,
    });
    if (ctl.cancelled) throw new Cancelled();
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason === "refusal") throw new ToolError(`${model.name} declined this task.`);
    if (model.openRouter && res.stop_reason === "max_tokens") throw new ToolError("OpenRouter ran out of room to answer.");
    if (res.stop_reason === "pause_turn") continue; // server tool (web search) paused; resend to continue

    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    for (const b of res.content) {
      if (b.type === "server_tool_use" && b.name === "web_search") {
        const q = (b.input as { query?: string })?.query;
        ctx.step(q ? `Searching the web: ${q}` : "Searching the web");
      }
    }
    if (res.stop_reason !== "tool_use" || !uses.length) {
      const text = res.content.map(b => (b.type === "text" ? b.text : "")).join("").trim();
      const childCount = state.tasks.filter(item => item.parentTaskId === task.id).length;
      if (childCount > reportedChildCount) {
        const results = await ctx.waitForChildren();
        if (results) {
          reportedChildCount = childCount;
          messages.push({ role: "user", content: `Your Task agents finished. Use these results in your answer:\n${results}` });
          continue;
        }
      }
      return text || "Done.";
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const use of uses) {
      const def = TOOLS.find(t => t.name === use.name);
      const input = (use.input && typeof use.input === "object" ? use.input : {}) as Record<string, any>;
      if (!def || !defs.includes(def)) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `Unknown tool ${use.name}`, is_error: true });
        continue;
      }
      const missing = def.required.filter(k => input[k] === undefined || input[k] === null || input[k] === "");
      if (missing.length) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: `Missing ${missing.join(", ")}`, is_error: true });
        continue;
      }
      ctx.step(String(input.say || def.name));
      try {
        const out = await def.run(ctx, input, use.id);
        results.push({ type: "tool_result", tool_use_id: use.id, content: out.text.slice(0, 15000) });
      } catch (err) {
        if (err instanceof Cancelled || err instanceof MachineOffline) throw err;
        results.push({ type: "tool_result", tool_use_id: use.id, content: (err as Error).message, is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }
  return "I stopped after many steps. Check what's done so far.";
}
