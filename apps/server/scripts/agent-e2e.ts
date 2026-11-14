// Multi-step Task agent check on the real engine (ADR 0032), with a real model.
// Spawns a server and a PC agent against a throwaway home folder, speaks requests to Omni and to app
// agents, presses every approval like a user would, and checks the end state, not the agent's words.
//   OPENROUTER_API_KEY=... pnpm test:agents
//   MODEL=openrouter/anthropic/claude-haiku-5.5 ONLY=notes,files pnpm test:agents
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { PROTOCOL_VERSION, isAppCommand, type DeviceMessage, type ServerMessage, type Snapshot, type Task } from "@app/protocol";

const PORT = 18887, PC_PORT = 17177;
const MODEL = process.env.MODEL ?? "";
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const ENGINE = process.env.AGENT_ENGINE ?? "opencode";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "flip-agents-"));
const home = path.join(root, "home");
const procs: ChildProcess[] = [];
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function start(name: string, cwd: string, env: Record<string, string>) {
  const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", d => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr!.on("data", d => process.env.VERBOSE && process.stdout.write(`[${name}!] ${d}`));
  procs.push(p);
  return p;
}
function cleanup() {
  for (const p of procs) p.kill("SIGTERM");
  if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true });
}
process.on("exit", cleanup);

let snap: Snapshot | null = null;
let ws: WebSocket;
const send = (m: DeviceMessage) => ws.send(JSON.stringify(m));
async function until<T>(fn: () => T | undefined | null | false, ms: number): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = fn();
    if (v) return v;
    await sleep(100);
  }
  return null;
}

/** Speak to an agent, press every approval, wait for the Task to end. */
async function ask(target: Extract<DeviceMessage, { type: "voice.message" }>["target"], text: string) {
  const requestId = `req_${Math.random().toString(36).slice(2)}`;
  const t0 = Date.now();
  send({ type: "voice.message", requestId, target, text });
  const pressed = new Set<string>();
  let approvals = 0;
  const task = await until(() => {
    for (const approval of snap?.approvals ?? []) {
      if (pressed.has(approval.requestId)) continue;
      pressed.add(approval.requestId);
      approvals++;
      send({ type: "approval.press", requestId: approval.requestId, approved: true, via: "push-bar" });
    }
    const t = snap?.tasks.find(item => item.requestMessageId === requestId);
    return t && ["done", "failed", "todo", "paused"].includes(t.status) ? t : null;
  }, Number(process.env.ASK_TIMEOUT ?? 300) * 1000);
  const all = snap?.tasks ?? [];
  const tree = (t: Task): Task[] => [t, ...all.filter(c => c.parentTaskId === t.id).flatMap(tree)];
  const steps = task ? tree(task).flatMap(t => t.steps.map(s => `${t.agentId}: ${s.text}`)) : [];
  const reply = task?.result ?? task?.detail ?? "";
  return { task, steps, approvals, reply, seconds: Math.round((Date.now() - t0) / 1000) };
}

const notes = () => snap!.notes.map(n => n.text.trim());
const todos = () => snap!.tasks.filter(t => !isAppCommand(t) && t.target === "todo");
const has = (list: string[], word: string) => list.some(t => new RegExp(`\\b${word}\\b`, "i").test(t));
const flipDir = (...p: string[]) => path.join(home, "Flip", ...p);

interface Scenario { name: string; turns: { target: any; text: string }[]; check(): string | null }
const scenarios: Scenario[] = [
  {
    name: "notes",
    turns: [{ target: { kind: "main" }, text: "Create six notes. Their texts are Note 1, Note 2, Note 3, Note 4, Note 5 and Note 6. Then delete notes 1, 3 and 5." }],
    check() {
      const n = notes().filter(t => /^note \d$/i.test(t));
      const want = ["Note 2", "Note 4", "Note 6"];
      return want.every(w => n.some(t => t.toLowerCase() === w.toLowerCase())) && n.length === 3 ? null : `notes left: ${JSON.stringify(notes())}`;
    },
  },
  {
    name: "memory",
    turns: [{ target: { kind: "main" }, text: "Now change the text of the notes you just kept to Alpha, Beta and Gamma, in number order." }],
    check() {
      const n = notes();
      return ["Alpha", "Beta", "Gamma"].every(w => has(n, w)) && !n.some(t => /^note [246]$/i.test(t)) ? null : `notes: ${JSON.stringify(n)}`;
    },
  },
  {
    name: "todo",
    turns: [{ target: { kind: "app", app: "todo" }, text: "Add five to-dos: buy milk, call Rasa, fix the demo, book the venue, print slides. Put book the venue and print slides in the Pitch deck project, due tomorrow. Then mark buy milk done and delete fix the demo." }],
    check() {
      const t = todos();
      const find = (w: string) => t.find(x => x.title.toLowerCase().includes(w));
      const tomorrow = new Date(Date.now() + 86400_000);
      const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, "0")}-${String(tomorrow.getDate()).padStart(2, "0")}`;
      const problems = [
        find("milk")?.status !== "done" && "buy milk not done",
        !find("rasa") && "call Rasa missing",
        find("fix the demo") && "fix the demo not deleted",
        ...["venue", "slides"].map(w => (find(w)?.projectId !== "p_pitch" || !find(w)?.due?.startsWith(day)) && `${w}: ${JSON.stringify(find(w) && { p: find(w)!.projectId, due: find(w)!.due })}`),
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    name: "chain",
    turns: [{ target: { kind: "main" }, text: "Every to-do that is due tomorrow, push it one more day. Then write a note that lists the titles you moved." }],
    check() {
      const d = new Date(Date.now() + 2 * 86400_000);
      const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const moved = todos().filter(t => /venue|slides/i.test(t.title));
      const note = notes().find(t => /venue/i.test(t) && /slides/i.test(t));
      return moved.length === 2 && moved.every(t => t.due?.startsWith(day)) && note ? null : `due ${JSON.stringify(moved.map(t => t.due))}, note ${JSON.stringify(note ?? null)}`;
    },
  },
  {
    name: "cross-app",
    turns: [{ target: { kind: "main" }, text: "Make a to-do in the Home project for every note I have, with the note's text as the title. Then delete all my notes." }],
    check() {
      const home = todos().filter(t => t.projectId === "p_home").map(t => t.title);
      return notes().length === 0 && ["Alpha", "Beta", "Gamma"].every(w => has(home, w)) ? null : `notes ${JSON.stringify(notes())}, Home to-dos ${JSON.stringify(home)}`;
    },
  },
  {
    name: "files",
    turns: [{ target: { kind: "agent", agentId: "pc" }, text: "In ~/Flip/letters make five text files a.txt, b.txt, c.txt, d.txt and e.txt. Each one contains just its own letter. Then delete b.txt and d.txt, and tell me which files are left." }],
    check() {
      const dir = flipDir("letters");
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
      const ok = JSON.stringify(left) === JSON.stringify(["a.txt", "c.txt", "e.txt"]) && fs.readFileSync(path.join(dir, "c.txt"), "utf8").trim() === "c";
      return ok ? null : `files: ${JSON.stringify(left)}`;
    },
  },
];

async function main() {
  fs.mkdirSync(flipDir(), { recursive: true });
  fs.mkdirSync(path.join(home, "Desktop"), { recursive: true });
  start("pc", path.join(here, "../pc-agent"), { HOME: home, USERPROFILE: home, PC_AGENT_PORT: String(PC_PORT), PC_AGENT_HOST: "127.0.0.1", PC_AGENT_TOKEN: "agents", PC_AGENT_NAME: "Test laptop", PC_AGENT_ALLOW_OPEN: "0", PC_AGENT_ALLOW_SHELL: "0" });
  start("server", here, {
    HOST: "127.0.0.1", PORT: String(PORT), DATA_DIR: path.join(root, "data"),
    PC_AGENTS: `Test laptop=ws://127.0.0.1:${PC_PORT}`, PC_AGENT_TOKEN: "agents",
    DEVICE_ACCESS_TOKEN: "", DEMO_PLANNER: "", SMTP_URL: "", STT_API_KEY: "",
    AGENT_ENGINE: ENGINE, ...(MODEL ? { ENGINE_MODEL: MODEL } : {}),
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "", ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  });
  for (let i = 0; i < 80 && !ws; i++) {
    try {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise((res, rej) => { socket.once("open", res); socket.once("error", rej); });
      ws = socket;
    } catch { await sleep(250); }
  }
  if (!ws) throw new Error("server did not start");
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as ServerMessage;
    if (m.type === "snapshot") snap = m.snapshot;
  });
  send({ type: "hello", deviceId: "agents", mode: "handheld", client: "device", protocol: PROTOCOL_VERSION });
  await until(() => snap?.machines.some(m => m.online), 20_000);
  send({ type: "settings.update", patch: { permissionMode: "auto" } });
  // Start from empty apps so the checks see only what the agents did.
  await until(() => snap, 5000);
  console.log(`Engine: ${ENGINE}${MODEL ? ` · ${MODEL}` : ""}\n`);

  let failed = 0;
  for (const scenario of scenarios) {
    if (ONLY.length && !ONLY.includes(scenario.name)) continue;
    let last: Awaited<ReturnType<typeof ask>> | null = null;
    for (const turn of scenario.turns) last = await ask(turn.target, turn.text);
    const problem = !last?.task ? "timed out" : last.task.status !== "done" ? `Task ${last.task.status}: ${last.task.detail}` : scenario.check();
    if (problem) failed++;
    console.log(`${problem ? "✕" : "✓"} ${scenario.name}  (${last?.seconds}s, ${last?.steps.length} steps, ${last?.approvals} presses)`);
    console.log(`    said: ${(last?.reply ?? "").replace(/\s+/g, " ").slice(0, 200)}`);
    if (problem) console.log(`    problem: ${problem}`);
    if (problem || process.env.STEPS) for (const step of last?.steps ?? []) console.log(`      · ${step}`);
  }
  console.log(failed ? `\n${failed} failed` : "\nAll passed");
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
