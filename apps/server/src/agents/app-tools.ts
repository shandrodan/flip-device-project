/** Typed actions for the Device apps. The server owns app state and approval. */
import { APP_IDS, type Agent, type AppId, type Note, type Task } from "@app/protocol";
import { bus } from "../bus.js";
import { id, now, ownsApp, patchTask, saveNow, state, taskById } from "../store.js";
import type { ToolDef } from "./tools.js";

const SAY = { type: "string", description: "A short action line for the Device." };
const APP = { type: "string", enum: [...APP_IDS, "dock"] };

function todoLocation(input: Record<string, unknown>): Pick<Task, "due" | "projectId"> {
  const location: Pick<Task, "due" | "projectId"> = {};
  if ("due" in input) {
    const due = input.due;
    if (due !== null && (typeof due !== "string" || !/^\d{4}-\d{2}-\d{2}(T(?:[01]\d|2[0-3]):[0-5]\d)?$/.test(due)))
      throw new Error("Use YYYY-MM-DD, YYYY-MM-DDTHH:mm, or null for the due date.");
    if (due !== null) {
      const day = due.slice(0, 10);
      const date = new Date(day);
      if (isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day) throw new Error("That due date does not exist.");
    }
    location.due = due;
  }
  if ("projectId" in input) {
    const projectId = input.projectId;
    if (projectId !== null && (typeof projectId !== "string" || !state.projects.some(project => project.id === projectId)))
      throw new Error("Use a project ID from read_app or null to move the To-Do to Inbox.");
    location.projectId = projectId;
  }
  return location;
}

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
        case "todo": return { text: JSON.stringify({
          projects: state.projects.map(({ id, name }) => ({ id, name })),
          tasks: state.tasks.filter(task => task.target === "todo").slice(0, 50)
            .map(({ id, title, status, due, projectId }) => ({ id, title, status, due: due ?? null, projectId: projectId ?? null })),
        }) };
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
    description: "Change a built-in Device app. Use notes.create to save a Note, notes.append to add text, or notes.replace to replace a Note's text. Use todo.create for new work and todo.update to rename, reschedule, or move an existing To-Do between projects. Read the app first to resolve existing Notes, To-Dos and projects by name and use the returned IDs. Omit fields the user didn't ask to change. Full permission mode and keys are user-only.",
    props: {
      action: { type: "string", enum: ["notes.create", "notes.append", "notes.replace", "todo.create", "todo.update", "todo.complete", "todo.reopen", "focus.start", "focus.stop", "agents.create", "settings.permission"] },
      text: { type: "string", description: "Note content or To-Do title." },
      id: { type: "string", description: "Existing Note or To-Do ID from read_app." },
      due: { type: ["string", "null"], description: "To-Do due date as local YYYY-MM-DD or YYYY-MM-DDTHH:mm. Null clears it." },
      projectId: { type: ["string", "null"], description: "To-Do project ID from read_app. Null moves it to Inbox." },
      name: { type: "string" }, role: { type: "string" },
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
      if (action === "notes.append" || action === "notes.replace") {
        const note = state.notes.find(item => item.id === key);
        if (!note || !text) throw new Error("A valid Note ID and text are required.");
        const replace = action === "notes.replace";
        const originalText = note.text;
        await ctx.gate({ askFirst: replace, title: replace ? "Replace this Note's text?" : "Add to this Note?", body: note.text.slice(0, 100) });
        if (!state.notes.includes(note) || (replace && note.text !== originalText)) throw new Error("The Note changed. Read it again before editing.");
        note.text = replace ? text : `${note.text} ${text}`;
        note.editedByUser = true;
        saveNow(); bus.changed();
        return { text: `Updated Note ${note.id}.` };
      }
      if (action === "todo.create") {
        if (!text) throw new Error("Task text is required.");
        const location = todoLocation(input);
        await ctx.gate({ title: "Add a To-Do?", body: text.slice(0, 100) });
        const task: Task = { id: id("t"), title: text, target: "todo", agentId: null, status: "todo", steps: [], createdAt: now(), updatedAt: now(), ...location };
        state.tasks.unshift(task);
        saveNow(); bus.changed();
        return { text: `Added To-Do ${task.id}.` };
      }
      if (action === "todo.update") {
        const task = taskById(key);
        if (task?.target !== "todo") throw new Error("To-Do not found.");
        if ("text" in input && !text) throw new Error("The new To-Do title must contain text.");
        const patch = { ...todoLocation(input), ...(text ? { title: text } : {}) };
        if (!Object.keys(patch).length) throw new Error("Give a new title, due date or project.");
        await ctx.gate({ title: "Update this To-Do?", body: task.title });
        if (taskById(key) !== task || task.target !== "todo") throw new Error("The To-Do changed. Read it again before editing.");
        patchTask(task, patch);
        saveNow(); bus.changed();
        return { text: JSON.stringify({ id: task.id, title: task.title, due: task.due ?? null, projectId: task.projectId ?? null }) };
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
