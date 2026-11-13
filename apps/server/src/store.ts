// Server state. One JSON file, saved shortly after every change. Small on purpose.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { APP_IDS, type Activity, type Agent, type AgentMessage, type AppId, type ApprovalRequest, type Focus, type Limits, type Note, type PermissionMode, type Hosting, type Task } from "@app/protocol";
import { config } from "./config.js";

export interface MachineConfig {
  name: string;
  url: string;
}

export interface State {
  notes: Note[];
  tasks: Task[];
  agents: Agent[];
  appAgents: Record<AppId, string[]>;
  messages: AgentMessage[];
  activity: Activity[];
  approvals: ApprovalRequest[];
  focus: Focus;
  limits: Limits;
  permissionMode: PermissionMode;
  hosting: Hosting;
  machines: MachineConfig[];
}

export interface Secrets {
  anthropicKey?: string;
  sttKey?: string;
  sttUrl?: string;
  sttModel?: string;
}

const STATE_FILE = path.join(config.dataDir, "state.json");
const SECRETS_FILE = path.join(config.dataDir, "secrets.json");

export const id = (prefix: string) => prefix + "_" + crypto.randomBytes(5).toString("hex");
export const now = () => new Date().toISOString();

export const BUILTIN_AGENTS: Agent[] = [
  { id: "main", name: "Main agent", purpose: "main", shape: "circle", color: "#f2f2f2", builtin: true, seed: 3, role: "Talks to you, runs your other agents, and makes new ones." },
  { id: "mail", name: "Mail agent", purpose: "mail", shape: "capsule", color: "#4a9dff", builtin: true, seed: 11, role: "Drafts and sends email. Always asks before it sends." },
  { id: "pc", name: "PC agent", purpose: "pc", shape: "squircle", color: "#a78bfa", builtin: true, seed: 29, role: "Works on your machines over Tailscale. Asks before it deletes." },
  { id: "app_notes", name: "Notes agent", purpose: "app", shape: "pebble", color: "#64d2ff", builtin: true, seed: 47, role: "Owns the Notes app." },
  { id: "app_todo", name: "To-Do agent", purpose: "app", shape: "pebble", color: "#ffd60a", builtin: true, seed: 64, role: "Owns the To-Do app." },
  { id: "app_focus", name: "Focus agent", purpose: "app", shape: "pebble", color: "#34d17a", builtin: true, seed: 81, role: "Owns the Focus app." },
  { id: "app_agents", name: "Agents app agent", purpose: "app", shape: "pebble", color: "#ff6eb4", builtin: true, seed: 98, role: "Owns the Agents app." },
  { id: "app_settings", name: "Settings agent", purpose: "app", shape: "pebble", color: "#8e8e93", builtin: true, seed: 115, role: "Owns the Settings app. It cannot read keys or set Full mode." },
];
export const DEFAULT_APP_AGENTS: Record<AppId, string> = {
  notes: "app_notes", todo: "app_todo", focus: "app_focus", agents: "app_agents", settings: "app_settings",
};

export const PURPOSE_ROLES: Record<string, string> = {
  research: "Searches the web and writes you a short summary.",
  writer: "Writes docs and drafts into files on your machine.",
  files: "Keeps your folders tidy. Asks before it deletes.",
  custom: "Does what you tell it. Asks before anything risky.",
};

function parseMachines(): MachineConfig[] {
  return config.pcAgents
    .split(",")
    .map(s => s.trim())
    .filter(Boolean)
    .map(s => {
      const i = s.indexOf("=");
      return i > 0 ? { name: s.slice(0, i).trim(), url: s.slice(i + 1).trim() } : { name: s, url: s };
    });
}

export function defaults(): State {
  const t = now();
  return {
    notes: [],
    tasks: [
      { id: id("t"), title: "Record backup demo video", target: "todo", agentId: null, status: "todo", steps: [], createdAt: t, updatedAt: t },
      { id: id("t"), title: "Run the demo flow 20 times", target: "todo", agentId: null, status: "todo", steps: [], createdAt: t, updatedAt: t },
    ],
    agents: BUILTIN_AGENTS.map(a => ({ ...a })),
    appAgents: Object.fromEntries(APP_IDS.map(app => [app, [DEFAULT_APP_AGENTS[app]]])) as Record<AppId, string[]>,
    messages: [],
    activity: [{ at: t, agentId: "main", text: "Ready when you are" }],
    approvals: [],
    focus: { lengthMs: 25 * 60e3, running: false, endsAt: null, remainingMs: 25 * 60e3, round: 1, kind: "focus" },
    limits: { resetAt: null, back: false, source: "none" },
    permissionMode: "auto",
    hosting: config.hosting,
    machines: parseMachines(),
  };
}

function load(): State {
  const base = defaults();
  try {
    if (!fs.existsSync(STATE_FILE)) return base;
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<State> & { appOwners?: Partial<Record<AppId, string>> };
    const s: State = { ...base, ...saved, focus: { ...base.focus, ...saved.focus }, limits: { ...base.limits, ...saved.limits } };
    for (const builtin of BUILTIN_AGENTS.filter(agent => ["main", "mail", "pc"].includes(agent.id)))
      if (!s.agents.some(agent => agent.id === builtin.id)) s.agents.push({ ...builtin });
    const assignments = saved.appAgents ?? Object.fromEntries(APP_IDS.map(app => [app, [saved.appOwners?.[app] ?? DEFAULT_APP_AGENTS[app]]]));
    const used = new Set<string>();
    s.appAgents = { ...base.appAgents };
    for (const app of APP_IDS) {
      const raw = assignments[app];
      const members: string[] = [];
      for (const candidate of Array.isArray(raw) ? raw : []) {
        if (typeof candidate !== "string" || candidate === "main" || used.has(candidate)) continue;
        const builtin = BUILTIN_AGENTS.find(agent => agent.id === candidate);
        if (builtin && !s.agents.some(agent => agent.id === candidate)) s.agents.push({ ...builtin });
        if (!s.agents.some(agent => agent.id === candidate)) continue;
        members.push(candidate);
        used.add(candidate);
      }
      if (!members.length) {
        const fallback = Object.values(DEFAULT_APP_AGENTS).find(agentId => !used.has(agentId))!;
        const builtin = BUILTIN_AGENTS.find(agent => agent.id === fallback)!;
        if (!s.agents.some(agent => agent.id === fallback)) s.agents.push({ ...builtin });
        members.push(fallback);
        used.add(fallback);
      }
      s.appAgents[app] = members;
    }
    delete (s as State & { appOwners?: unknown }).appOwners;
    // Agent loops don't survive a restart: anything mid-flight is paused, approvals are dropped.
    s.approvals = [];
    s.messages ||= [];
    s.tasks = (s.tasks || []).map(t =>
      ["running", "waiting", "awaiting-approval", "held"].includes(t.status)
        ? { ...t, status: "paused", detail: "The server restarted. Try again to pick it up." }
        : t,
    );
    s.notes = (s.notes || []).map(n => (n.suggestionState === "pending" ? { ...n, suggestionState: "none" } : n));
    if (process.env.PC_AGENTS) s.machines = parseMachines(); // env wins over the saved list
    return s;
  } catch (err) {
    console.error("Couldn't read state, starting fresh:", (err as Error).message);
    return base;
  }
}

export const state: State = load();

let saveTimer: NodeJS.Timeout | null = null;
function writeState() {
  fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state, null, 1));
  fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
}
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeState();
  }, 150);
}

/** Commit a message or task transition before its recipient can act on it. */
export function saveNow() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeState();
}

export function resetState() {
  Object.assign(state, defaults());
  save();
}

/* ------------------------------ Secrets (BYOK) ------------------------------ */

export const secrets: Secrets = (() => {
  try {
    return fs.existsSync(SECRETS_FILE) ? JSON.parse(fs.readFileSync(SECRETS_FILE, "utf8")) : {};
  } catch {
    return {};
  }
})();

export function saveSecrets(patch: Secrets) {
  Object.assign(secrets, patch);
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(secrets, null, 1), { mode: 0o600 });
}

/* ------------------------------ Helpers ------------------------------ */

export const agentById = (aid: string | null | undefined) => state.agents.find(a => a.id === aid);
export const appOfAgent = (agentId: string) => APP_IDS.find(app => state.appAgents[app].includes(agentId));
export function pickAppAgent(app: AppId): Agent {
  const members = state.appAgents[app].map(agentById).filter((agent): agent is Agent => !!agent);
  if (!members.length) throw new Error(`The ${app} app has no available Task agent.`);
  const active = (agentId: string) => state.tasks.filter(task => task.agentId === agentId && ["running", "waiting", "queued", "awaiting-approval", "held"].includes(task.status)).length;
  return members.reduce((best, agent) => active(agent.id) < active(best.id) ? agent : best);
}
export const taskById = (tid: string) => state.tasks.find(t => t.id === tid);
export const noteById = (nid: string) => state.notes.find(n => n.id === nid);

export function log(agentId: string, text: string) {
  state.activity.unshift({ at: now(), agentId, text });
  state.activity.length = Math.min(state.activity.length, 40);
}

export function patchTask(t: Task, patch: Partial<Task>) {
  Object.assign(t, patch, { updatedAt: now() });
}
