// Server state. One JSON file, saved shortly after every change. Small on purpose.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { APP_IDS, minAppAgents, type Activity, type Agent, type AgentMessage, type AppId, type ApprovalRequest, type Focus, type Limits, type Note, type PermissionMode, type Hosting, type Project, type Task } from "@app/protocol";
import { config } from "./config.js";
import type { BuildState } from "@app/protocol";

export interface MachineConfig {
  name: string;
  url: string;
}

export interface State {
  notes: Note[];
  tasks: Task[];
  projects: Project[];
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
  build: BuildState;
}

export interface Secrets {
  openRouterKey?: string;
  anthropicKey?: string;
  sttKey?: string;
  sttUrl?: string;
  sttModel?: string;
}

const STATE_FILE = path.join(config.dataDir, "state.json");
const SECRETS_FILE = path.join(config.dataDir, "secrets.json");

export const id = (prefix: string) => prefix + "_" + crypto.randomBytes(5).toString("hex");
export const now = () => new Date().toISOString();
/** A local calendar day as "YYYY-MM-DD", `offset` days from today. Task due dates use these (ADR 0016). */
export function localDay(offset = 0, from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const DEFAULT_PROJECTS: Project[] = [
  { id: "p_demo", name: "Unfair Weekend demo", color: "#e5484d" },
  { id: "p_pitch", name: "Pitch deck", color: "#8e4ec6" },
  { id: "p_home", name: "Home", color: "#e5780b" },
];

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
/** Build has no default agent: the main agent does its work until you assign one (ADR 0021). */
export const DEFAULT_APP_AGENTS: Record<AppId, string | null> = {
  notes: "app_notes", todo: "app_todo", focus: "app_focus", agents: "app_agents", settings: "app_settings", build: null,
};
const defaultMembers = (app: AppId) => (DEFAULT_APP_AGENTS[app] ? [DEFAULT_APP_AGENTS[app]!] : []);

export function defaultBuild(): BuildState {
  const dir = config.buildDir.replace(/\/+$/, "") || "~/Flip/build";
  return {
    dir,
    name: config.buildName || dir.split("/").pop() || "Project",
    previewMode: config.buildPreviewUrl ? "custom" : "proxy",
    previewUrl: config.buildPreviewUrl || null,
    rev: 0,
  };
}

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
    tasks: [],
    projects: DEFAULT_PROJECTS.map(p => ({ ...p })),
    agents: BUILTIN_AGENTS.map(a => ({ ...a })),
    appAgents: Object.fromEntries(APP_IDS.map(app => [app, defaultMembers(app)])) as Record<AppId, string[]>,
    messages: [],
    activity: [{ at: t, agentId: "main", text: "Ready when you are" }],
    approvals: [],
    focus: { lengthMs: 25 * 60e3, running: false, endsAt: null, remainingMs: 25 * 60e3, round: 1, kind: "focus" },
    limits: { resetAt: null, back: false, source: "none" },
    permissionMode: "auto",
    hosting: config.hosting,
    machines: parseMachines(),
    build: defaultBuild(),
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
    const assignments = saved.appAgents ?? Object.fromEntries(APP_IDS.map(app => [app, saved.appOwners?.[app] ? [saved.appOwners[app]] : defaultMembers(app)]));
    const used = new Set<string>();
    s.appAgents = { ...base.appAgents };
    for (const app of APP_IDS) {
      // An app added after this state was saved starts with its defaults.
      const raw = assignments[app] ?? defaultMembers(app);
      const members: string[] = [];
      for (const candidate of Array.isArray(raw) ? raw : []) {
        if (typeof candidate !== "string" || candidate === "main" || used.has(candidate)) continue;
        const builtin = BUILTIN_AGENTS.find(agent => agent.id === candidate);
        if (builtin && !s.agents.some(agent => agent.id === candidate)) s.agents.push({ ...builtin });
        if (!s.agents.some(agent => agent.id === candidate)) continue;
        members.push(candidate);
        used.add(candidate);
      }
      if (members.length < minAppAgents(app)) {
        const fallback = Object.values(DEFAULT_APP_AGENTS).find((agentId): agentId is string => !!agentId && !used.has(agentId))!;
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
    const build = defaultBuild();
    const savedBuild = saved.build as Partial<BuildState> | undefined;
    const previewMode = config.buildPreviewUrl ? "custom" : savedBuild?.previewMode === "custom" ? "custom" : "proxy";
    s.build = {
      ...build,
      previewMode,
      previewUrl: previewMode === "custom" ? config.buildPreviewUrl || savedBuild?.previewUrl || null : null,
      rev: savedBuild?.rev ?? 0,
    };
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
  // Build with no agent of its own: the main agent does the work (ADR 0021).
  if (!members.length && minAppAgents(app) === 0) return agentById("main")!;
  if (!members.length) throw new Error(`The ${app} app has no available Task agent.`);
  const active = (agentId: string) => state.tasks.filter(task => task.agentId === agentId && ["running", "waiting", "queued", "awaiting-approval", "held"].includes(task.status)).length;
  return members.reduce((best, agent) => active(agent.id) < active(best.id) ? agent : best);
}
/** Whether an agent does an app's work: it is assigned, or the app has none and falls back to main (ADR 0021). */
export const ownsApp = (app: AppId, agentId: string) =>
  state.appAgents[app].length ? state.appAgents[app].includes(agentId) : minAppAgents(app) === 0 && agentId === "main";
export const servesBuild = (agentId: string) => ownsApp("build", agentId);
export const taskById = (tid: string) => state.tasks.find(t => t.id === tid);
export const noteById = (nid: string) => state.notes.find(n => n.id === nid);

export function log(agentId: string, text: string) {
  state.activity.unshift({ at: now(), agentId, text });
  state.activity.length = Math.min(state.activity.length, 40);
}

export function patchTask(t: Task, patch: Partial<Task>) {
  Object.assign(t, patch, { updatedAt: now() });
}
