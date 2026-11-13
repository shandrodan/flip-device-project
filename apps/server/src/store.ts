// Server state. One JSON file, saved shortly after every change. Small on purpose.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Activity, Agent, ApprovalRequest, Focus, Limits, Note, PermissionMode, Hosting, Project, Task } from "@app/protocol";
import { config } from "./config.js";

export interface MachineConfig {
  name: string;
  url: string;
}

export interface State {
  notes: Note[];
  tasks: Task[];
  projects: Project[];
  agents: Agent[];
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
/** A local calendar day as "YYYY-MM-DD", `offset` days from today. Task due dates use these (ADR 0012). */
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
];

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
      { id: id("t"), title: "Pick a product name (3 options max)", target: "todo", agentId: null, status: "todo", steps: [], createdAt: t, updatedAt: t, due: localDay(-1), projectId: "p_pitch" },
      { id: id("t"), title: "Record backup demo video", target: "todo", agentId: null, status: "todo", steps: [], createdAt: t, updatedAt: t, due: localDay(0), projectId: "p_demo" },
      { id: id("t"), title: "Write the one-line pitch for slide 1", target: "todo", agentId: null, status: "todo", steps: [], createdAt: t, updatedAt: t, due: localDay(0) + "T16:00", projectId: "p_pitch" },
      { id: id("t"), title: "Run the demo flow 20 times", target: "todo", agentId: null, status: "todo", steps: [], createdAt: t, updatedAt: t, due: localDay(1), projectId: "p_demo" },
      { id: id("t"), title: "Buy a USB-C cable for the dock", target: "todo", agentId: null, status: "todo", steps: [], createdAt: t, updatedAt: t, due: null, projectId: null },
    ],
    projects: DEFAULT_PROJECTS.map(p => ({ ...p })),
    agents: BUILTIN_AGENTS.map(a => ({ ...a })),
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
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    const s: State = { ...base, ...saved, focus: { ...base.focus, ...saved.focus }, limits: { ...base.limits, ...saved.limits } };
    // Agent loops don't survive a restart: anything mid-flight is paused, approvals are dropped.
    s.approvals = [];
    s.tasks = (s.tasks || []).map(t =>
      ["running", "awaiting-approval", "held"].includes(t.status)
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
export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFileSync(STATE_FILE + ".tmp", JSON.stringify(state, null, 1));
    fs.renameSync(STATE_FILE + ".tmp", STATE_FILE);
  }, 150);
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
export const taskById = (tid: string) => state.tasks.find(t => t.id === tid);
export const noteById = (nid: string) => state.notes.find(n => n.id === nid);

export function log(agentId: string, text: string) {
  state.activity.unshift({ at: now(), agentId, text });
  state.activity.length = Math.min(state.activity.length, 40);
}

export function patchTask(t: Task, patch: Partial<Task>) {
  Object.assign(t, patch, { updatedAt: now() });
}
