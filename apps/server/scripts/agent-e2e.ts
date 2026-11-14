// Multi-step Task agent check on the real engine (ADR 0032), with a real model.
// Spawns a server and a PC agent against a throwaway home folder, speaks requests to Omni and to app
// agents, presses every approval like a user would, and checks the end state, not the agent's words.
//   OPENROUTER_API_KEY=... pnpm test:agents
//   MODEL=openrouter/anthropic/claude-haiku-5.5 ONLY=notes,files pnpm test:agents
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { chromium } from "playwright-core";
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
let serverProc: ChildProcess | null = null;
let serverEnv: Record<string, string> = {};
const stateFile = () => path.join(root, "data", "state.json");
const savedState = () => JSON.parse(fs.readFileSync(stateFile(), "utf8")) as { notes: { id: string; text: string }[] };

/** Stop the server, change its saved state, start it again and reconnect like the Device. */
async function restartWith(mutate: (state: any) => void) {
  const proc = serverProc!;
  const exited = new Promise(resolve => proc.once("exit", resolve));
  proc.kill("SIGTERM");
  await exited;
  const saved = JSON.parse(fs.readFileSync(stateFile(), "utf8"));
  mutate(saved);
  fs.writeFileSync(stateFile(), JSON.stringify(saved));
  ws?.close();
  snap = null;
  serverProc = start("server", here, serverEnv);
  await connect();
}

async function connect() {
  let socket: WebSocket | null = null;
  for (let i = 0; i < 80 && !socket; i++) {
    try {
      const attempt = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise((res, rej) => { attempt.once("open", res); attempt.once("error", rej); });
      socket = attempt;
    } catch { await sleep(250); }
  }
  if (!socket) throw new Error("server did not start");
  ws = socket;
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as ServerMessage;
    if (m.type === "snapshot") snap = m.snapshot;
  });
  send({ type: "hello", deviceId: "agents", mode: "handheld", client: "device", protocol: PROTOCOL_VERSION });
  await until(() => snap?.machines.some(m => m.online), 20_000);
}
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

interface Scenario { name: string; before?(): Promise<void>; turns: { target: any; text: string }[]; check(): string | null | Promise<string | null> }
const health = () => fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json() as Promise<Record<string, any>>).catch(() => ({} as Record<string, any>));
/** Kill every OpenCode process of this test's server (they run in its engine folder). Linux only. */
function killEngine(): number {
  const dir = path.join(root, "data", "engine");
  let killed = 0;
  for (const pid of fs.readdirSync("/proc").filter(name => /^\d+$/.test(name))) {
    try {
      if (fs.readlinkSync(`/proc/${pid}/cwd`) !== dir) continue;
      process.kill(Number(pid), "SIGKILL");
      killed++;
    } catch { /* gone, or not ours */ }
  }
  return killed;
}
const buildDir = path.join(root, "build");
const preview = async (p = "") => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/preview/${p}`);
    return { status: r.status, text: await r.text() };
  } catch (err) { return { status: 0, text: String(err) }; }
};
/** The first button in the preview, measured in a frame sandboxed like the Device's, at its size. */
async function measureButton(): Promise<{ w: number; h: number; cx: number; errors: string[] } | null> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 568, height: 504 } });
    const errors: string[] = [];
    page.on("pageerror", err => errors.push(err.message));
    await page.setContent(`<style>html,body{margin:0}</style><iframe sandbox="allow-scripts allow-forms" src="http://127.0.0.1:${PORT}/preview/" style="border:0;display:block;width:568px;height:504px"></iframe>`);
    const frame = (await (await page.waitForSelector("iframe")).contentFrame())!;
    await frame.waitForLoadState("load");
    await page.waitForTimeout(800);
    const box = await frame.evaluate(() => {
      const b = document.querySelector("button");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { w: r.width, h: r.height, cx: r.left + r.width / 2 };
    });
    return box && { ...box, errors };
  } finally { await browser.close(); }
}
let buttonBefore: Awaited<ReturnType<typeof measureButton>> = null;
let lastSteps: string[] = [];
let lastSeconds = 0;
let htmlBefore = "";
const toolLog = path.join(root, "tools.log");
let toolMark = 0;
/** Tool calls since the scenario started, from the server's FLIP_TOOL_LOG. */
const toolsSince = () => { try { return fs.readFileSync(toolLog, "utf8").slice(toolMark).split("\n").filter(Boolean).map(line => JSON.parse(line) as { tool: string; errors?: boolean }); } catch { return []; } };
const markTools = () => { try { toolMark = fs.statSync(toolLog).size; } catch { toolMark = 0; } };
const readIndex = () => { try { return fs.readFileSync(path.join(buildDir, "index.html"), "utf8"); } catch { return ""; } };
const gitLog = () => { try { return execFileSync("git", ["log", "--format=%s", "-8"], { cwd: buildDir }).toString().trim().split("\n"); } catch { return []; } };

/** Every text file in the Build project, joined, without node_modules. */
function projectText(dir = buildDir): string {
  if (!fs.existsSync(dir)) return "";
  return fs.readdirSync(dir, { withFileTypes: true }).map(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? "" : projectText(full);
    return /\.(html|css|js|jsx|ts|tsx|json)$/.test(entry.name) && fs.statSync(full).size < 200_000 ? fs.readFileSync(full, "utf8") : "";
  }).join("\n");
}
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
    // P1.11: projects as tools.
    name: "projects",
    turns: [{ target: { kind: "app", app: "todo" }, text: "Make a project called Launch and move the two Pitch deck tasks there." }],
    check() {
      const launch = snap!.projects.find(p => /^launch$/i.test(p.name));
      const moved = todos().filter(t => /venue|slides/i.test(t.title));
      return launch && moved.length === 2 && moved.every(t => t.projectId === launch.id) ? null : `Launch ${JSON.stringify(launch ?? null)}, tasks ${JSON.stringify(moved.map(t => t.projectId))}`;
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
  {
    // P0.3: the engine crashes between requests; the next request still succeeds.
    name: "engine-restart",
    async before() {
      if (ENGINE !== "opencode") return;
      for (let i = 0; i < 120 && (await health()).engine !== "opencode"; i++) await sleep(500);
      const killed = killEngine();
      if (!killed) throw new Error("no OpenCode process found to kill");
      await sleep(300);
    },
    turns: [{ target: { kind: "main" }, text: "Write a note that says Engine came back." }],
    async check() {
      const h = await health();
      const note = has(notes(), "came back");
      if (ENGINE !== "opencode") return note ? null : "note missing";
      return note && h.engine === "opencode" && h.engineRestarts >= 1 ? null : `note ${note}, health ${JSON.stringify({ engine: h.engine, restarts: h.engineRestarts, error: h.engineError })}`;
    },
  },
  {
    // P1.12: a small change in a Note without retyping it.
    name: "notes-edit",
    before: async () => markTools(),
    turns: [
      { target: { kind: "app", app: "notes" }, text: "Save a note: Shopping list: milk, eggs, bread, coffee." },
      { target: { kind: "app", app: "notes" }, text: "In the shopping note, change milk to oat milk." },
    ],
    check() {
      const note = notes().find(t => /shopping/i.test(t));
      const used = toolsSince().map(call => call.tool);
      const problems = [
        !note || !/oat milk, eggs, bread, coffee/i.test(note) && `note: ${JSON.stringify(note ?? null)}`,
        !used.includes("notes_edit") && `no notes_edit: ${used.join(", ")}`,
        used.includes("notes_replace") && "the note was retyped with notes_replace",
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    name: "build-static",
    turns: [{ target: { kind: "app", app: "build" }, text: "Make the Build project a one-page site called Flip Lemonade, with a big button that counts how many times it was clicked." }],
    async check() {
      const page = await preview();
      return page.status === 200 && /Flip Lemonade/i.test(page.text) && /button/i.test(projectText()) ? null : `preview ${page.status}: ${page.text.slice(0, 160)}`;
    },
  },
  {
    name: "build-edit",
    turns: [{ target: { kind: "app", app: "build" }, text: "Make the button green, and add a line under the title that says Fresh every day." }],
    async check() {
      const all = projectText();
      return /Fresh every day/i.test(all) && /green|#[0-9a-f]{0,2}(8|9|a|b|c|d)[0-9a-f]{0,2}[0-4][0-9a-f]|rgb\(\s*\d{1,2}\s*,\s*1\d\d/i.test(all) ? null : "line or green button missing";
    },
  },
  {
    // P1.4: the agent checks a screenshot of its own work.
    name: "build-look",
    async before() { buttonBefore = await measureButton(); },
    turns: [{ target: { kind: "app", app: "build" }, text: "Make the button bigger and centred." }],
    async check() {
      const after = await measureButton();
      const shot = lastSteps.some(step => /Screenshot of the preview/.test(step));
      const problems = [
        !after && "no button",
        after && buttonBefore && after.w * after.h < buttonBefore.w * buttonBefore.h * 1.15 && `not bigger: ${Math.round(buttonBefore.w)}×${Math.round(buttonBefore.h)} → ${Math.round(after.w)}×${Math.round(after.h)}`,
        after && Math.abs(after.cx - 284) > 8 && `not centred: centre at x ${Math.round(after.cx)} of 568`,
        after?.errors.length && `page errors: ${after.errors.join("; ")}`,
        !shot && "no screenshot in the Task steps",
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.5: "undo that" puts index.html back exactly as it was.
    name: "build-undo",
    async before() { htmlBefore = readIndex(); },
    turns: [
      { target: { kind: "app", app: "build" }, text: "Change the title to Lemon Lab." },
      { target: { kind: "app", app: "build" }, text: "Undo that." },
    ],
    check() {
      const now = readIndex();
      const log = gitLog();
      if (!htmlBefore) return "no index.html before the change";
      if (now !== htmlBefore) return `index.html differs from before (Lemon Lab ${/Lemon Lab/.test(now)}); history: ${log.slice(0, 4).join(" | ")}`;
      return log.some(line => /^Undo/.test(line)) ? null : `no undo in history: ${log.slice(0, 4).join(" | ")}`;
    },
  },
  {
    name: "build-vite",
    turns: [{ target: { kind: "app", app: "build" }, text: "Turn the Build project into a Vite + React app. Keep the Flip Lemonade title, the tagline and the green counter button. Install it and run its dev server so I see it in the preview." }],
    async check() {
      const page = await preview();
      const pkg = fs.existsSync(path.join(buildDir, "package.json")) ? fs.readFileSync(path.join(buildDir, "package.json"), "utf8") : "";
      const client = await preview("@vite/client");
      const problems = [
        !/"vite"/.test(pkg) && "no vite in package.json",
        !/"react"/.test(pkg) && "no react in package.json",
        page.status !== 200 && `preview ${page.status}`,
        client.status !== 200 && `vite client through /preview/: ${client.status}`,
        !/Flip Lemonade/i.test(projectText()) && "title lost",
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.7: a broken edit reports its error by itself; the agent fixes it without reading logs.
    name: "build-errors",
    before: async () => markTools(),
    turns: [{ target: { kind: "app", app: "build" }, text: "Test the error handling: put a syntax error in the main React component on purpose, then fix it so the app works again." }],
    async check() {
      const calls = toolsSince();
      const app = ["src/App.jsx", "src/App.tsx", "src/App.js"].find(file => fs.existsSync(path.join(buildDir, file)));
      const compiled = app ? (await preview(app)).status : 0;
      const problems = [
        !calls.some(call => call.tool === "after-edit" && call.errors) && "no edit result reported an error",
        calls.some(call => call.tool === "build_logs") && "the agent called build_logs",
        compiled !== 200 && `${app ?? "App component"} does not compile now (HTTP ${compiled})`,
      ].filter(Boolean);
      return problems.length ? `${problems.join("; ")} · tools: ${calls.map(call => call.tool + (call.errors ? "!" : "")).join(", ")}` : null;
    },
  },
  {
    // P1.6: a new React app from a starter, running in the preview within seconds.
    name: "build-starter",
    turns: [{ target: { kind: "app", app: "build" }, text: "Start a new React app called Lemon Stand." }],
    async check() {
      const pkg = fs.existsSync(path.join(buildDir, "package.json")) ? fs.readFileSync(path.join(buildDir, "package.json"), "utf8") : "";
      const client = await preview("@vite/client");
      const problems = [
        !/"react"/.test(pkg) && "no react in package.json",
        client.status !== 200 && `vite client through /preview/: ${client.status}`,
        !/Lemon Stand/.test(projectText()) && "title missing",
        (lastSeconds > 60) && `took ${lastSeconds} s`,
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.10: with 150 Notes the agent searches instead of reading everything. Runs last: it restarts
    // the server with the Notes seeded on disk (the Device snapshot only carries the newest 80).
    name: "notes-search",
    async before() {
      await restartWith(saved => {
        const topics = ["groceries", "gym plan", "book ideas", "trip packing", "pitch outline"];
        const texts = Array.from({ length: 150 }, (_, n) => n % 15 === 7 ? `Venue option ${n}: call the hall about the venue deposit` : `${topics[n % topics.length]} note ${n}`);
        saved.notes = texts.map((text, n) => ({ id: `n_seed${String(n).padStart(3, "0")}`, text, createdAt: new Date(Date.now() - n * 60_000).toISOString(), transcribedBy: "local", editedByUser: true, suggestionState: "none", suggestions: [], taskIds: [] }));
      });
    },
    turns: [{ target: { kind: "main" }, text: "Delete the notes about the venue." }],
    check() {
      const left = savedState().notes;
      const problems = [
        left.some(note => /venue/i.test(note.text)) && `venue notes left: ${left.filter(note => /venue/i.test(note.text)).length}`,
        left.length !== 140 && `${left.length} notes left (want 140)`,
        lastSteps.length >= 8 && `${lastSteps.length} steps (want under 8)`,
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
];

async function main() {
  fs.mkdirSync(flipDir(), { recursive: true });
  fs.mkdirSync(path.join(home, "Desktop"), { recursive: true });
  start("pc", path.join(here, "../pc-agent"), { HOME: home, USERPROFILE: home, PC_AGENT_PORT: String(PC_PORT), PC_AGENT_HOST: "127.0.0.1", PC_AGENT_TOKEN: "agents", PC_AGENT_NAME: "Test laptop", PC_AGENT_ALLOW_OPEN: "0", PC_AGENT_ALLOW_SHELL: "0" });
  serverEnv = {
    HOST: "127.0.0.1", PORT: String(PORT), DATA_DIR: path.join(root, "data"),
    PC_AGENTS: `Test laptop=ws://127.0.0.1:${PC_PORT}`, PC_AGENT_TOKEN: "agents",
    DEVICE_ACCESS_TOKEN: "", DEMO_PLANNER: "", SMTP_URL: "", STT_API_KEY: "",
    AGENT_ENGINE: ENGINE, ...(MODEL ? { ENGINE_MODEL: MODEL } : {}),
    FLIP_TOOL_LOG: toolLog, BUILD_HOST: "server", BUILD_DIR: buildDir, BUILD_NAME: "Lemonade", BUILD_PREVIEW_URL: "", PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ?? "", ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
  };
  serverProc = start("server", here, serverEnv);
  await connect();
  send({ type: "settings.update", patch: { permissionMode: "auto" } });
  // Start from empty apps so the checks see only what the agents did.
  await until(() => snap, 5000);
  console.log(`Engine: ${ENGINE}${MODEL ? ` · ${MODEL}` : ""}\n`);

  let failed = 0;
  for (const scenario of scenarios) {
    if (ONLY.length && !ONLY.includes(scenario.name)) continue;
    let last: Awaited<ReturnType<typeof ask>> | null = null;
    await scenario.before?.();
    for (const turn of scenario.turns) last = await ask(turn.target, turn.text);
    lastSteps = last?.steps ?? [];
    lastSeconds = last?.seconds ?? 0;
    const problem = !last?.task ? "timed out" : last.task.status !== "done" ? `Task ${last.task.status}: ${last.task.detail}` : await scenario.check();
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
