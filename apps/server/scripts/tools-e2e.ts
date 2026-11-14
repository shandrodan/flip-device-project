// The tool layer through the real engine, with no model key and no cost.
// A scripted model (an OpenAI-compatible server, what OpenCode's OpenRouter provider speaks) answers
// each engine request with the next tool call of a scenario. Everything else is real: OpenCode, the
// Flip plugin, the gate, approvals, the server's tools, the Build project and its preview. Each
// scenario checks the end state and what the tools returned to the model.
//   pnpm --filter server test:tools          ONLY=undo,errors-static pnpm --filter server test:tools
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { chromium } from "playwright-core";
import { PROTOCOL_VERSION, isAppCommand, type DeviceMessage, type ServerMessage, type Snapshot } from "@app/protocol";

const PORT = 18897, PC_PORT = 17187;
const ONLY = (process.env.ONLY ?? "").split(",").filter(Boolean);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "flip-tools-"));
const home = path.join(root, "home");
const buildDir = path.join(root, "build");
const toolLog = path.join(root, "tools.log");
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const procs: ChildProcess[] = [];
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/* ------------------------------ Scripted model ----------------------------- */

type Step = { tool: string; args: Record<string, unknown> } | { text: string };
/** What the model will do next, in order. A scenario fills it before it speaks. */
let script: Step[] = [];
/** What came back to the model: the content of each tool result, and whether it carried an image. */
const results: { tool: string; text: string; image: boolean }[] = [];
const requests: any[] = [];
let callCount = 0;

function sse(res: http.ServerResponse, step: Step) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const base = { id: `mock-${callCount}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock" };
  const send = (choice: Record<string, unknown>, extra: Record<string, unknown> = {}) => res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
  if ("tool" in step) {
    send({ delta: { role: "assistant", content: null, tool_calls: [{ index: 0, id: `call_${++callCount}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }, finish_reason: null });
    send({ delta: {}, finish_reason: "tool_calls" }, { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  } else {
    send({ delta: { role: "assistant", content: step.text }, finish_reason: null });
    send({ delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  }
  res.end("data: [DONE]\n\n");
}

const model = http.createServer((req, res) => {
  let body = "";
  req.on("data", chunk => (body += chunk));
  req.on("end", () => {
    if (!req.url?.endsWith("/chat/completions")) { res.writeHead(404).end(); return; }
    const request = JSON.parse(body || "{}");
    // Titles and summaries: requests without tools get a short text.
    if (!Array.isArray(request.tools) || !request.tools.length) { sse(res, { text: "Flip task" }); return; }
    requests.push(request);
    if (process.env.DUMP) console.log("REQ", JSON.stringify(request.messages.slice(-3)).replace(/base64,[A-Za-z0-9+/=]{40,}/g, "base64,…").slice(0, 1500));
    // The newest tool result. An image comes right after it as a user message ("Attached media from tool result").
    const messages: any[] = request.messages ?? [];
    let at = messages.length - 1;
    if (messages[at]?.role === "user" && JSON.stringify(messages[at].content).includes("Attached media")) at--;
    const last = messages[at];
    if (last?.role === "tool") {
      const content = Array.isArray(last.content) ? last.content.map((part: any) => part.text ?? "").join("") : String(last.content ?? "");
      const image = JSON.stringify(messages.slice(at)).includes("data:image/png;base64");
      results.push({ tool: last.name ?? "?", text: content, image });
    }
    const next = script.shift() ?? { text: "Done." };
    if ("tool" in next && !request.tools.some((t: any) => t.function?.name === next.tool)) {
      sse(res, { text: `Script error: the engine did not offer ${next.tool}.` });
      return;
    }
    sse(res, next);
  });
});

/* --------------------------------- Device --------------------------------- */

let snap: Snapshot | null = null;
let ws: WebSocket;
const send = (m: DeviceMessage) => ws.send(JSON.stringify(m));
async function until<T>(fn: () => T | undefined | null | false, ms: number): Promise<T | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(100); }
  return null;
}

/** Speak a request with the model's moves scripted. Presses every approval. */
async function run(target: any, text: string, steps: Step[]) {
  script = [...steps];
  const from = results.length;
  const requestId = `req_${Math.random().toString(36).slice(2)}`;
  send({ type: "voice.message", requestId, target, text });
  const pressed = new Set<string>();
  const task = await until(() => {
    for (const a of snap?.approvals ?? []) {
      if (pressed.has(a.requestId)) continue;
      pressed.add(a.requestId);
      send({ type: "approval.press", requestId: a.requestId, approved: true, via: "push-bar" });
    }
    const t = snap?.tasks.find(item => item.requestMessageId === requestId);
    return t && ["done", "failed", "todo", "paused"].includes(t.status) ? t : null;
  }, 90_000);
  if (process.env.SHOW) for (const x of results.slice(from)) console.log(`  [${x.tool}${x.image ? " +image" : ""}] ${x.text.replace(/\n/g, " ⏎ ").slice(0, 400)}`);
  return { task, results: results.slice(from), left: script.length, presses: pressed.size };
}

const BUILD = { kind: "app", app: "build" };
const MAIN = { kind: "main" };
const SAY = "Working";
const readIndex = () => { try { return fs.readFileSync(path.join(buildDir, "index.html"), "utf8"); } catch { return ""; } };
const preview = (p = "") => fetch(`http://127.0.0.1:${PORT}/preview/${p}`).then(async r => ({ status: r.status, text: await r.text() }), () => ({ status: 0, text: "" }));
const health = () => fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json() as Promise<Record<string, any>>);
const notes = () => snap!.notes.map(n => n.text);
const todos = () => snap!.tasks.filter(t => !isAppCommand(t) && t.target === "todo");
const result = (r: Awaited<ReturnType<typeof run>>, tool: string) => r.results.filter(x => x.tool === tool).map(x => x.text).join("\n---\n");

interface Scenario { name: string; test(): Promise<string | null> }
const scenarios: Scenario[] = [
  {
    name: "engine",
    async test() {
      for (let i = 0; i < 120; i++) { if ((await health()).engine === "opencode") return null; await sleep(500); }
      return `engine ${JSON.stringify(await health())}`;
    },
  },
  {
    name: "screenshot",
    async test() {
      const r = await run(BUILD, "Make a page with a big button", [
        { tool: "write", args: { filePath: path.join(buildDir, "index.html"), content: "<!doctype html><title>Shot</title><h1>Shot test</h1><button style=\"font-size:40px\">Press</button>" } },
        { tool: "build_screenshot", args: { say: "Looking at it" } },
        { text: "Done." },
      ]);
      const text = result(r, "build_screenshot");
      const shot = r.results.find(x => x.tool === "build_screenshot");
      const problems = [
        r.task?.status !== "done" && `task ${r.task?.status}: ${r.task?.detail}`,
        !/568×504/.test(text) && "no size in the result",
        !/button "Press"/.test(text) && "button not in the element list",
        !shot?.image && "no image reached the model",
        !r.task?.steps.some(s => /Screenshot of the preview/.test(s.text)) && "no screenshot step",
      ].filter(Boolean);
      return problems.length ? `${problems.join("; ")}\n${text.slice(0, 300)}` : null;
    },
  },
  {
    name: "undo",
    async test() {
      const before = readIndex();
      const a = await run(BUILD, "Change the heading to Lemon Lab", [
        { tool: "write", args: { filePath: path.join(buildDir, "index.html"), content: before.replace(/<h1>.*<\/h1>/, "<h1>Lemon Lab</h1>") } },
        { text: "Heading changed." },
      ]);
      const changed = readIndex();
      const b = await run(BUILD, "Undo that", [
        { tool: "build_history", args: { say: SAY } },
        { tool: "build_undo", args: { steps: 1, say: SAY } },
        { text: "Undone." },
      ]);
      const log = execFileSync("git", ["log", "--format=%s", "-5"], { cwd: buildDir }).toString().trim().split("\n");
      const problems = [
        a.task?.status !== "done" && `change ${a.task?.status}`,
        !/Lemon Lab/.test(changed) && "the change was not written",
        b.task?.status !== "done" && `undo ${b.task?.status}: ${b.task?.detail}`,
        !/Change the heading to Lemon Lab/.test(result(b, "build_history")) && `history: ${result(b, "build_history").slice(0, 200)}`,
        readIndex() !== before && "index.html is not back to what it was",
        !/^Undo: Change the heading/.test(log[0] ?? "") && `log: ${log.join(" | ")}`,
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    name: "errors-static",
    async test() {
      const bad = "<!doctype html><title>Broken</title><h1>Broken</h1><script>const n = ;</script>";
      const good = "<!doctype html><title>Fixed</title><h1>Fixed</h1><script>const n = 1;</script>";
      const revBefore = snap!.build?.rev ?? 0;
      const r = await run(BUILD, "Break the page on purpose, then fix it", [
        { tool: "write", args: { filePath: path.join(buildDir, "index.html"), content: bad } },
        { tool: "write", args: { filePath: path.join(buildDir, "index.html"), content: good } },
        { text: "Fixed." },
      ]);
      const [first, second] = r.results.filter(x => x.tool === "write").map(x => x.text);
      const problems = [
        r.task?.status !== "done" && `task ${r.task?.status}: ${r.task?.detail}`,
        !/preview shows errors/i.test(first ?? "") && `broken write did not report the error: ${first?.slice(0, 200)}`,
        !/no errors/i.test(second ?? "") && `fixed write did not say clean: ${second?.slice(0, 200)}`,
        (snap!.build?.rev ?? 0) < revBefore + 3 && `preview reloaded ${(snap!.build?.rev ?? 0) - revBefore} times (want each edit and the end)`,
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.7 with a dev server: Vite compiles only what is requested, so the check requests the edited module.
    name: "errors-vite",
    async test() {
      const file = (rel: string) => path.join(buildDir, rel);
      const ok = "document.getElementById('app').textContent = 'Vite ok';\n";
      const r = await run(BUILD, "Make it a Vite app, break main.js on purpose, then fix it", [
        { tool: "write", args: { filePath: file("package.json"), content: JSON.stringify({ name: "lemonade", private: true, type: "module", devDependencies: { vite: "6.3.5" } }, null, 2) } },
        { tool: "write", args: { filePath: file("index.html"), content: "<!doctype html><title>Vite</title><div id=\"app\"></div><script type=\"module\" src=\"/src/main.js\"></script>" } },
        { tool: "write", args: { filePath: file("src/main.js"), content: ok } },
        { tool: "bash", args: { command: "npm install --no-audit --no-fund --loglevel=error", description: "Installing Vite" } },
        { tool: "build_serve", args: { command: "npx vite --host 127.0.0.1 --port 5310 --strictPort --base /preview/", port: 5310, say: SAY } },
        { tool: "write", args: { filePath: file("src/main.js"), content: "document.getElementById('app').textContent = ;\n" } },
        { tool: "write", args: { filePath: file("src/main.js"), content: ok } },
        { tool: "build_stop", args: { say: SAY } },
        { text: "Fixed." },
      ]);
      const writes = r.results.filter(x => x.tool === "write").map(x => x.text);
      const [broken, fixed] = writes.slice(-2);
      const problems = [
        r.task?.status !== "done" && `task ${r.task?.status}: ${r.task?.detail}`,
        !/serve/.test(result(r, "build_serve")) && !/Dev server is up/.test(result(r, "build_serve")) && `build_serve: ${result(r, "build_serve").slice(0, 300)}`,
        !/(dev server reports an error|preview shows errors)/i.test(broken ?? "") && `broken edit did not report the error: ${broken?.slice(0, 300)}`,
        !/no new errors/i.test(fixed ?? "") && `fixed edit did not say clean: ${fixed?.slice(0, 300)}`,
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.6: "start a new React app" reaches a running preview fast, from the warm cache.
    name: "starter",
    async test() {
      const t0 = Date.now();
      const r = await run(BUILD, "Start a new React app called Lemon Stand", [
        { tool: "build_new", args: { template: "vite-react", title: "Lemon Stand", say: SAY } },
        { text: "Lemon Stand is running." },
      ]);
      const rendered = await renderedText("Lemon Stand", 30_000);
      const seconds = (Date.now() - t0) / 1000;
      const pkg = fs.readFileSync(path.join(buildDir, "package.json"), "utf8");
      const log = execFileSync("git", ["log", "--format=%s", "-3"], { cwd: buildDir }).toString();
      const stop = await run(BUILD, "Stop the dev server", [{ tool: "build_stop", args: { say: SAY } }, { text: "Stopped." }]);
      const problems = [
        r.task?.status !== "done" && `task ${r.task?.status}: ${r.task?.detail}`,
        !/"react"/.test(pkg) && "no react in package.json",
        !rendered && "React did not render Lemon Stand in the sandboxed preview",
        seconds > 30 && `took ${seconds.toFixed(1)} s (want under 30 s)`,
        !/New vite-react project: Lemon Stand/.test(log) && `no commit for the new project: ${log}`,
        stop.task?.status !== "done" && "could not stop the dev server",
      ].filter(Boolean);
      console.log(`    request to rendered React: ${seconds.toFixed(1)} s · ${result(r, "build_new").split("\n").pop()}`);
      return problems.length ? `${problems.join("; ")}\n${result(r, "build_new").slice(0, 400)}` : null;
    },
  },
];

/** Wait until the preview, in a frame sandboxed like the Device's, shows `word`. */
async function renderedText(word: string, ms: number): Promise<boolean> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 568, height: 504 } });
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      await page.setContent(`<iframe sandbox="allow-scripts allow-forms" src="http://127.0.0.1:${PORT}/preview/" style="border:0;width:568px;height:504px"></iframe>`);
      const frame = (await (await page.waitForSelector("iframe")).contentFrame())!;
      await frame.waitForLoadState("load").catch(() => undefined);
      await page.waitForTimeout(700);
      const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (text.includes(word)) return true;
    }
    return false;
  } finally { await browser.close(); }
}

/* ---------------------------------- Main ---------------------------------- */

function start(name: string, cwd: string, env: Record<string, string>) {
  const p = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", d => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr!.on("data", d => process.env.VERBOSE && process.stdout.write(`[${name}!] ${d}`));
  procs.push(p);
}
function cleanup() {
  for (const p of procs) p.kill("SIGTERM");
  model.close();
  if (!process.env.KEEP) fs.rmSync(root, { recursive: true, force: true });
}
process.on("exit", cleanup);

async function main() {
  fs.mkdirSync(path.join(home, "Flip"), { recursive: true });
  await new Promise<void>(resolve => model.listen(0, "127.0.0.1", resolve));
  const modelPort = (model.address() as { port: number }).port;
  start("pc", path.join(here, "../pc-agent"), { HOME: home, USERPROFILE: home, PC_AGENT_PORT: String(PC_PORT), PC_AGENT_HOST: "127.0.0.1", PC_AGENT_TOKEN: "tools", PC_AGENT_NAME: "Test laptop", PC_AGENT_ALLOW_OPEN: "0", PC_AGENT_ALLOW_SHELL: "0" });
  start("server", here, {
    HOST: "127.0.0.1", PORT: String(PORT), DATA_DIR: path.join(root, "data"),
    PC_AGENTS: `Test laptop=ws://127.0.0.1:${PC_PORT}`, PC_AGENT_TOKEN: "tools",
    DEVICE_ACCESS_TOKEN: "", DEMO_PLANNER: "", SMTP_URL: "", STT_API_KEY: "", ANTHROPIC_API_KEY: "",
    AGENT_ENGINE: "opencode", OPENROUTER_API_KEY: "scripted", ENGINE_MODEL: "openrouter/scripted-model", ENGINE_VISION: "1",
    ENGINE_CONFIG: JSON.stringify({ provider: { openrouter: { options: { baseURL: `http://127.0.0.1:${modelPort}/v1` } } } }),
    FLIP_TOOL_LOG: toolLog, BUILD_HOST: "server", BUILD_DIR: buildDir, BUILD_NAME: "Lemonade", BUILD_PREVIEW_URL: "", PUBLIC_URL: `http://127.0.0.1:${PORT}`,
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
  send({ type: "hello", deviceId: "tools", mode: "handheld", client: "device", protocol: PROTOCOL_VERSION });
  await until(() => snap?.machines.some(m => m.online), 20_000);
  send({ type: "settings.update", patch: { permissionMode: "auto" } });
  await until(() => snap, 5000);

  let failed = 0;
  for (const scenario of scenarios) {
    if (ONLY.length && !ONLY.includes(scenario.name) && scenario.name !== "engine") continue;
    const t0 = Date.now();
    const problem = await scenario.test().catch(err => `threw: ${(err as Error).stack ?? err}`);
    if (problem) failed++;
    console.log(`${problem ? "✕" : "✓"} ${scenario.name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${problem ? `\n    ${problem.replace(/\n/g, "\n    ")}` : ""}`);
  }
  console.log(failed ? `\n${failed} failed` : "\nAll passed");
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
