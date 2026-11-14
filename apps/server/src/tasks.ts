// Dumps in the To-Do app (ADR 0016). The words are saved as a note first (CONTEXT: a dump is always a
// note), then the main agent turns them into one task: a title, maybe a day and time, maybe a project,
// and an agent only when you name one ("ask the mail agent to …"). The configured model when a key is set, otherwise
// rules that cover the demo.
import type { Agent, Project, Task } from "@app/protocol";
import { structuredMessage, hasLlm, describeApiError } from "./llm.js";
import { config } from "./config.js";
import { state, localDay } from "./store.js";

export interface TaskRoute {
  title: string;
  /** "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm", local time. */
  due: string | null;
  projectId: string | null;
  agentId: string | null;
  /** Headline for the Device, e.g. "Added to Pitch deck". */
  label: string;
  /** One short line, e.g. "You said tomorrow morning". */
  why: string;
}

/** A change to the selected task (ADR 0025). Only the fields they asked to change are set. */
export interface TaskEdit {
  taskId: string;
  title?: string;
  /** null clears the date. */
  due?: string | null;
  projectId?: string | null;
  agentId?: string;
  complete?: boolean;
  label: string;
  why: string;
}
export type TaskDecision = { kind: "add"; route: TaskRoute } | { kind: "edit"; edit: TaskEdit };

const LISTS = new Set(["today", "inbox", "scheduled", "completed"]);
const projectById = (pid: string | null | undefined) => state.projects.find(p => p.id === pid);

/**
 * A To-Do dump either adds a task or changes the selected one ("move this to Friday", "rename it to …",
 * "it's done", "hand it to the research agent"). With nothing selected it always adds.
 */
export async function decideTask(text: string, listId: string | null, selected?: Task): Promise<TaskDecision> {
  if (selected && hasLlm()) {
    try {
      const d = await decideViaModel(text, listId, selected);
      if (d) return d;
    } catch (err) {
      console.warn("[tasks] Model failed, using rules:", describeApiError(err));
    }
    const edit = editViaRules(text, selected);
    if (edit) return { kind: "edit", edit };
    return { kind: "add", route: viaRules(text, listId) };
  }
  if (selected) {
    const edit = editViaRules(text, selected);
    if (edit) return { kind: "edit", edit };
  }
  return { kind: "add", route: await routeTask(text, listId) };
}

function editLabel(e: Omit<TaskEdit, "label" | "why" | "taskId">) {
  if (e.complete) return "Marked done";
  if (e.agentId) return `Handed to ${state.agents.find(a => a.id === e.agentId)?.name ?? "an agent"}`;
  if (e.due !== undefined) return e.due ? `Moved to ${dayLabel(e.due.slice(0, 10))}` : "Date cleared";
  if (e.projectId !== undefined) return e.projectId ? `Moved to ${projectById(e.projectId)?.name ?? "a project"}` : "Moved to Inbox";
  if (e.title) return "Renamed";
  return "No change";
}

const describeTask = (t: Task) =>
  `"${t.title}"${t.due ? `, due ${t.due}` : ", no date"}${t.projectId ? `, in project ${projectById(t.projectId)?.name ?? t.projectId}` : ", in Inbox"}${t.status === "done" ? ", already done" : ""}`;

const DECIDE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "title", "day", "time", "clearDate", "projectId", "agentId", "complete", "why"],
  properties: {
    action: { type: "string", enum: ["add", "edit"], description: "edit: they talk about the selected task. add: they describe new work." },
    title: { type: "string", description: "add: the new task, imperative, at most 9 words, without date, project or agent words. edit: the new title ONLY if they rename it, else empty." },
    day: { type: "string", description: "YYYY-MM-DD if they gave a day ('tomorrow', 'on Friday'), else empty." },
    time: { type: "string", description: "HH:mm (24h) if they gave a time ('at 3', 'in the morning' = 09:00), else empty." },
    clearDate: { type: "boolean", description: "edit only: true if they want the date removed ('no date', 'someday')." },
    projectId: { type: "string", description: "A project id from the list if they named it (add: or it clearly belongs there), else empty. 'inbox' to take an edited task out of its project." },
    agentId: { type: "string", description: "An agent id only if they explicitly asked an agent to do it / hand it over, else empty." },
    complete: { type: "boolean", description: "edit only: true if they say it is done or finished." },
    why: { type: "string", description: "At most 8 plain words for the screen, e.g. 'You said tomorrow morning'." },
  },
};

async function decideViaModel(text: string, listId: string | null, sel: Task): Promise<TaskDecision | null> {
  const today = new Date();
  const open = listId && !LISTS.has(listId) ? projectById(listId) : undefined;
  const res = await structuredMessage({
    model: config.suggestModel,
    max_tokens: 600,
    output_config: { effort: "low", format: { type: "json_schema", schema: DECIDE_SCHEMA } },
    system:
      `Someone holds the mic in the To-Do app of a small desk device and speaks. Today is ${today.toLocaleDateString("en-GB", { weekday: "long" })} ${localDay(0)}.\n` +
      `The open list is ${open ? `the project "${open.name}" (${open.id})` : `"${listId || "today"}"`}.\n` +
      `The task selected on screen is ${describeTask(sel)}.\n\n` +
      "Decide the action:\n" +
      "- edit: they are talking about the selected task. Signs: 'this', 'it', 'this task', 'that one', or a change with no new work in it: " +
      "'move this task to tomorrow', 'push it to Friday', 'rename it to call the venue', 'put this in Pitch deck', 'it's done', 'hand this to the research agent', 'make it 3pm'. " +
      "Fill only the fields they change; leave the rest empty or false. A time alone keeps the task's day.\n" +
      "- add: they describe new work: 'buy batteries tomorrow', 'remind me to call Rasa'. Use the open list as the project if it is one and they name none.\n" +
      "Never turn an instruction about the selected task into a new task: 'move this task tomorrow' is an edit, never a task called 'Move this task'.\n" +
      "Never invent a date, project or agent they didn't give.\n\n" +
      "Projects:\n" + state.projects.map(p => `- ${p.id}: ${p.name}`).join("\n") +
      "\n\nAgents:\n" + state.agents.filter(a => a.purpose !== "main").map(a => `- ${a.id}: ${a.name}. ${a.role}`).join("\n"),
    messages: [{ role: "user", content: text }],
  });
  if (!res) return null;
  const o = res as Record<string, string | boolean>;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string).trim() : "");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(str("day")) ? str("day") : null;
  const time = /^\d{2}:\d{2}$/.test(str("time")) ? str("time") : null;
  const agent = state.agents.find(a => a.id === str("agentId") && a.purpose !== "main");
  const why = str("why") || "Saved";

  if (o.action === "edit") {
    const e: Omit<TaskEdit, "label" | "why" | "taskId"> = {};
    if (str("title")) e.title = str("title")[0].toUpperCase() + str("title").slice(1);
    if (o.clearDate === true) e.due = null;
    // A new day keeps the task's time; a time alone keeps its day.
    else if (day || time) e.due = (day ?? sel.due?.slice(0, 10) ?? localDay(0)) + (time ? "T" + time : sel.due?.includes("T") ? sel.due.slice(10) : "");
    if (str("projectId") === "inbox") e.projectId = null;
    else if (projectById(str("projectId"))) e.projectId = str("projectId");
    if (agent) e.agentId = agent.id;
    if (o.complete === true) e.complete = true;
    return { kind: "edit", edit: { taskId: sel.id, ...e, label: editLabel(e), why } };
  }

  const title = str("title");
  if (!title) return null;
  let d = day;
  if (!d && (time || listId === "today")) d = localDay(0);
  const project = projectById(str("projectId")) ?? open;
  return { kind: "add", route: finish(title, d ? d + (time ? "T" + time : "") : null, project, agent, why) };
}

/** Without a model: "move this (task) to tomorrow", "rename it to …", "it's done", "hand this to the mail agent". */
const POINTS = /\b(this|it|that)(\s+(task|one|todo))?\b/i;
const CHANGES = /^(?:okay|ok|so|please|can you|could you|just)?[,\s]*(move|push|reschedule|postpone|shift|change|rename|call|mark|set|put|make|hand|give|send|do)\b|\b(it'?s|is) (done|finished|complete)\b|\bmark (it|this)( task)? (as )?(done|complete)\b/i;
export function editViaRules(raw: string, sel: Task): TaskEdit | null {
  const s = raw.trim().replace(/[.!?]+$/, "");
  if (!POINTS.test(s) || !CHANGES.test(s)) return null;
  const e: Omit<TaskEdit, "label" | "why" | "taskId"> = {};
  const rename = s.match(/\b(?:rename|call)\s+(?:it|this|that)(?:\s+(?:task|one))?\s+(?:to\s+|as\s+)?(.+)$/i);
  if (rename) e.title = rename[1][0].toUpperCase() + rename[1].slice(1);
  if (/\b(done|finished|complete)\b/i.test(s) && !rename) e.complete = true;
  if (!rename && !e.complete) {
    const r = viaRules(s, null);
    if (r.agentId) e.agentId = r.agentId;
    if (r.due) e.due = r.due;
    if (r.projectId && r.why.startsWith("You named")) e.projectId = r.projectId;
    if (/\b(no date|someday|unschedule)\b/i.test(s)) e.due = null;
  }
  if (!Object.keys(e).length) return null;
  return { taskId: sel.id, ...e, label: editLabel(e), why: `You said “${s.length > 40 ? s.slice(0, 39) + "…" : s}”` };
}

export async function routeTask(text: string, listId: string | null): Promise<TaskRoute> {
  if (hasLlm()) {
    try {
      const r = await viaModel(text, listId);
      if (r) return r;
    } catch (err) {
      console.warn("[tasks] Model failed, using rules:", describeApiError(err));
    }
  }
  return viaRules(text, listId);
}

/** "Today", "Tomorrow", a weekday this week, or "14 Nov". */
export function dayLabel(day: string) {
  const diff = Math.round((Date.parse(day) - Date.parse(localDay(0))) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  const d = new Date(day + "T12:00");
  if (diff > 1 && diff < 7) return d.toLocaleDateString("en-GB", { weekday: "long" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function finish(title: string, due: string | null, project: Project | undefined, agent: Agent | undefined, why: string): TaskRoute {
  const label = agent ? `Handed to ${agent.name}` : project ? `Added to ${project.name}` : due ? `Added to ${dayLabel(due.slice(0, 10))}` : "Added to Inbox";
  return { title, due, projectId: project?.id ?? null, agentId: agent?.id ?? null, label, why };
}

/* ------------------------------- Model ------------------------------- */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "day", "time", "projectId", "agentId", "why"],
  properties: {
    title: { type: "string", description: "The task, imperative, at most 9 words, without the date, project or agent words. Keep names and details." },
    day: { type: "string", description: "YYYY-MM-DD if they gave a day ('tomorrow', 'on Friday'), else empty." },
    time: { type: "string", description: "HH:mm (24h) if they gave a time ('at 3', 'in the morning' = 09:00), else empty." },
    projectId: { type: "string", description: "A project id from the list if they named it or it clearly belongs there, else empty." },
    agentId: { type: "string", description: "An agent id only if they explicitly asked an agent to do it, else empty." },
    why: { type: "string", description: "At most 8 plain words for the screen, e.g. 'You said tomorrow morning'." },
  },
};

async function viaModel(text: string, listId: string | null): Promise<TaskRoute | null> {
  const today = new Date();
  const open = listId && !LISTS.has(listId) ? projectById(listId) : undefined;
  const res = await structuredMessage({
    model: config.suggestModel,
    max_tokens: 600,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system:
      `Someone holds the mic in the To-Do app of a small desk device and says one task. Today is ${today.toLocaleDateString("en-GB", { weekday: "long" })} ${localDay(0)}.\n` +
      `The open list is ${open ? `the project "${open.name}" (${open.id})` : `"${listId || "today"}"`}. If they don't name a project and the open list is a project, use it.\n` +
      "Never invent a date, project or agent they didn't give.\n\n" +
      "Projects:\n" + state.projects.map(p => `- ${p.id}: ${p.name}`).join("\n") +
      "\n\nAgents:\n" + state.agents.filter(a => a.purpose !== "main").map(a => `- ${a.id}: ${a.name}. ${a.role}`).join("\n"),
    messages: [{ role: "user", content: text }],
  });
  if (!res) return null;
  const o = res as Record<string, string>;
  const title = o.title?.trim();
  if (!title) return null;
  let day = /^\d{4}-\d{2}-\d{2}$/.test(o.day) ? o.day : null;
  const time = /^\d{2}:\d{2}$/.test(o.time) ? o.time : null;
  if (!day && (time || listId === "today")) day = localDay(0);
  const project = projectById(o.projectId) ?? open;
  const agent = state.agents.find(a => a.id === o.agentId && a.purpose !== "main");
  return finish(title, day ? day + (time ? "T" + time : "") : null, project, agent, o.why?.trim() || "Saved as a task");
}

/* ------------------------------- Rules ------------------------------- */

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const STOP = new Set("a an the and or to of for in on at my me i is it this that with be we our you your some about please add put list task project new".split(" "));
const words = (s: string) => (s.toLowerCase().match(/[a-z']+/g) || []).filter(w => w.length > 2 && !STOP.has(w));
const LEAD = /^(okay|ok|so|um|uh|oh|and|also|please|remind me to|i (?:need|have|want|should) to|need to|don'?t forget to|add|put|todo|to do)[,:\s]+/i;

function cut(s: string, re: RegExp) {
  const m = s.match(re);
  return m ? { m, rest: (s.slice(0, m.index) + " " + s.slice(m.index! + m[0].length)).replace(/\s+/g, " ").trim() } : null;
}

export function viaRules(raw: string, listId: string | null): TaskRoute {
  let s = raw.trim().replace(/[.!?]+$/, "");
  let offset: number | null = null, time: string | null = null;
  const said: string[] = [];

  // Agent: only when asked by name ("ask the mail agent to …", "research agent, …").
  let agent: Agent | undefined;
  const ag = cut(s, /\b(?:ask|get|have|tell|let)\s+(?:the\s+|my\s+)?(\w+)\s+agent\s+(?:to\s+)?|^(\w+)\s+agent[,:]?\s+/i);
  if (ag) {
    const w = (ag.m[1] || ag.m[2]).toLowerCase();
    agent = state.agents.find(a => a.purpose !== "main" && (a.purpose === w || a.name.toLowerCase().split(/\s+/).includes(w)));
    if (agent) s = ag.rest;
  }

  // When.
  let c;
  if ((c = cut(s, /\b(?:the\s+)?day after tomorrow\b/i))) { offset = 2; s = c.rest; said.push("the day after tomorrow"); }
  else if ((c = cut(s, /\btomorrow\b/i))) { offset = 1; s = c.rest; said.push("tomorrow"); }
  else if ((c = cut(s, /\b(today|tonight|this evening)\b/i))) { offset = 0; s = c.rest; said.push(c.m[1].toLowerCase()); if (!/today/i.test(c.m[1])) time = "19:00"; }
  else if ((c = cut(s, /\bnext week\b/i))) { offset = 7; s = c.rest; said.push("next week"); }
  else if ((c = cut(s, new RegExp(`\\b(?:on\\s+|this\\s+|next\\s+)?(${WEEKDAYS.join("|")})\\b`, "i")))) {
    const want = WEEKDAYS.indexOf(c.m[1].toLowerCase()), d = new Date().getDay();
    offset = ((want - d + 7) % 7) || 7;
    s = c.rest; said.push(c.m[1][0].toUpperCase() + c.m[1].slice(1).toLowerCase());
  }
  if ((c = cut(s, /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\bat\s+(\d{1,2})(?::(\d{2}))?\b/i))) {
    let h = Number(c.m[1] ?? c.m[4]); const min = c.m[2] ?? c.m[5] ?? "00", ap = c.m[3]?.toLowerCase();
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (!ap && h < 8) h += 12; // "at 3" means the afternoon
    if (h < 24) { time = `${String(h).padStart(2, "0")}:${min}`; s = c.rest; said.push(`at ${time}`); }
  } else if ((c = cut(s, /\b(?:in the\s+|this\s+)?(morning|afternoon|evening|noon)\b/i))) {
    time = { morning: "09:00", afternoon: "14:00", evening: "19:00", noon: "12:00" }[c.m[1].toLowerCase()]!;
    s = c.rest; said.push(c.m[1].toLowerCase());
  }

  // Project: named ("… to the pitch deck list") or sharing a word with one ("print the pitch deck").
  let project: Project | undefined, named = false;
  const pr = cut(s, /\s+(?:to|in|into|on|for)\s+(?:the\s+|my\s+)?([\w' ]+?)\s+(?:project|list)\b/i);
  if (pr) {
    const want = words(pr.m[1]);
    project = state.projects.find(p => words(p.name).some(w => want.includes(w)));
    if (project) { s = pr.rest; named = true; }
  }
  if (!project) {
    const have = words(s);
    project = state.projects.map(p => [p, words(p.name).filter(w => have.includes(w)).length] as const).sort((a, b) => b[1] - a[1]).find(x => x[1] > 0)?.[0];
  }
  const fromList = !project && listId && !LISTS.has(listId) ? projectById(listId) : undefined;
  if (fromList) project = fromList;

  for (let i = 0; i < 4; i++) s = s.replace(LEAD, "");
  s = s.replace(/^[,:\s]+|[,:\s]+$/g, "").replace(/\s+/g, " ");
  const title = s ? s[0].toUpperCase() + s.slice(1) : raw.trim();

  if (offset === null && (time || listId === "today")) offset = 0;
  const due = offset === null ? null : localDay(offset) + (time ? "T" + time : "");

  const why = agent ? `You asked the ${agent.name}`
    : said.length ? `You said ${said.join(" ")}`
    : named ? `You named ${project!.name}`
    : project && !fromList ? `Sounds like ${project.name}`
    : fromList ? `You’re in ${fromList.name}`
    : listId === "today" ? "You’re in Today"
    : "No day or project, so it waits in Inbox";
  return finish(title, due, project, agent, why);
}
