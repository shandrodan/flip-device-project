/** Typed actions for the Device apps. The server owns app state and approval. */
import { APP_IDS, isAppCommand, type Agent, type AppId, type Note, type Project, type Task } from "@app/protocol";
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

/* ------------------------- Search and filters (P1.10) ------------------------ */
// Reading 200 items per step is slow and costly. Search and filters return only what matters.

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "about", "with", "my", "me", "all", "notes", "note", "that", "this", "is", "are"]);
const words = (text: string) => text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Notes that contain the query's words (a word matches the start of a word in the Note), best first. */
export function searchNotes(query: string): { note: Note; score: number }[] {
  const terms = [...new Set(words(query).filter(word => word.length > 1 && !STOP.has(word)))];
  if (!terms.length) throw new Error("Give a query with at least one real word, e.g. \"venue\".");
  return state.notes
    .map(note => {
      const own = words(note.text);
      return { note, score: terms.filter(term => own.some(word => word.startsWith(term) || (term.length > 4 && word.startsWith(term.slice(0, -1))))).length };
    })
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score);
}

/** Words to find in a Note: exactly as given, then ignoring case. Whole words only at word edges. */
function wordPattern(find: string): { exact: RegExp; loose: RegExp } {
  const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source = `${/^[\p{L}\p{N}]/u.test(find) ? "(?<![\\p{L}\\p{N}])" : ""}${escaped}${/[\p{L}\p{N}]$/u.test(find) ? "(?![\\p{L}\\p{N}])" : ""}`;
  return { exact: new RegExp(source, "gu"), loose: new RegExp(source, "giu") };
}

/** Today in the server's local time, YYYY-MM-DD. */
const localDay = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
export const TODO_FILTERS = ["all", "open", "today", "overdue", "upcoming", "no-date", "done"] as const;

function filterTodos(filter: string, projectId: unknown): Task[] {
  const today = localDay();
  let list = todoItems();
  if (projectId !== undefined && projectId !== null && projectId !== "") {
    if (projectId === "inbox") list = list.filter(task => !task.projectId);
    else if (!state.projects.some(project => project.id === projectId)) throw new Error("Unknown projectId. todo_read returns the projects with their IDs; use \"inbox\" for To-Dos with no project.");
    else list = list.filter(task => task.projectId === projectId);
  }
  const open = (task: Task) => task.status !== "done";
  switch (filter) {
    case "all": return list;
    case "open": return list.filter(open);
    case "today": return list.filter(task => open(task) && task.due?.slice(0, 10) === today);
    case "overdue": return list.filter(task => open(task) && !!task.due && task.due.slice(0, 10) < today);
    case "upcoming": return list.filter(task => open(task) && !!task.due && task.due.slice(0, 10) > today);
    case "no-date": return list.filter(task => open(task) && !task.due);
    case "done": return list.filter(task => !open(task));
    default: throw new Error(`filter is one of ${TODO_FILTERS.join(", ")}.`);
  }
}
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

/** Colors for new projects, in the To-Do app's palette. */
const PROJECT_COLORS = ["#30a46c", "#0090ff", "#e5484d", "#8e4ec6", "#e5780b", "#d6409f", "#12a594", "#ffc53d"];

const BASE_TOOLS: ToolDef[] = [
  {
    name: "read_app",
    description: "Read current data from a Device app that has no read tool of its own (focus, agents, settings, build, dock). Settings never returns keys.",
    props: { app: APP, say: SAY }, required: ["app", "say"], purposes: "all",
    async run(ctx, input, callId) {
      if (input.app !== "dock" && APP_IDS.includes(input.app) && !ownsApp(input.app as AppId, ctx.agent.id))
        return ctx.delegateApp(input.app as AppId, "read_app", input, callId);
      await ctx.gate({ title: `Read ${input.app}?` });
      switch (input.app) {
        case "notes": if (typeof input.query === "string") {
          const hits = searchNotes(input.query);
          return { text: JSON.stringify({
            query: input.query, matches: hits.length, of: state.notes.length,
            notes: hits.slice(0, 100).map(({ note, score }) => ({ id: note.id, text: note.text.slice(0, 400), matched: score })),
          }) };
        } else return { text: JSON.stringify({
          count: state.notes.length,
          notes: state.notes.slice(0, 200).map(note => ({ id: note.id, text: note.text.slice(0, 400), createdAt: note.createdAt })),
        }) };
        case "todo": {
          const filter = typeof input.filter === "string" && input.filter ? input.filter : "all";
          const list = filterTodos(filter, input.projectId);
          return { text: JSON.stringify({
          projects: state.projects.map(({ id, name }) => ({ id, name })),
          today: localDay(), filter, ...(input.projectId ? { projectId: input.projectId } : {}),
          count: list.length, of: todoItems().length,
          tasks: list.slice(0, 200)
            .map(({ id, title, status, due, projectId, agentId }) => ({ id, title, status, due: due ?? null, projectId: projectId ?? null, agentId })),
          }) };
        }
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
    description: "Change a Device app that has no typed tools of its own: start or stop Focus, make a Task agent, or set the permission mode. Notes and To-Do have their own tools (notes_*, todo_*). Full permission mode and keys are user-only.",
    props: {
      // Notes and To-Do actions still run here: the typed tools and the planner send them.
      action: { type: "string", enum: ["focus.start", "focus.stop", "agents.create", "settings.permission"] },
      name: { type: "string", description: "agents.create: the new Task agent's name." }, role: { type: "string", description: "agents.create: what the new Task agent does." },
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
        // One text, or several in texts: one approval and one forward for the whole batch.
        const texts = Array.isArray(input.texts) ? input.texts.map(item => String(item ?? "").trim()) : [text];
        if (!texts.length || texts.some(item => !item)) throw new Error("Give the Note text in text, or several Note texts in texts. None can be empty.");
        if (texts.length > 100) throw new Error("At most 100 Notes per call.");
        await ctx.gate({ title: texts.length > 1 ? `Save ${plural(texts.length, "Note")}?` : "Save a Note?", body: titles(texts.map(item => ({ text: item }))) });
        const made = texts.map((item, index): Note => ({ id: id("n"), text: item, createdAt: new Date(Date.now() + index).toISOString(), transcribedBy: "local", editedByUser: true, suggestionState: "none", suggestions: [], taskIds: [] }));
        // The newest Note is first in the app, so the batch keeps its order there: the last one is on top.
        state.notes.unshift(...[...made].reverse());
        saveNow(); bus.changed();
        return { text: made.length > 1 ? `Saved ${plural(made.length, "Note")}: ${JSON.stringify(made.map(note => ({ id: note.id, text: note.text.slice(0, 80) })))}` : `Saved Note ${made[0].id}.` };
      }
      if (action === "notes.append" || action === "notes.replace") {
        const note = state.notes.find(item => item.id === key);
        if (!key) throw new Error(`${action} needs the Note's ID in id. Read notes with read_app to get it.`);
        if (!note) throw new Error(`No Note has ID ${key}. Read notes with read_app and use an ID from there.`);
        if (!text) throw new Error(`${action} needs the ${action === "notes.replace" ? "new full text" : "text to add"} in text. Call it again with text set.`);
        const replace = action === "notes.replace";
        const originalText = note.text;
        await ctx.gate({ askFirst: replace, title: replace ? "Replace this Note's text?" : "Add to this Note?", body: note.text.slice(0, 100) });
        if (!state.notes.includes(note) || (replace && note.text !== originalText)) throw new Error("The Note changed. Read it again before editing.");
        note.text = replace ? text : `${note.text} ${text}`;
        note.editedByUser = true;
        saveNow(); bus.changed();
        return { text: `Updated Note ${note.id}.` };
      }
      if (action === "notes.edit") {
        // A small change inside a long Note, without retyping it (P1.12).
        const note = state.notes.find(item => item.id === key);
        if (!note) throw new Error(`No Note has ID ${key || "(none)"}. Find it with notes_search and use its ID.`);
        const find = typeof input.find === "string" ? input.find : "";
        const replacement = typeof input.replace === "string" ? input.replace : "";
        if (!find.trim()) throw new Error("Give the exact words to change in find.");
        const pattern = wordPattern(find);
        let count = (note.text.match(pattern.exact) ?? []).length;
        let used = pattern.exact;
        if (!count) { used = pattern.loose; count = (note.text.match(used) ?? []).length; }
        if (!count) throw new Error(`"${find}" is not in that Note. It says: "${note.text.slice(0, 300)}". Copy the words exactly into find.`);
        const originalText = note.text;
        await ctx.gate({ title: "Edit this Note?", body: `${find} → ${replacement || "(removed)"}` });
        if (note.text !== originalText || !state.notes.includes(note)) throw new Error("The Note changed. Read it again before editing.");
        note.text = note.text.replace(used, () => replacement).replace(/[ \t]{2,}/g, " ").trim();
        note.editedByUser = true;
        saveNow(); bus.changed();
        return { text: `Changed ${plural(count, "place")} in Note ${note.id}. It now says: "${note.text.slice(0, 300)}"` };
      }
      if (action === "notes.merge") {
        const ids = idsOf(input);
        if (ids.length < 2) throw new Error("Give at least two Note IDs in ids, in the order to join them.");
        const notes = ids.map(noteId => state.notes.find(note => note.id === noteId));
        if (notes.some(note => !note)) throw new Error("A Note was not found. Find them with notes_search and use their IDs.");
        const [first, ...rest] = notes as Note[];
        // The joined Notes are deleted: ask, since that is hard to undo.
        await ctx.gate({ askFirst: true, title: `Merge ${plural(notes.length, "Note")} into one?`, body: titles(notes as Note[]) });
        if ((notes as Note[]).some(note => !state.notes.includes(note))) throw new Error("A Note changed. Read them again before merging.");
        first.text = (notes as Note[]).map(note => note.text.trim()).filter(Boolean).join("\n\n");
        first.editedByUser = true;
        for (const note of rest) first.taskIds.push(...note.taskIds.filter(taskId => !first.taskIds.includes(taskId)));
        const gone = new Set(rest.map(note => note.id));
        state.notes = state.notes.filter(note => !gone.has(note.id));
        saveNow(); bus.changed();
        return { text: `Merged ${plural(notes.length, "Note")} into Note ${first.id}.` };
      }
      if (action === "todo.create") {
        // One To-Do from text, due and projectId, or several in items: one approval for the batch.
        const raw: Record<string, unknown>[] = Array.isArray(input.items) ? input.items.map((item: unknown) => (item && typeof item === "object" ? item : {}) as Record<string, unknown>) : [input];
        if (!raw.length || raw.length > 100) throw new Error("Give 1 to 100 To-Dos.");
        const items = raw.map(item => {
          const title = String(item.title ?? item.text ?? "").trim();
          if (!title) throw new Error("Every To-Do needs a title. Put it in title.");
          return { title, ...todoLocation(item) };
        });
        await ctx.gate({ title: items.length > 1 ? `Add ${plural(items.length, "To-Do")}?` : "Add a To-Do?", body: titles(items) });
        const made = items.map((item, index): Task => ({ id: id("t"), target: "todo", agentId: null, status: "todo", steps: [], createdAt: new Date(Date.now() + index).toISOString(), updatedAt: now(), ...item }));
        state.tasks.unshift(...[...made].reverse());
        saveNow(); bus.changed();
        return { text: made.length > 1 ? `Added ${plural(made.length, "To-Do")}: ${JSON.stringify(made.map(task => ({ id: task.id, title: task.title, due: task.due ?? null, projectId: task.projectId ?? null })))}` : `Added To-Do ${made[0].id}.` };
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
      if (action === "todo.project_create" || action === "todo.project_rename") {
        const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim().slice(0, 40) : "";
        if (!name) throw new Error("Give the project's name in name.");
        const same = state.projects.find(project => project.name.toLowerCase() === name.toLowerCase());
        if (action === "todo.project_create") {
          if (same) throw new Error(`A project named ${same.name} already exists with ID ${same.id}. Use that ID.`);
          await ctx.gate({ title: `Make project ${name}?` });
          const used = new Set(state.projects.map(project => project.color));
          const color = PROJECT_COLORS.find(value => !used.has(value)) ?? PROJECT_COLORS[state.projects.length % PROJECT_COLORS.length];
          const project: Project = { id: id("p"), name, color };
          state.projects.push(project);
          saveNow(); bus.changed();
          return { text: `Made project ${name} with ID ${project.id}.` };
        }
        const project = state.projects.find(item => item.id === input.projectId);
        if (!project) throw new Error("No project has that ID. todo_read lists the projects with their IDs.");
        if (same && same !== project) throw new Error(`Another project is already named ${same.name} (${same.id}).`);
        await ctx.gate({ title: `Rename ${project.name} to ${name}?` });
        const old = project.name;
        project.name = name;
        saveNow(); bus.changed();
        return { text: `Renamed project ${old} to ${name}.` };
      }
      if (action === "todo.project_delete") {
        const project = state.projects.find(item => item.id === input.projectId);
        if (!project) throw new Error("No project has that ID. todo_read lists the projects with their IDs.");
        const inside = todoItems().filter(task => task.projectId === project.id);
        // Deleting is a Risky action: always the push bar. Its To-Dos are kept, in Inbox.
        await ctx.gate({ risk: "delete", title: `Delete project ${project.name}?`, body: inside.length ? `Its ${plural(inside.length, "To-Do")} move to Inbox.` : "It has no To-Dos." });
        if (!state.projects.includes(project)) throw new Error("The project is already gone.");
        state.projects = state.projects.filter(item => item !== project);
        for (const task of state.tasks) if (task.projectId === project.id) patchTask(task, { projectId: null });
        saveNow(); bus.changed();
        return { text: `Deleted project ${project.name}. ${inside.length ? `${plural(inside.length, "To-Do")} moved to Inbox.` : ""}`.trim() };
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

/* ---------------------------- Typed app tools ---------------------------- */
// Each Device app lists its own small tools with required fields (ADR 0032). A strict, narrow
// tool is far easier for a model than one tool with many actions and shared optional fields.
// Each one runs as read_app or change_app, so app ownership, forwarding and approvals stay the same.

const readApp = BASE_TOOLS.find(tool => tool.name === "read_app")!;
const changeApp = BASE_TOOLS.find(tool => tool.name === "change_app")!;
const IDS = (what: string) => ({ type: "array", items: { type: "string" }, description: `${what} IDs from the read tool. Put every item in one call.` });
const DUE = { type: ["string", "null"], description: "Local due date YYYY-MM-DD or YYYY-MM-DDTHH:mm. Null clears it." };
const PROJECT = { type: ["string", "null"], description: "Project ID from todo_read. Null means Inbox." };

interface AppToolSpec {
  app: AppId;
  name: string;
  description: string;
  props: Record<string, unknown>;
  required: string[];
  /** The change_app action. A spec without one reads the app. */
  action?: string;
}

/** The Device app manifest: what an agent can do in each app. A new app adds its tools here. */
export const APP_MANIFEST: AppToolSpec[] = [
  { app: "notes", name: "notes_read", description: "List all Notes, newest first, with their IDs and text. With many Notes, use notes_search instead.", props: {}, required: [] },
  { app: "notes", name: "notes_search", description: "Find Notes by words in their text, best matches first, with their IDs. Use it before changing or deleting Notes about a topic.",
    props: { query: { type: "string", description: "The words to look for, e.g. \"venue\"." } }, required: ["query"] },
  { app: "notes", name: "notes_create", action: "notes.create", description: "Save new Notes. Pass every Note of the request in one call, in the order the user said them.",
    props: { texts: { type: "array", items: { type: "string" }, description: "The text of each new Note." } }, required: ["texts"] },
  { app: "notes", name: "notes_append", action: "notes.append", description: "Add text to the end of one Note.",
    props: { id: { type: "string", description: "Note ID from notes_read." }, text: { type: "string", description: "Text to add." } }, required: ["id", "text"] },
  { app: "notes", name: "notes_replace", action: "notes.replace", description: "Replace the whole text of one Note. Use it to rename or rewrite a Note.",
    props: { id: { type: "string", description: "Note ID from notes_read." }, text: { type: "string", description: "The Note's complete new text." } }, required: ["id", "text"] },
  { app: "notes", name: "notes_edit", action: "notes.edit", description: "Change some words inside one Note without retyping it: every place find appears (whole words) becomes replace. To remove words, include a neighbouring word in both.",
    props: { id: { type: "string", description: "Note ID from notes_search or notes_read." }, find: { type: "string", description: "The exact words in the Note now, e.g. milk." }, replace: { type: "string", description: "What they become, e.g. oat milk." } }, required: ["id", "find", "replace"] },
  { app: "notes", name: "notes_merge", action: "notes.merge", description: "Join several Notes into one, in the order given: the first keeps the joined text, the others are removed. Asks the user first.",
    props: { ids: IDS("Note") }, required: ["ids"] },
  { app: "notes", name: "notes_delete", action: "notes.delete", description: "Delete Notes. Always asks the user with a button press.",
    props: { ids: IDS("Note") }, required: ["ids"] },
  { app: "todo", name: "todo_read", description: "List To-Dos with ID, title, status, due date and project, plus the projects with their IDs. Narrow it with filter and projectId instead of reading everything.",
    props: {
      filter: { type: "string", enum: [...TODO_FILTERS], description: "all (default), open, today, overdue (due before today, not done), upcoming, no-date, or done." },
      projectId: { type: "string", description: "Only this project's To-Dos (a project ID, or \"inbox\")." },
    }, required: [] },
  { app: "todo", name: "todo_create", action: "todo.create", description: "Add new To-Dos. Pass every To-Do of the request in one call, each with its own due date and project when the user gave one.",
    props: { items: { type: "array", description: "The new To-Dos.", items: { type: "object", properties: { title: { type: "string" }, due: DUE, projectId: PROJECT }, required: ["title"] } } }, required: ["items"] },
  { app: "todo", name: "todo_update", action: "todo.update", description: "Change existing To-Dos: due date, project, or title. Set every field that should change in the same call; fields you leave out stay as they are. A new title applies to one To-Do at a time.",
    props: { ids: IDS("To-Do"), due: DUE, projectId: PROJECT, title: { type: "string", description: "New title, for one To-Do." } }, required: ["ids"] },
  { app: "todo", name: "todo_complete", action: "todo.complete", description: "Mark To-Dos done.", props: { ids: IDS("To-Do") }, required: ["ids"] },
  { app: "todo", name: "todo_reopen", action: "todo.reopen", description: "Mark done To-Dos as not done.", props: { ids: IDS("To-Do") }, required: ["ids"] },
  { app: "todo", name: "todo_project_create", action: "todo.project_create", description: "Make a new To-Do project. Returns its ID: move To-Dos into it with todo_update and that projectId.",
    props: { name: { type: "string", description: "The project's name, e.g. Launch." } }, required: ["name"] },
  { app: "todo", name: "todo_project_rename", action: "todo.project_rename", description: "Rename a To-Do project.",
    props: { projectId: { type: "string", description: "Project ID from todo_read." }, name: { type: "string", description: "The new name." } }, required: ["projectId", "name"] },
  { app: "todo", name: "todo_project_delete", action: "todo.project_delete", description: "Delete a To-Do project. Its To-Dos are kept and move to Inbox. Always asks the user with a button press.",
    props: { projectId: { type: "string", description: "Project ID from todo_read." } }, required: ["projectId"] },
  { app: "todo", name: "todo_delete", action: "todo.delete", description: "Delete To-Dos. Always asks the user with a button press.", props: { ids: IDS("To-Do") }, required: ["ids"] },
];

export const APP_TOOLS: ToolDef[] = [
  ...APP_MANIFEST.map((spec): ToolDef => ({
    name: spec.name,
    description: spec.description,
    props: { ...spec.props, say: SAY },
    required: [...spec.required, "say"],
    purposes: "all",
    run(ctx, input, callId) {
      if (!spec.action) {
        // Reads pass their filters (query, filter, projectId) through to read_app.
        const { say, ...filters } = input;
        return readApp.run(ctx, { ...filters, app: spec.app, say }, callId);
      }
      const { title, ...rest } = input;
      return changeApp.run(ctx, { ...rest, ...(title !== undefined ? { text: title } : {}), action: spec.action }, callId);
    },
  })),
  ...BASE_TOOLS,
];
