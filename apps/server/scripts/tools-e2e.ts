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

/** `wait`: milliseconds before the model answers, like a real model thinking (lets the server poll). */
type Move = ({ tool: string; args: Record<string, unknown> } | { text: string }) & { wait?: number };
/** A move, or a function of the last tool result (to use IDs a tool returned). */
type Step = Move | ((last: string) => Move);
/** What the model will do next, in order. A scenario fills it before it speaks. */
let script: Step[] = [];
/** What came back to the model: the content of each tool result, and whether it carried an image. */
const results: { tool: string; text: string; image: boolean }[] = [];
const requests: any[] = [];
let callCount = 0;

let lastResult = "";
function sse(res: http.ServerResponse, step: Move) {
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
    if (process.env.TOOLSCHEMA) { const t = request.tools.find((x: any) => x.function?.name === process.env.TOOLSCHEMA); if (t) console.log("SCHEMA", JSON.stringify(t.function.parameters)); }
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
      lastResult = content;
    }
    const step = script.shift() ?? { text: "Done." };
    let next: Move;
    try { next = typeof step === "function" ? step(lastResult) : step; } catch (err) { next = { text: `Script error: ${(err as Error).message}` }; }
    if ("tool" in next && !request.tools.some((t: any) => t.function?.name === next.tool)) {
      sse(res, { text: `Script error: the engine did not offer ${next.tool}.` });
      return;
    }
    if (next.wait) setTimeout(() => sse(res, next), next.wait);
    else sse(res, next);
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
  {
    // P1.10: search instead of read-all, with 150 Notes.
    name: "notes-search",
    async test() {
      const topics = ["groceries", "gym plan", "book ideas", "trip packing", "pitch outline"];
      const filler = Array.from({ length: 140 }, (_, n) => `${topics[n % topics.length]} note ${n + 1}`);
      const venue = Array.from({ length: 10 }, (_, n) => `Venue option ${n + 1}: call the hall about the venue deposit`);
      const all = [...filler.slice(0, 70), ...venue, ...filler.slice(70)];
      const seed = await run(MAIN, "Save these notes", [
        { tool: "notes_create", args: { texts: all.slice(0, 100), say: SAY } },
        { tool: "notes_create", args: { texts: all.slice(100), say: SAY } },
        { text: "Saved." },
      ]);
      const ids = (text: string) => (JSON.parse(text).notes as { id: string }[]).map(note => note.id);
      const r = await run(MAIN, "Delete the notes about the venue", [
        { tool: "notes_search", args: { query: "venue", say: SAY } },
        last => ({ tool: "notes_delete", args: { ids: ids(last), say: SAY } }),
        { text: "Deleted the venue notes." },
      ]);
      const search = r.results.find(x => x.tool === "notes_search")?.text ?? "{}";
      const found = JSON.parse(search) as { matches?: number; of?: number };
      const before = found.of ?? 0;
      // The Device snapshot carries the newest 80 Notes only: count on the server.
      const after = await run(MAIN, "How many notes", [{ tool: "notes_read", args: { say: SAY } }, { text: "Counted." }]);
      const left = JSON.parse(after.results.find(x => x.tool === "notes_read")?.text ?? "{}") as { count?: number; notes?: { text: string }[] };
      const problems = [
        seed.task?.status !== "done" && `seed ${seed.task?.status}: ${seed.task?.detail}`,
        before < 150 && `only ${before} notes seeded`,
        r.task?.status !== "done" && `task ${r.task?.status}: ${r.task?.detail}`,
        found.matches !== 10 && `search found ${found.matches} of ${found.of}`,
        search.length > 3000 && `search returned ${search.length} chars`,
        left.notes?.some(note => /venue/i.test(note.text)) && "venue notes left",
        left.count !== before - 10 && `notes ${before} → ${left.count}`,
        (r.task?.steps.length ?? 99) >= 8 && `${r.task?.steps.length} steps`,
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.10: To-Do filters.
    name: "todo-filters",
    async test() {
      const day = (offset: number) => { const d = new Date(Date.now() + offset * 86400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
      await run({ kind: "app", app: "todo" }, "Add some to-dos", [
        { tool: "todo_create", args: { say: SAY, items: [
          { title: "late one", due: day(-2) }, { title: "today one", due: day(0) }, { title: "soon one", due: day(3), projectId: "p_pitch" },
          { title: "someday one" }, { title: "finished one", due: day(-1) },
        ] } },
        last => ({ tool: "todo_complete", args: { ids: [JSON.parse(last.slice(last.indexOf("["))).find((t: any) => t.title === "finished one").id], say: SAY } }),
        { text: "Added." },
      ]);
      const read = async (args: Record<string, unknown>) => {
        const r = await run({ kind: "app", app: "todo" }, "Read", [{ tool: "todo_read", args: { ...args, say: SAY } }, { text: "Read." }]);
        const data = JSON.parse(r.results.find(x => x.tool === "todo_read")?.text ?? "{}") as { tasks?: { title: string }[] };
        return (data.tasks ?? []).map(t => t.title).filter(t => / one$/.test(t)).sort().join(",");
      };
      const want: [Record<string, unknown>, string][] = [
        [{ filter: "overdue" }, "late one"],
        [{ filter: "today" }, "today one"],
        [{ filter: "upcoming" }, "soon one"],
        [{ filter: "no-date" }, "someday one"],
        [{ filter: "done" }, "finished one"],
        [{ filter: "open", projectId: "p_pitch" }, "soon one"],
      ];
      const problems: string[] = [];
      for (const [args, expected] of want) {
        const got = await read(args);
        if (got !== expected) problems.push(`${JSON.stringify(args)} → ${got || "nothing"} (want ${expected})`);
      }
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.11: projects as tools.
    name: "projects",
    async test() {
      const TODO = { kind: "app", app: "todo" };
      const titleId = (last: string, title: string) => (JSON.parse(last.slice(last.indexOf("["))) as { id: string; title: string }[]).find(t => t.title === title)!.id;
      let ids: string[] = [];
      const seed = await run(TODO, "Add pitch tasks", [
        { tool: "todo_create", args: { say: SAY, items: [{ title: "pitch rehearsal" }, { title: "pitch slides polish" }, { title: "scratch idea" }] } },
        last => { ids = ["pitch rehearsal", "pitch slides polish", "scratch idea"].map(t => titleId(last, t)); return { text: "Added." }; },
      ]);
      const projectId = (last: string) => last.match(/ID (p_\w+)/)?.[1] ?? "missing";
      let launch = "";
      const r = await run(TODO, "Make a project Launch and move the two pitch tasks there", [
        { tool: "todo_project_create", args: { name: "Launch", say: SAY } },
        last => { launch = projectId(last); return { tool: "todo_update", args: { ids: ids.slice(0, 2), projectId: launch, say: SAY } }; },
        { text: "Moved." },
      ]);
      const dup = await run(TODO, "Make Launch again", [{ tool: "todo_project_create", args: { name: "launch", say: SAY } }, { text: "Exists." }]);
      const rename = await run(TODO, "Rename Launch to Launch week", [() => ({ tool: "todo_project_rename", args: { projectId: launch, name: "Launch week", say: SAY } }), { text: "Renamed." }]);
      let scratch = "";
      const del = await run(TODO, "Make a Scratch project with the idea, then delete the project", [
        { tool: "todo_project_create", args: { name: "Scratch", say: SAY } },
        last => { scratch = projectId(last); return { tool: "todo_update", args: { ids: [ids[2]], projectId: scratch, say: SAY } }; },
        () => ({ tool: "todo_project_delete", args: { projectId: scratch, say: SAY } }),
        { text: "Deleted." },
      ]);
      const task = (id: string) => todos().find(t => t.id === id);
      const problems = [
        seed.task?.status !== "done" && "seed failed",
        r.task?.status !== "done" && `task ${r.task?.status}: ${r.task?.detail}`,
        !ids.slice(0, 2).every(id => task(id)?.projectId === launch) && `pitch tasks in ${ids.slice(0, 2).map(id => task(id)?.projectId).join(",")} (Launch ${launch})`,
        !/already exists with ID/.test(result(dup, "todo_project_create")) && `duplicate not refused: ${result(dup, "todo_project_create").slice(0, 120)}`,
        snap!.projects.find(p => p.id === launch)?.name !== "Launch week" && `rename: ${JSON.stringify(snap!.projects.find(p => p.id === launch))}`,
        rename.task?.status !== "done" && "rename failed",
        snap!.projects.some(p => p.id === scratch) && "Scratch not deleted",
        task(ids[2])?.projectId && `scratch idea in ${task(ids[2])?.projectId}, not Inbox`,
        del.presses < 1 && "deleting a project did not ask for the push bar",
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P1.12: small edits without retyping, and merging.
    name: "notes-edit",
    async test() {
      const NOTES = { kind: "app", app: "notes" };
      const idOf = (last: string, text: string) => (JSON.parse(last) as { notes: { id: string; text: string }[] }).notes.find(n => n.text.startsWith(text))!.id;
      await run(NOTES, "Save notes", [{ tool: "notes_create", args: { texts: ["Shopping list: milk, eggs, bread, milkshake mix", "Merge part A", "Merge part B"], say: SAY } }, { text: "Saved." }]);
      let shop = "";
      const r = await run(NOTES, "In the shopping note, change milk to oat milk", [
        { tool: "notes_search", args: { query: "shopping", say: SAY } },
        last => { shop = idOf(last, "Shopping"); return { tool: "notes_edit", args: { id: shop, find: "milk", replace: "oat milk", say: SAY } }; },
        () => ({ tool: "notes_edit", args: { id: shop, find: "butter", replace: "ghee", say: SAY } }),
        { text: "Changed." },
      ]);
      let a = "", b = "";
      const m = await run(NOTES, "Merge the two merge notes", [
        { tool: "notes_search", args: { query: "merge part", say: SAY } },
        last => { a = idOf(last, "Merge part A"); b = idOf(last, "Merge part B"); return { tool: "notes_merge", args: { ids: [a, b], say: SAY } }; },
        { text: "Merged." },
      ]);
      const read = await run(NOTES, "Read", [{ tool: "notes_read", args: { say: SAY } }, { text: "Read." }]);
      const all = (JSON.parse(read.results.find(x => x.tool === "notes_read")?.text ?? "{}").notes ?? []) as { id: string; text: string }[];
      const edits = r.results.filter(x => x.tool === "notes_edit").map(x => x.text);
      const problems = [
        all.find(n => n.id === shop)?.text !== "Shopping list: oat milk, eggs, bread, milkshake mix" && `shopping note: ${JSON.stringify(all.find(n => n.id === shop)?.text)}`,
        !/not in that Note\. It says/.test(edits[1] ?? "") && `missing words not explained: ${edits[1]?.slice(0, 120)}`,
        all.find(n => n.id === a)?.text !== "Merge part A\n\nMerge part B" && `merged: ${JSON.stringify(all.find(n => n.id === a)?.text)}`,
        all.some(n => n.id === b) && "the second Note was not removed",
        m.presses < 1 && "merge did not ask",
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P2.13: typed tools for Focus, Agents and Settings; change_app is no longer offered to the model.
    name: "typed-apps",
    async test() {
      const from = requests.length;
      const focus = await run(MAIN, "Give me twelve minutes of focus", [{ tool: "focus_start", args: { minutes: 12, say: SAY } }, { text: "Started." }]);
      const focusOn = snap!.focus.running && snap!.focus.lengthMs === 720_000;
      const stop = await run(MAIN, "Stop focus", [{ tool: "focus_stop", args: { say: SAY } }, { text: "Stopped." }]);
      const agent = await run(MAIN, "Make a Task agent called Scout that researches venues", [{ tool: "agents_create", args: { name: "Scout", role: "Researches event venues and compares prices.", say: SAY } }, { text: "Made Scout." }]);
      const manual = await run(MAIN, "Switch to manual mode", [{ tool: "settings_permission", args: { mode: "manual", say: SAY } }, { text: "Manual." }]);
      const wasManual = snap!.settings.permissionMode;
      await run(MAIN, "Back to auto", [{ tool: "settings_permission", args: { mode: "auto", say: SAY } }, { text: "Auto." }]);
      const offered = new Set(requests.slice(from).flatMap((r: any) => r.tools.map((t: any) => t.function?.name)));
      const problems = [
        focus.task?.status !== "done" && `focus ${focus.task?.status}: ${focus.task?.detail}`,
        !focusOn && `focus ${JSON.stringify(snap!.focus)}`,
        (stop.task?.status !== "done" || snap!.focus.running) && "focus did not stop",
        !snap!.agents.some(a => a.name === "Scout") && `no Scout: ${agent.task?.detail}`,
        agent.presses < 1 && "making an agent did not ask",
        manual.task?.status !== "done" && `settings ${manual.task?.status}: ${manual.task?.detail}`,
        wasManual !== "manual" && `mode was ${wasManual}`,
        offered.has("change_app") && "change_app is still offered to the model",
        !["focus_start", "focus_stop", "agents_create", "settings_permission", "read_app"].every(name => offered.has(name)) && `offered: ${[...offered].filter(n => /focus|agents|settings|app/.test(n)).join(", ")}`,
      ].filter(Boolean);
      return problems.length ? problems.join("; ") : null;
    },
  },
  {
    // P2.14: the agent's plan shows as Task steps, "1/3 …".
    name: "plan",
    async test() {
      const todo = (current: number) => ({ tool: "todowrite", wait: 900, args: { todos: ["Save the three notes", "Delete the second one", "Check what is left"].map((content, n) => ({ content, priority: "high", status: n < current ? "completed" : n === current ? "in_progress" : "pending" })) } });
      const r = await run(MAIN, "Save three notes, delete the second, check", [
        todo(0),
        { tool: "notes_create", wait: 900, args: { texts: ["Plan one", "Plan two", "Plan three"], say: SAY } },
        todo(1),
        { tool: "notes_search", wait: 900, args: { query: "plan two", say: SAY } },
        todo(2),
        { tool: "notes_read", wait: 900, args: { say: SAY } },
        todo(3),
        { text: "Done.", wait: 900 },
      ]);
      const steps = r.task?.steps.map(step => step.text) ?? [];
      const plan = steps.filter(text => /^\d+\/\d+ /.test(text));
      const want = ["1/3 Save the three notes", "2/3 Delete the second one", "3/3 Check what is left"];
      return r.task?.status === "done" && JSON.stringify(plan) === JSON.stringify(want) ? null : `steps: ${JSON.stringify(steps)}`;
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
