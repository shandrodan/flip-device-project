/** Typed actions for the Device apps. The server owns app state and approval. */
import { APP_IDS, type Agent, type AppId, type Note, type Task } from "@app/protocol";
import { bus } from "../bus.js";
import { id, now, ownsApp, saveNow, state } from "../store.js";
import type { ToolDef } from "./tools.js";

const SAY = { type: "string", description: "A short action line for the Device." };
const APP = { type: "string", enum: [...APP_IDS, "dock"] };

export const APP_TOOLS: ToolDef[] = [
  {
    name: "read_app",
    description: "Read current data from a built-in Device app. Settings never returns keys.",
    props: { app: APP, say: SAY }, required: ["app", "say"], purposes: "all",
    async run(ctx, input, callId) {
      if (input.app !== "dock" && APP_IDS.includes(input.app) && !ownsApp(input.app as AppId, ctx.agent.id))
        return ctx.delegateApp(input.app as AppId, "read_app", input, callId);
      await ctx.gate({ title: `Read ${input.app}?` });
      switch (input.app) {
        case "notes": return { text: JSON.stringify(state.notes.slice(0, 30).map(note => ({ id: note.id, text: note.text, createdAt: note.createdAt }))) };
        case "todo": return { text: JSON.stringify(state.tasks.filter(task => task.target === "todo").slice(0, 50).map(task => ({ id: task.id, title: task.title, status: task.status }))) };
        case "focus": return { text: JSON.stringify(state.focus) };
        case "agents": return { text: JSON.stringify(state.agents.map(agent => ({ id: agent.id, name: agent.name, role: agent.role }))) };
        case "settings": return { text: JSON.stringify({ permissionMode: state.permissionMode, hosting: state.hosting }) };
        case "build": return { text: JSON.stringify(state.build) };
        case "dock": return { text: JSON.stringify({ focus: state.focus, tasks: state.tasks.filter(task => task.status !== "done").length }) };
        default: throw new Error("Unknown Device app.");
      }
    },
  },
  {
    name: "change_app",
    description: "Change a built-in Device app. Actions: notes.create, notes.append, todo.create, todo.complete, todo.reopen, focus.start, focus.stop, agents.create, settings.permission. Give only fields the action needs. A \"task\" or \"todo\" the user asks for is todo.create (text = its title). Use agents.create only when the user says \"agent\". Full permission mode and keys are user-only.",
    props: {
      action: { type: "string", enum: ["notes.create", "notes.append", "todo.create", "todo.complete", "todo.reopen", "focus.start", "focus.stop", "agents.create", "settings.permission"] },
      text: { type: "string" }, id: { type: "string" }, name: { type: "string" }, role: { type: "string" },
      minutes: { type: "number" }, mode: { type: "string", enum: ["manual", "auto"] }, say: SAY,
    },
    required: ["action", "say"], purposes: "all",
    async run(ctx, input, callId) {
      const action = String(input.action);
      const app = action.split(".")[0];
      if (!APP_IDS.includes(app as AppId)) throw new Error("Unknown Device app action.");
      if (!ownsApp(app as AppId, ctx.agent.id))
        return ctx.delegateApp(app as AppId, "change_app", input, callId);
      const text = typeof input.text === "string" ? input.text.trim() : "";
      const key = typeof input.id === "string" ? input.id : "";
      if (action === "notes.create") {
        if (!text) throw new Error("Text is required.");
        await ctx.gate({ title: "Save a Note?" });
        const note: Note = { id: id("n"), text, createdAt: now(), transcribedBy: "local", editedByUser: true, suggestionState: "none", suggestions: [], taskIds: [] };
        state.notes.unshift(note);
        saveNow(); bus.changed();
        return { text: `Saved Note ${note.id}.` };
      }
      if (action === "notes.append") {
        const note = state.notes.find(item => item.id === key);
        if (!note || !text) throw new Error("A valid Note ID and text are required.");
        await ctx.gate({ title: "Add to this Note?", body: note.text.slice(0, 100) });
        note.text = `${note.text} ${text}`;
        note.editedByUser = true;
        saveNow(); bus.changed();
        return { text: `Updated Note ${note.id}.` };
      }
      if (action === "todo.create") {
        if (!text) throw new Error("Task text is required.");
        await ctx.gate({ title: "Add a To-Do?", body: text.slice(0, 100) });
        const task: Task = { id: id("t"), title: text, target: "todo", agentId: null, status: "todo", steps: [], createdAt: now(), updatedAt: now() };
        state.tasks.unshift(task);
        saveNow(); bus.changed();
        return { text: `Added To-Do ${task.id}.` };
      }
      if (action === "todo.complete" || action === "todo.reopen") {
        const task = state.tasks.find(item => item.id === key && item.target === "todo");
        if (!task) throw new Error("To-Do not found.");
        await ctx.gate({ title: action === "todo.complete" ? "Complete this To-Do?" : "Reopen this To-Do?", body: task.title });
        task.status = action === "todo.complete" ? "done" : "todo";
        task.updatedAt = now();
        task.completedAt = task.status === "done" ? now() : undefined;
        saveNow(); bus.changed();
        return { text: `${task.status === "done" ? "Completed" : "Reopened"} To-Do ${task.id}.` };
      }
      if (action === "focus.start") {
        const minutes = Number(input.minutes);
        if (!Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error("Minutes must be from 1 to 180.");
        await ctx.gate({ title: `Start focus for ${minutes} minutes?` });
        const lengthMs = minutes * 60_000;
        state.focus = { ...state.focus, kind: "focus", lengthMs, remainingMs: lengthMs, running: true, endsAt: new Date(Date.now() + lengthMs).toISOString() };
        saveNow(); bus.changed();
        return { text: "Focus started." };
      }
      if (action === "focus.stop") {
        await ctx.gate({ title: "Stop focus?" });
        state.focus = { ...state.focus, running: false, endsAt: null, remainingMs: state.focus.lengthMs };
        saveNow(); bus.changed();
        return { text: "Focus stopped." };
      }
      if (action === "agents.create") {
        const name = typeof input.name === "string" ? input.name.trim().slice(0, 24) : "";
        const role = typeof input.role === "string" ? input.role.trim().slice(0, 300) : "";
        if (!name || !role) throw new Error("Name and role are required.");
        await ctx.gate({ askFirst: true, title: `Make Task agent ${name}?`, body: role });
        const agent: Agent = { id: id("a"), name, purpose: "custom", shape: "pebble", color: "#34d17a", seed: 40 + state.agents.length * 17, role, builtin: false };
        state.agents.push(agent);
        saveNow(); bus.changed();
        return { text: `Made Task agent ${name} with ID ${agent.id}.` };
      }
      if (action === "settings.permission") {
        if (input.mode !== "manual" && input.mode !== "auto") throw new Error("Only Manual or Auto is available here.");
        await ctx.gate({ askFirst: true, title: `Set permission mode to ${input.mode}?` });
        state.permissionMode = input.mode;
        saveNow(); bus.changed();
        return { text: `Permission mode is ${input.mode}.` };
      }
      throw new Error("Unknown Device app action.");
    },
  },
];
