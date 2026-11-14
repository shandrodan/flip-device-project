// Task agents on OpenCode (ADR 0032).
// OpenCode runs the agent loop on the server machine: planning, retries, compaction, and one
// session per agent and app, so an agent remembers what it did. The Flip tools stay here. The
// plugin in `engine-plugin/flip.ts` forwards each tool call back with its OpenCode session ID,
// and this file runs it with that Task's context, gate and approval press.
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { config, SERVER_ROOT } from "../config.js";
import { anthropicKey, openRouterKey } from "../llm.js";
import { Cancelled } from "../approvals.js";
import { MachineOffline } from "../machines.js";
import { save, state } from "../store.js";
import { devLogMark } from "../build-host.js";
import { checkAfterEdit } from "../build-check.js";
import { NATIVE_TOOLS } from "./native-tools.js";
import { TOOLS, ToolError, type Ctx, type ToolDef } from "./tools.js";

export interface EngineModel { providerID: string; modelID: string }

/** OpenCode's own tools act on the server machine, not the user's. Flip tools replace them. */
const OPENCODE_TOOLS_OFF = ["task", "websearch", "skill", "apply_patch", "question", "worktree_create", "worktree_delete"];

const AGENT_PROMPT = [
  "You are an agent behind Flip, a small voice-first desk device. The user speaks a request; you do the work with tools on their Device apps and their own machines. Act like an agent, not a chat.",
  "",
  "How you work:",
  "- Keep going until the request is fully done. Do not stop after one step to ask whether to continue.",
  "- When a request has more than two steps, first write a short plan with todowrite, then work through it and keep it updated.",
  "- Read the current state before you change it. Use the IDs tools return. Never invent an ID.",
  "- When a tool accepts several IDs, change many items in one call instead of one call per item.",
  "- After changes, read again and check the result matches the request. Fix it if it does not.",
  "- When a tool fails, read the error, change your approach and try again. Give up only after a real attempt, and say what is left.",
  "- Some tools wait for the user's button press. That is normal. Never work around an approval.",
  "- Ask a question only when a wrong guess would be costly. Otherwise make the reasonable choice and say what you chose.",
  "- Your final reply is shown on a tiny screen. Keep it short and concrete: what changed, where.",
].join("\n");

export class EngineUnavailable extends Error {}
/** The engine's port stopped answering: it crashed or is restarting. */
class EngineDown extends EngineUnavailable {}

/** Which model the engine runs. ENGINE_MODEL ("provider/model") wins, then the saved keys. */
export function engineModel(): EngineModel | null {
  if (config.engineModel) {
    const slash = config.engineModel.indexOf("/");
    if (slash > 0) return { providerID: config.engineModel.slice(0, slash), modelID: config.engineModel.slice(slash + 1) };
  }
  if (openRouterKey()) return { providerID: "openrouter", modelID: config.openRouterModel };
  if (anthropicKey()) return { providerID: "anthropic", modelID: config.agentModel };
  return null;
}

/** The OpenCode binary itself. The `.bin` shim is a shell script that would leave the engine running when killed. */
/** Whether the engine's model takes images, from ENGINE_VISION or OpenRouter's model list. */
let vision: { ref: string; ok: boolean } | null = null;
export function engineSeesImages() { return !!vision?.ok; }
async function checkVision(model: EngineModel): Promise<boolean> {
  const ref = `${model.providerID}/${model.modelID}`;
  if (vision?.ref === ref) return vision.ok;
  let ok = false;
  if (process.env.ENGINE_VISION) ok = process.env.ENGINE_VISION !== "0";
  else if (model.providerID === "anthropic") ok = true;
  else if (model.providerID === "openrouter") {
    try {
      const list = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(8_000) }).then(r => r.json()) as { data?: { id: string; architecture?: { input_modalities?: string[] } }[] };
      ok = !!list.data?.find(m => m.id === model.modelID)?.architecture?.input_modalities?.includes("image");
    } catch { ok = false; }
  }
  vision = { ref, ok };
  return ok;
}

function binary() {
  const direct = path.join(SERVER_ROOT, "node_modules", "opencode-ai", "bin", "opencode.exe");
  if (process.platform !== "win32" && fs.existsSync(direct)) return direct;
  return path.join(SERVER_ROOT, "node_modules", ".bin", process.platform === "win32" ? "opencode.cmd" : "opencode");
}

/** The engine runs when it is chosen and installed. Otherwise Task agents use the built-in loop. */
export function engineEnabled() {
  return config.agentEngine === "opencode" && fs.existsSync(binary());
}

function merge(base: Record<string, any>, extra: Record<string, any>): Record<string, any> {
  const out = { ...base };
  for (const [key, value] of Object.entries(extra))
    out[key] = value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" ? merge(out[key], value) : value;
  return out;
}

function engineConfig(model: EngineModel, sees = false) {
  const key = model.providerID === "openrouter" ? openRouterKey() : model.providerID === "anthropic" ? anthropicKey() : "";
  const ref = `${model.providerID}/${model.modelID}`;
  const base = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    model: ref,
    small_model: ref,
    // A model missing from OpenCode's catalog still runs: it is declared here.
    provider: { [model.providerID]: { ...(key ? { options: { apiKey: key } } : {}), models: { [model.modelID]: { name: model.modelID, ...(sees ? { attachment: true, modalities: { input: ["text", "image"], output: ["text"] } } : {}) } } } },
    // Flip's gate decides (the plugin's tool.execute.before hook). OpenCode never waits on its own prompt.
    permission: { edit: "allow", bash: "allow", webfetch: "allow", doom_loop: "allow", external_directory: "deny" },
    agent: {
      flip: { mode: "primary", description: "Flip Task agent", prompt: AGENT_PROMPT, steps: config.engineSteps },
    },
  };
  let extra: Record<string, any> = {};
  if (config.engineConfig) {
    try { extra = JSON.parse(config.engineConfig); } catch { console.warn("[engine] ENGINE_CONFIG is not valid JSON, ignored."); }
  }
  return merge(base, extra);
}

/* --------------------------------- Process -------------------------------- */

export const engineToken = crypto.randomBytes(24).toString("hex");
const DIR = path.join(config.dataDir, "engine");
let proc: ChildProcess | null = null;
let baseUrl: string | null = null;
let runningKey = "";
let starting: { key: string; promise: Promise<string> } | null = null;
/** The last start failed, or the engine kept exiting. Cleared by the next start that works. */
let failure: string | null = null;
/** Times the engine exited on its own and was started again (P0.3). */
let restarts = 0;
let lastRestart = 0;
/** One automatic restart per window. A second exit inside it leaves the engine "failed" until the next request. */
const RESTART_WINDOW = 5 * 60_000;

export type EngineStatus = "opencode" | "builtin" | "starting" | "failed";

/** What /health reports about the agent engine. */
export function engineHealth(): { engine: EngineStatus; engineRestarts: number; engineError?: string } {
  const engine: EngineStatus = !engineEnabled() ? "builtin" : proc && baseUrl ? "opencode" : starting ? "starting" : failure ? "failed" : engineModel() ? "starting" : "failed";
  return { engine, engineRestarts: restarts, ...(engine === "failed" ? { engineError: failure ?? "No model key yet." } : {}) };
}

async function ensureEngine(model: EngineModel): Promise<string> {
  const cfg = engineConfig(model, await checkVision(model));
  const key = crypto.createHash("sha256").update(JSON.stringify(cfg)).digest("hex");
  if (proc && baseUrl && runningKey === key) return baseUrl;
  if (starting?.key === key) return starting.promise;
  // A new key or model restarts the engine. Its sessions are on disk and carry on.
  stopEngine();
  const promise = boot(cfg).then(url => {
    baseUrl = url;
    runningKey = key;
    failure = null;
    return url;
  }, err => {
    failure = (err as Error).message.slice(0, 300);
    throw err;
  }).finally(() => { if (starting?.promise === promise) starting = null; });
  starting = { key, promise };
  return promise;
}

function boot(cfg: Record<string, unknown>): Promise<string> {
  const home = path.join(DIR, "home");
  // The global plugin folder, so it loads in every folder OpenCode works in (the Build project too).
  const plugins = path.join(home, "config", "opencode", "plugin");
  fs.mkdirSync(plugins, { recursive: true });
  fs.copyFileSync(path.join(SERVER_ROOT, "engine-plugin", "flip.ts"), path.join(plugins, "flip.ts"));
  fs.rmSync(path.join(DIR, ".opencode", "plugin", "flip.ts"), { force: true });
  const child = spawn(binary(), ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: DIR,
    env: {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      FLIP_ENGINE_URL: `http://127.0.0.1:${config.port}`,
      FLIP_ENGINE_TOKEN: engineToken,
      // OpenCode keeps its config, sessions and caches here, apart from any OpenCode the user runs.
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_STATE_HOME: path.join(home, "state"),
      XDG_CACHE_HOME: path.join(home, "cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc = child;
  let ready = false;
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => { child.kill(); reject(new EngineUnavailable("OpenCode did not start in 90 seconds.")); }, 90_000);
    const read = (chunk: Buffer) => {
      out = (out + chunk.toString()).slice(-4000);
      const match = out.match(/listening on (http:\/\/[^\s]+)/);
      if (match && !ready) {
        ready = true;
        clearTimeout(timer);
        console.log(`[engine] OpenCode on ${match[1]} (${String(cfg.model)})`);
        resolve(match[1].replace(/\/$/, ""));
      }
      if (process.env.ENGINE_VERBOSE) process.stdout.write(`[opencode] ${chunk}`);
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("error", err => { clearTimeout(timer); reject(new EngineUnavailable(`OpenCode failed to start: ${err.message}`)); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const unexpected = proc === child;
      if (unexpected) { proc = null; baseUrl = null; runningKey = ""; }
      reject(new EngineUnavailable(`OpenCode exited (${code ?? signal}). ${out.slice(-400)}`));
      // Exited on its own after it was up: start it again once, so the next request does not wait (P0.3).
      if (unexpected && ready) restartAfterExit(`OpenCode exited (${code ?? signal}).`);
    });
  });
}

function restartAfterExit(reason: string) {
  console.warn(`[engine] ${reason}`);
  if (Date.now() - lastRestart < RESTART_WINDOW) {
    failure = `${reason} It exited again within ${RESTART_WINDOW / 60_000} minutes, so it starts again on the next request.`;
    return;
  }
  lastRestart = Date.now();
  restarts++;
  const model = engineModel();
  if (!model) return;
  console.warn("[engine] Starting OpenCode again.");
  ensureEngine(model).catch(err => console.warn(`[engine] Restart failed: ${(err as Error).message}`));
}

export function stopEngine() {
  if (proc) proc.kill();
  proc = null;
  baseUrl = null;
  runningKey = "";
}

/** Start OpenCode at server start so the first request does not wait for it. */
export function warmEngine() {
  const model = engineModel();
  if (!engineEnabled() || !model) return;
  ensureEngine(model).catch(err => console.warn(`[engine] ${(err as Error).message} Task agents use the built-in loop.`));
}

async function api<T>(base: string, method: string, route: string, body?: unknown, directory?: string): Promise<T> {
  const query = directory ? `${route.includes("?") ? "&" : "?"}directory=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`${base}${route}${query}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  }).catch(err => { throw new EngineDown(`OpenCode is not reachable: ${(err as Error).message}`); });
  if (!response.ok) throw new EngineUnavailable(`OpenCode ${method} ${route} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 300)}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/* ------------------------------ Tool calls in ------------------------------ */

interface Live {
  ctx: Ctx;
  allowed: Set<string>;
  queue: Promise<unknown>;
  /** Cancelled or MachineOffline from a tool: the Task ends with it. */
  fatal: Error | null;
  /** The folder OpenCode's own file and shell tools may use (the Build project on this machine), or null. */
  root: string | null;
  /** Failed calls by tool, input and error. Weaker models can repeat one failing call forever. */
  failures: Map<string, number>;
  /** Dev server log position when each edit was approved, by file (P1.7). */
  edits: Map<string, number>;
}

/** For tests: FLIP_TOOL_LOG=file gets one JSON line per tool call. */
function logTool(entry: Record<string, unknown>) {
  if (process.env.FLIP_TOOL_LOG) try { fs.appendFileSync(process.env.FLIP_TOOL_LOG, JSON.stringify({ at: Date.now(), ...entry }) + "\n"); } catch { /* test log only */ }
}

/** A repeated failing call first gets a nudge, then ends the Task. */
const NUDGE_AFTER = 3, STOP_AFTER = 6;
type CallResult = { output: string; attachments?: { type: "file"; mime: string; url: string; filename?: string }[] } | { error: string };
interface PendingCall { id: string; result: CallResult | null; promise: Promise<CallResult> }

const live = new Map<string, Live>();
const calls = new Map<string, PendingCall>();

/** One tool call from OpenCode, run like the built-in loop runs it. Calls of one session run in order. */
function runCall(sessionID: string, callID: string, name: string, args: unknown): Promise<CallResult> {
  const session = live.get(sessionID);
  if (!session) return Promise.resolve({ error: "No Flip Task is running in this session." });
  const run = session.queue.then(async (): Promise<CallResult> => {
    if (session.fatal) return { error: "The Task stopped." };
    const { ctx } = session;
    logTool({ tool: name });
    if (name.startsWith("opencode-after.")) {
      // After OpenCode's edit or write: new errors go into that tool's result (P1.7).
      const input = (args && typeof args === "object" ? args : {}) as Record<string, any>;
      const full = session.root ? path.resolve(session.root, String(input.filePath ?? input.path ?? "")) : "";
      const mark = session.edits.get(full);
      if (!session.root || mark === undefined) return { output: "" };
      session.edits.delete(full);
      const check = await checkAfterEdit(path.relative(session.root, full), mark).catch(() => ({ text: "", errors: false }));
      logTool({ tool: "after-edit", errors: check.errors });
      return { output: check.text };
    }
    if (name.startsWith("opencode.")) {
      try {
        return await nativeGate(session, name.slice("opencode.".length), (args && typeof args === "object" ? args : {}) as Record<string, any>);
      } catch (err) {
        if (err instanceof Cancelled || err instanceof MachineOffline) { session.fatal = err; return { error: "The Task stopped." }; }
        return { error: (err as Error).message };
      }
    }
    const def = TOOLS.find(tool => tool.name === name);
    if (!def || !session.allowed.has(name)) return { error: `${name} is not available to ${ctx.agent.name}.` };
    const input = (args && typeof args === "object" ? args : {}) as Record<string, any>;
    const missing = def.required.filter(key => input[key] === undefined || input[key] === null || input[key] === "");
    if (missing.length) return { error: `Missing ${missing.join(", ")}` };
    try {
      ctx.step(String(input.say || def.name));
      const out = await def.run(ctx, input, callID);
      const output = out.text.slice(0, 15000) || "Done.";
      // An image (a Build screenshot) goes to the model as an attachment when it can see images.
      if (out.image && engineSeesImages()) return { output, attachments: [{ type: "file", mime: out.image.mime, url: `data:${out.image.mime};base64,${out.image.base64}`, filename: `${name}.png` }] };
      return { output };
    } catch (err) {
      if (err instanceof Cancelled || err instanceof MachineOffline) {
        session.fatal = err;
        return { error: "The Task stopped." };
      }
      const message = (err as Error).message || String(err);
      const { say: _say, ...rest } = input;
      const key = `${name}|${JSON.stringify(rest)}|${message}`;
      const count = (session.failures.get(key) ?? 0) + 1;
      session.failures.set(key, count);
      if (count >= STOP_AFTER) {
        session.fatal = new ToolError(`I kept getting the same error and stopped: ${message}`);
        return { error: "The Task stopped after the same call failed again." };
      }
      if (count >= NUDGE_AFTER)
        return { error: `${message}\nThis exact call has now failed ${count} times. Do not repeat it. Read the error, change the input, or use another approach.` };
      return { error: message };
    }
  });
  session.queue = run.catch(() => undefined);
  return run;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 2_000_000) { reject(new Error("Too large")); req.destroy(); }
    });
    req.on("end", () => { try { resolve(body ? JSON.parse(body) : {}); } catch (err) { reject(err); } });
    req.on("error", reject);
  });
}

async function answerCall(res: http.ServerResponse, call: PendingCall) {
  const result = call.result ?? await Promise.race([call.promise, new Promise<null>(resolve => setTimeout(() => resolve(null), 20_000))]);
  if (result) calls.delete(call.id);
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result ? { id: call.id, done: true, ...result } : { id: call.id, done: false }));
}

/** The plugin's routes: the tool manifest and tool calls. Local, with the engine token. */
export async function handleEngineHttp(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/engine/")) return false;
  const remote = req.socket.remoteAddress ?? "";
  const local = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  const auth = Buffer.from(req.headers.authorization ?? "");
  const expected = Buffer.from(`Bearer ${engineToken}`);
  if (!local || auth.length !== expected.length || !crypto.timingSafeEqual(auth, expected)) {
    res.writeHead(403).end();
    return true;
  }
  if (req.method === "GET" && url.pathname === "/engine/tools") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(TOOLS.map(tool => ({
      name: tool.name, description: tool.description, props: tool.props, required: tool.required,
    }))));
  } else if (req.method === "POST" && url.pathname === "/engine/call") {
    const body = await readBody(req).catch(() => null);
    if (!body || typeof body !== "object") {
      res.writeHead(400).end();
      return true;
    }
    const call: PendingCall = { id: crypto.randomUUID(), result: null, promise: null! };
    call.promise = runCall(String(body.sessionID), String(body.callID ?? call.id), String(body.tool), body.args)
      .then(result => (call.result = result));
    calls.set(call.id, call);
    await answerCall(res, call);
  } else if (req.method === "GET" && url.pathname.startsWith("/engine/call/")) {
    const call = calls.get(url.pathname.slice("/engine/call/".length));
    if (!call) res.writeHead(404).end();
    else await answerCall(res, call);
  } else res.writeHead(404).end();
  return true;
}

/* --------------------------------- Running -------------------------------- */

interface EngineMessage {
  info: { id: string; role: string; time: { created: number; completed?: number }; error?: { name: string; data?: { message?: string } }; finish?: string };
  parts: { type: string; text?: string; synthetic?: boolean }[];
}

const busy = new Set<string>();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface EngineRun {
  system: string;
  tools: ToolDef[];
  /** The first message. `withHistory` is true for a new session, which has no earlier turns. */
  firstMessage(withHistory: boolean): string;
  /** Results of Task agents this Task asked, once they all finished; null when there were none. */
  childResults(): Promise<string | null>;
  webAccess: boolean;
  /** Folder for OpenCode's own file and shell tools (the Build project on this machine). */
  directory?: string;
}

/** Run one Task on OpenCode. Throws EngineUnavailable when the engine cannot run it at all. */
export async function runOnEngine(ctx: Ctx, ctl: { cancelled: boolean }, run: EngineRun): Promise<string> {
  const model = engineModel();
  if (!model) throw new ToolError("Add an OpenRouter or Anthropic key in Settings to use Task agents.");
  const dir = run.directory;
  // A crashed engine whose exit was not noticed yet: start it again and retry once (P0.3).
  let base = await ensureEngine(model);
  try {
    await api(base, "GET", "/session/status", undefined, dir);
  } catch (err) {
    if (!(err instanceof EngineDown)) throw err;
    console.warn(`[engine] ${err.message} Starting it again.`);
    stopEngine();
    base = await ensureEngine(model);
  }

  // One session per agent and app keeps the agent's memory. A busy session gets a sibling.
  const key = `${ctx.agent.id}:${ctx.task.app ?? "-"}${dir ? ":build" : ""}`;
  const saved = state.engineSessions[key];
  let sessionID = saved && !busy.has(saved) ? await api<{ id: string }>(base, "GET", `/session/${saved}`, undefined, dir).then(s => s.id, () => null) : null;
  const fresh = !sessionID;
  if (!sessionID) {
    sessionID = (await api<{ id: string }>(base, "POST", "/session", { title: `${ctx.agent.name}${ctx.task.app ? ` · ${ctx.task.app}` : ""}` }, dir)).id;
    if (!saved || !busy.has(saved)) { state.engineSessions[key] = sessionID; save(); }
  }

  const allowed = new Set(run.tools.map(tool => tool.name));
  const tools: Record<string, boolean> = Object.fromEntries(TOOLS.map(tool => [tool.name, allowed.has(tool.name)]));
  for (const name of [...OPENCODE_TOOLS_OFF, ...NATIVE_TOOLS]) tools[name] = false;
  if (dir) for (const name of NATIVE_TOOLS) tools[name] = true;
  tools.webfetch = run.webAccess;
  tools.todowrite = true;
  const session: Live = { ctx, allowed, queue: Promise.resolve(), fatal: null, failures: new Map(), root: dir ?? null, edits: new Map() };
  busy.add(sessionID);
  live.set(sessionID, session);
  try {
    let text = run.firstMessage(fresh);
    for (let round = 0; round < 6; round++) {
      const answer = await prompt(base, sessionID, model, run.system, tools, text, ctl, session, dir);
      const results = await run.childResults();
      if (results) {
        text = `Your Task agents finished. Use these results in your answer:\n${results}`;
        continue;
      }
      return answer;
    }
    throw new ToolError("Too many rounds with other Task agents. Check the Task steps for work already completed.");
  } catch (err) {
    // Work may be half done, so a crash mid-Task never reruns it on the built-in loop.
    if (err instanceof EngineDown) throw new ToolError("The agent engine stopped in the middle of this Task and is starting again. Check the steps, then say it again.");
    throw err;
  } finally {
    busy.delete(sessionID);
    live.delete(sessionID);
  }
}

async function prompt(base: string, sessionID: string, model: EngineModel, system: string, tools: Record<string, boolean>, text: string, ctl: { cancelled: boolean }, session: Live, dir?: string): Promise<string> {
  const before = (await api<EngineMessage[]>(base, "GET", `/session/${sessionID}/message`, undefined, dir)).length;
  await api(base, "POST", `/session/${sessionID}/prompt_async`, { agent: "flip", model, system, tools, parts: [{ type: "text", text }] }, dir);
  const stop = async (err: Error) => {
    await api(base, "POST", `/session/${sessionID}/abort`, undefined, dir).catch(() => undefined);
    throw err;
  };
  const started = Date.now();
  for (;;) {
    await sleep(400);
    if (session.fatal) return stop(session.fatal);
    if (ctl.cancelled) return stop(new Cancelled());
    if (!proc || baseUrl !== base) throw new ToolError("The agent engine stopped in the middle of this Task and is starting again. Check the steps, then say it again.");
    const status = (await api<Record<string, { type: string }>>(base, "GET", "/session/status", undefined, dir))[sessionID];
    if (status && status.type !== "idle") continue;
    const messages = (await api<EngineMessage[]>(base, "GET", `/session/${sessionID}/message`, undefined, dir)).slice(before);
    const last = [...messages].reverse().find(message => message.info.role === "assistant");
    if (!last?.info.time.completed) {
      if (Date.now() - started > 60_000 && !messages.some(message => message.info.role === "assistant"))
        throw new ToolError("The agent engine did not answer.");
      continue;
    }
    if (session.fatal) throw session.fatal;
    if (last.info.error && last.info.error.name !== "MessageAbortedError")
      throw new ToolError(`The model failed: ${last.info.error.data?.message ?? last.info.error.name}`.slice(0, 400));
    const answer = last.parts.filter(part => part.type === "text" && !part.synthetic).map(part => part.text ?? "").join("").trim();
    if (!answer) throw new ToolError("The model returned no final answer. Check the Task steps for work already completed.");
    return answer;
  }
}

/* ------------------------- OpenCode's own tools in ------------------------ */

/** OpenCode's file and shell tools, allowed only inside the Build project, behind the same gate. */
async function nativeGate(session: Live, tool: string, args: Record<string, any>): Promise<CallResult> {
  const { ctx, root } = session;
  if (!root || !NATIVE_TOOLS.includes(tool)) return { error: `${tool} is not available here. Use the Flip tools.` };
  const target = String(args.filePath ?? args.path ?? args.workdir ?? ".");
  const full = path.resolve(root, target);
  if (full !== root && !full.startsWith(root + path.sep)) return { error: "Stay inside the Build project folder." };
  const rel = path.relative(root, full) || "the project";
  if (tool === "bash") {
    const command = String(args.command ?? "");
    ctx.step(String(args.description || "Running a command").slice(0, 80));
    await ctx.gate({ askFirst: true, title: "Run this command?", body: `Server · ${state.build.dir}`, preview: { command } });
  } else if (tool === "edit" || tool === "write") {
    ctx.step(`${tool === "write" ? "Writing" : "Editing"} ${rel}`);
    await ctx.gate({ title: `Write ${rel}?`, body: `In ${state.build.name}.` });
    session.edits.set(full, devLogMark());
  } else {
    ctx.step(tool === "read" ? `Reading ${rel}` : `Searching ${args.pattern ? String(args.pattern).slice(0, 40) : rel}`);
    await ctx.gate({ title: `Look in ${state.build.name}?` });
  }
  return { output: "ok" };
}
