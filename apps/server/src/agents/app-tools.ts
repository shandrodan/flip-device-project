/** Typed actions for the Device apps. The server owns app state and approval. */
import { APP_IDS, isAppCommand, type Agent, type AppId, type Note, type Task } from "@app/protocol";
import { bus } from "../bus.js";
import { id, now, ownsApp, patchTask, saveNow, state, taskById } from "../store.js";
import type { ToolDef } from "./tools.js";

/** Statuses where an agent is mid-work. Those Tasks are not changed or deleted under it. */
const ACTIVE = new Set<Task["status"]>(["queued", "running", "waiting", "awaiting-approval", "held"]);
/** Tasks the To-Do app lists. Spoken commands are hidden there (ADR 0031). */
const todoItems = () => state.tasks.filter(task => !isAppCommand(task));

/** One ID in `id`, or several in `ids`. Unknown IDs fail the whole call so nothing half happens. */
function idsOf(input: Record<string, unknown>): string[] {
  const list = Array.isArray(input.ids) ? input.ids : typeof input.id === "string" && input.id ? [input.id] : [];
  const ids = [...new Set(list.filter((value): value is string => typeof value === "string" && !!value))];
  if (!ids.length) throw new Error("Give an ID in id, or several in ids, from read_app.");
  if (ids.length > 500) throw new Error("At most 500 items per call.");
  return ids;
}
const titles = (items: { title?: string; text?: string }[]) =>
  items.slice(0, 4).map(item => `• ${(item.title ?? item.text ?? "").split("\n")[0].slice(0, 60)}`).join("\n") + (items.length > 4 ? `\n…and ${items.length - 4} more` : "");
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

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
        case "notes": return { text: JSON.stringify({
          count: state.notes.length,
          notes: state.notes.slice(0, 200).map(note => ({ id: note.id, text: note.text.slice(0, 400), createdAt: note.createdAt })),
        }) };
        case "todo": return { text: JSON.stringify({
          projects: state.projects.map(({ id, name }) => ({ id, name })),
          count: todoItems().length,
          tasks: todoItems().slice(0, 200)
            .map(({ id, title, status, due, projectId, agentId }) => ({ id, title, status, due: due ?? null, projectId: projectId ?? null, agentId })),
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
    description: "Change a built-in Device app. Use notes.create to save a Note, notes.append to add text, notes.replace to replace a Note's text, or notes.delete to delete Notes. Use todo.create for new work, todo.update to rename, reschedule, or move To-Dos between projects, todo.complete or todo.reopen to change whether they are done, and todo.delete to delete them. notes.delete, todo.update, todo.complete, todo.reopen and todo.delete take several IDs in ids, so one call handles 'all' or 'every' requests: never call them once per item. Read the app first to resolve existing Notes, To-Dos and projects by name and use the returned IDs. Omit fields the user didn't ask to change. Full permission mode and keys are user-only.",
    props: {
      action: { type: "string", enum: ["notes.create", "notes.append", "notes.replace", "notes.delete", "todo.create", "todo.update", "todo.complete", "todo.reopen", "todo.delete", "focus.start", "focus.stop", "agents.create", "settings.permission"] },
      text: { type: "string", description: "Note content or To-Do title." },
      id: { type: "string", description: "Existing Note or To-Do ID from read_app." },
      ids: { type: "array", items: { type: "string" }, description: "Several Note or To-Do IDs from read_app, for the actions that change many at once." },
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
      if (action === "notes.delete") {
        const ids = idsOf(input);
        const notes = ids.map(noteId => state.notes.find(note => note.id === noteId));
        if (notes.some(note => !note)) throw new Error("A Note was not found. Read the app again.");
        // Deleting is a Risky action: it always takes the push bar.
        await ctx.gate({ risk: "delete", title: `Delete ${plural(notes.length, "Note")}?`, body: `${titles(notes as Note[])}\nYou can't undo this.` });
        const gone = new Set(ids);
        const before = state.notes.length;
        state.notes = state.notes.filter(note => !gone.has(note.id));
        saveNow(); bus.changed();
        return { text: `Deleted ${plural(before - state.notes.length, "Note")}. ${plural(state.notes.length, "Note")} left.` };
      }
      if (action === "todo.update") {
        const ids = idsOf(input);
        const tasks = ids.map(taskById);
        if (tasks.some(task => !task || isAppCommand(task))) throw new Error("To-Do not found. Read the app again.");
        if ("text" in input && !text) throw new Error("The new To-Do title must contain text.");
        if (text && ids.length > 1) throw new Error("Rename one To-Do at a time.");
        const busy = (tasks as Task[]).filter(task => ACTIVE.has(task.status));
        if (busy.length) throw new Error(`An agent is working on ${busy.map(task => `"${task.title}"`).join(", ")}. Leave it or stop it first.`);
        const patch = { ...todoLocation(input), ...(text ? { title: text } : {}) };
        if (!Object.keys(patch).length) throw new Error("Give a new title, due date or project.");
        await ctx.gate({ title: ids.length > 1 ? `Update ${plural(ids.length, "To-Do")}?` : "Update this To-Do?", body: titles(tasks as Task[]) });
        if ((tasks as Task[]).some(task => taskById(task.id) !== task)) throw new Error("The To-Dos changed. Read them again before editing.");
        for (const task of tasks as Task[]) patchTask(task, patch);
        saveNow(); bus.changed();
        return { text: JSON.stringify((tasks as Task[]).map(task => ({ id: task.id, title: task.title, due: task.due ?? null, projectId: task.projectId ?? null }))) };
      }
      if (action === "todo.complete" || action === "todo.reopen") {
        const ids = idsOf(input);
        const tasks = ids.map(taskById);
        if (tasks.some(task => !task || isAppCommand(task))) throw new Error("To-Do not found. Read the app again.");
        const busy = (tasks as Task[]).filter(task => ACTIVE.has(task.status));
        if (busy.length) throw new Error(`An agent is working on ${busy.map(task => `"${task.title}"`).join(", ")}. Leave it or stop it first.`);
        const done = action === "todo.complete";
        await ctx.gate({ title: `${done ? "Complete" : "Reopen"} ${ids.length > 1 ? plural(ids.length, "To-Do") : "this To-Do"}?`, body: titles(tasks as Task[]) });
        for (const task of tasks as Task[]) {
          task.status = done ? "done" : "todo";
          if (!done) { task.target = "todo"; task.agentId = null; }
          task.updatedAt = now();
          task.completedAt = done ? now() : undefined;
        }
        saveNow(); bus.changed();
        return { text: `${done ? "Completed" : "Reopened"} ${plural(ids.length, "To-Do")}.` };
      }
      if (action === "todo.delete") {
        const ids = idsOf(input);
        const tasks = ids.map(taskById);
        if (tasks.some(task => !task || isAppCommand(task))) throw new Error("To-Do not found. Read the app again.");
        const busy = (tasks as Task[]).filter(task => ACTIVE.has(task.status));
        if (busy.length) throw new Error(`An agent is working on ${busy.map(task => `"${task.title}"`).join(", ")}. Leave it or stop it first.`);
        await ctx.gate({ risk: "delete", title: `Delete ${plural(ids.length, "To-Do")}?`, body: `${titles(tasks as Task[])}\nYou can't undo this.` });
        const gone = new Set(ids);
        const before = state.tasks.length;
        state.tasks = state.tasks.filter(task => !gone.has(task.id) || ACTIVE.has(task.status));
        for (const note of state.notes) note.taskIds = note.taskIds.filter(taskId => !gone.has(taskId));
        saveNow(); bus.changed();
        return { text: `Deleted ${plural(before - state.tasks.length, "To-Do")}. ${plural(todoItems().length, "To-Do")} left.` };
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
