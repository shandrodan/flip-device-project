// Flip server: the WebSocket hub for the Device and Dock, the task agents, voice, focus and limits.
//   pnpm --filter server dev     ->  ws://localhost:8787/ws, setup page at http://localhost:8787/setup
import http from "node:http";
import os from "node:os";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  APP_IDS,
  minAppAgents,
  AGENT_NAME_MAX,
  AGENT_PERSONALITY_MAX,
  parseDeviceMessage,
  type ClientKind,
  type DeviceMessage,
  type DeviceMode,
  type ServerMessage,
  type Snapshot,
  type Task,
} from "@app/protocol";
import { config } from "./config.js";
import { state, save, saveNow, id, now, agentById, appOfAgent, taskById, noteById, log, patchTask, resetState, PURPOSE_ROLES } from "./store.js";
import { bus } from "./bus.js";
import { machines } from "./machines.js";
import { hasLlm, apiKey, llmMode, agentModel } from "./llm.js";
import { sttMode, transcribe } from "./voice.js";
import { press, requestApproval, resumeHeld } from "./approvals.js";
import { startTask, cancelTask, isRunning, resumePausedForMachines, resumeQueuedTasks } from "./agents/runner.js";
import { voiceStart, voiceChunk, voiceEnd, voiceCancel, voiceScripted, syncOfflineNote, runSuggestions } from "./notes.js";
import { handleSetup } from "./setup.js";
import { acceptVoiceMessage } from "./agents/coordination.js";
import { serveBuildPreview, upgradeBuildPreview } from "./build-preview.js";
import { restoreDev } from "./build-host.js";
import { engineEnabled, engineModel, handleEngineHttp, stopEngine, warmEngine } from "./agents/engine.js";

const SERVER_ID = id("srv");
if (config.deviceToken && !/^[A-Za-z0-9_-]{24,}$/.test(config.deviceToken))
  throw new Error("DEVICE_ACCESS_TOKEN must have at least 24 URL-safe characters (letters, numbers, underscores or hyphens).");

const deviceProtocol = "flip-device";
const deviceCredential = Buffer.from(`auth.${config.deviceToken}`);

/* ------------------------------- Clients ------------------------------- */

interface Client {
  ws: WebSocket;
  kind: ClientKind;
  mode: DeviceMode;
  deviceId: string;
}
const clients = new Set<Client>();

function lanUrl() {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === "IPv4" && !i.internal).map(i => i!.address);
  const ts = ips.find(ip => ip.startsWith("100.")); // prefer the Tailscale address
  return `http://${ts || ips[0] || "localhost"}:${config.port}`;
}

function buildSnapshot() {
  if (state.build.previewMode === "proxy") return { ...state.build, previewUrl: `${lanUrl()}/preview/` };
  return state.build;
}

function snapshot(): Snapshot {
  const devices = [...clients];
  const handheld = devices.filter(c => c.kind === "device");
  return {
    version: PROTOCOL_VERSION,
    serverTime: now(),
    notes: state.notes.slice(0, 80),
    tasks: state.tasks.slice(0, 120),
    projects: state.projects,
    agents: state.agents,
    appAgents: state.appAgents,
    messages: state.messages.slice(-120),
    activity: state.activity.slice(0, 20),
    approvals: state.approvals,
    machines: machines.list(),
    coding: machines.coding(),
    build: buildSnapshot(),
    settings: {
      permissionMode: state.permissionMode,
      hosting: state.hosting,
      serverUrl: lanUrl(),
      provider: llmMode() === "openrouter" ? "openrouter" : "anthropic",
      keySet: hasLlm(),
      keyHint: apiKey() ? apiKey().slice(-4) : undefined,
      model: agentModel(),
      setupUrl: `${lanUrl()}/setup`,
    },
    focus: state.focus,
    limits: state.limits,
    services: { llm: llmMode(), stt: sttMode(), smtp: !!config.smtpUrl },
    devices: { handheld: handheld.length, dock: devices.length - handheld.length, mode: handheld[handheld.length - 1]?.mode ?? "handheld" },
  };
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg: ServerMessage) {
  const raw = JSON.stringify(msg);
  for (const c of clients) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(raw);
}
let snapTimer: NodeJS.Timeout | null = null;
function changed() {
  if (snapTimer) return;
  snapTimer = setTimeout(() => {
    snapTimer = null;
    broadcast({ type: "snapshot", snapshot: snapshot() });
  }, 40);
}
bus.attach(broadcast, changed);

/* ------------------------------- Handlers ------------------------------- */

function newTask(title: string, agentId: string | null, noteId?: string): Task {
  const t = now();
  return { id: id("t"), noteId, title, target: agentId ? "agent" : "todo", agentId, status: "todo", steps: [], createdAt: t, updatedAt: t };
}
const busyTask = (agentId: string) => state.tasks.some(task => task.agentId === agentId && ["running", "waiting", "queued", "awaiting-approval", "held"].includes(task.status));

async function handle(c: Client, m: DeviceMessage) {
  switch (m.type) {
    case "hello":
      c.kind = m.client;
      c.mode = m.mode;
      c.deviceId = m.deviceId;
      send(c.ws, { type: "welcome", serverId: SERVER_ID, protocol: PROTOCOL_VERSION });
      send(c.ws, { type: "snapshot", snapshot: snapshot() });
      return changed();
    case "ping":
      return send(c.ws, { type: "pong", t: m.t });
    case "mode.changed":
      c.mode = m.mode;
      return changed();

    case "voice.start":
      return voiceStart(m.streamId, m.mime, m.target);
    case "voice.chunk":
      return voiceChunk(m.streamId, m.audio);
    case "voice.cancel":
      return voiceCancel(m.streamId);
    case "voice.end":
      return voiceEnd(m.streamId, m.durationMs, m.hint);
    case "voice.scripted":
      return voiceScripted(m.text, m.cloudText, m.durationMs, m.target, m.streamId);
    case "voice.message": {
      if (m.target.kind !== "main" && m.target.kind !== "agent" && m.target.kind !== "app") return;
      try {
        const stored = state.messages.find(message => message.id === m.requestId);
        const previous = stored && state.tasks.find(task => task.id === stored.taskId);
        if (previous) return send(c.ws, { type: "voice.accepted", streamId: m.requestId, taskId: previous.id, agentId: stored.toAgentId });
        const transcript = m.audio ? await transcribe(Buffer.from(m.audio, "base64"), m.mime || "audio/webm") : null;
        const task = acceptVoiceMessage(m.target, transcript?.text || m.text, m.requestId, startTask);
        return send(c.ws, { type: "voice.accepted", streamId: m.requestId, taskId: task.id, agentId: task.agentId! });
      } catch (error) {
        return send(c.ws, { type: "voice.rejected", streamId: m.requestId, reason: (error as Error).message });
      }
    }
    case "note.sync": {
      const fixed = await syncOfflineNote(m.note);
      if (fixed) bus.notice("Back online. Re-checked a note with the cloud", "ok");
      return;
    }

    case "note.suggest": {
      const n = noteById(m.noteId);
      if (n) await runSuggestions(n);
      return;
    }
    case "note.delete": {
      const n = noteById(m.noteId);
      if (!n) return;
      const ok = await requestApproval({ agentId: "main", kind: "risky", risk: "delete", title: "Delete this note?", body: "You can't undo this. Deleting always needs your press." });
      if (ok) {
        state.notes = state.notes.filter(x => x.id !== n.id);
        bus.notice("Note deleted", "info");
      }
      break;
    }
    case "suggestion.accept": {
      const n = noteById(m.noteId);
      if (!n) return;
      const made: Task[] = [];
      for (const s of n.suggestions) {
        if (!m.suggestionIds.includes(s.id)) continue;
        const agentId = m.asTodos ? null : s.agentId && agentById(s.agentId) ? s.agentId : null;
        made.push(newTask(s.title, agentId, n.id));
      }
      state.tasks.unshift(...made);
      n.taskIds.push(...made.map(t => t.id));
      n.suggestionState = "accepted";
      for (const t of made) if (t.agentId) startTask(t);
      log("main", made.length ? `Made ${made.length} task${made.length > 1 ? "s" : ""}` : "Kept the note");
      break;
    }
    case "suggestion.dismiss": {
      const n = noteById(m.noteId);
      if (n) n.suggestionState = "dismissed";
      break;
    }

    case "task.complete": {
      const t = taskById(m.taskId);
      if (!t || isRunning(t.id)) return;
      patchTask(t, { status: "done", completedAt: now() });
      log(t.agentId || "main", `Done: ${t.title}`);
      break;
    }
    case "task.reopen": {
      const t = taskById(m.taskId);
      if (t && t.status === "done") patchTask(t, { status: "todo", target: "todo", agentId: null, completedAt: undefined });
      break;
    }
    case "task.assign": {
      const t = taskById(m.taskId), a = agentById(m.agentId);
      if (!t || !a || isRunning(t.id)) return;
      patchTask(t, { agentId: a.id, target: "agent" });
      startTask(t);
      break;
    }
    case "task.resume": {
      const t = taskById(m.taskId);
      if (!t) return;
      if (t.status === "held" && resumeHeld(t.id)) return;
      if (["paused", "failed"].includes(t.status) && t.agentId) startTask(t);
      break;
    }
    case "task.reschedule": {
      const t = taskById(m.taskId);
      if (t && (m.due === null || /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(m.due))) patchTask(t, { due: m.due });
      break;
    }
    case "task.cancel": {
      const t = taskById(m.taskId);
      if (t) cancelTask(t.id);
      break;
    }
    case "approval.press":
      press(m.requestId, m.approved);
      return;

    case "focus.start": {
      const ms = Math.max(1, Math.min(180, m.minutes)) * 60e3;
      state.focus = { ...state.focus, kind: m.kind, lengthMs: ms, remainingMs: ms, running: true, endsAt: new Date(Date.now() + ms).toISOString() };
      log("main", m.kind === "break" ? "Break started" : `Focus started, ${m.minutes} min`);
      break;
    }
    case "focus.stop": {
      const f = state.focus;
      state.focus = { ...f, running: false, endsAt: null, remainingMs: f.lengthMs };
      log("main", "Focus ended early");
      break;
    }

    case "limits.ack":
      state.limits = { ...state.limits, back: false, resetAt: null, source: "none" };
      break;
    case "limits.start-window":
      state.limits = { resetAt: new Date(Date.now() + 5 * 3600e3).toISOString(), back: false, source: "manual" };
      bus.notice("Claude window started. Resets in 5 hours.", "ok");
      break;

    case "settings.update": {
      const p = m.patch;
      if (p.hosting) {
        state.hosting = p.hosting;
        if (p.hosting === "cloud" && state.permissionMode === "full") state.permissionMode = "auto";
      }
      if (p.permissionMode) {
        if (p.permissionMode === "full" && state.hosting === "cloud") {
          send(c.ws, { type: "notice", text: "Full mode needs your own VM or self-hosting", tone: "warn" });
        } else state.permissionMode = p.permissionMode;
      }
      break;
    }

    case "agent.create": {
      const a = m.agent;
      const agent = { id: id("a"), name: a.name.slice(0, 24) || "New agent", purpose: a.purpose, shape: a.shape, color: a.color, seed: 40 + state.agents.length * 17, role: PURPOSE_ROLES[a.purpose] || PURPOSE_ROLES.custom, builtin: false };
      state.agents.push(agent);
      if (m.app) state.appAgents[m.app].push(agent.id);
      saveNow();
      log("main", `Made ${agent.name}`);
      send(c.ws, { type: "agent.created", agentId: agent.id });
      break;
    }
    case "agent.delete": {
      const a = agentById(m.agentId);
      if (!a || (a.builtin && a.purpose !== "app")) return;
      const app = appOfAgent(a.id);
      if (app && state.appAgents[app].length <= minAppAgents(app)) {
        send(c.ws, { type: "notice", text: `Add or choose another ${app} agent before deleting ${a.name}.`, tone: "warn" });
        return;
      }
      if (busyTask(a.id)) { send(c.ws, { type: "notice", text: `Wait for ${a.name}'s current work to finish before deleting it.`, tone: "warn" }); return; }
      const ok = await requestApproval({ agentId: "main", kind: "risky", risk: "delete", title: `Delete ${a.name}?`, body: "Its open tasks move back to your list. Deleting always needs your press." });
      if (!ok) return;
      const currentApp = appOfAgent(a.id);
      if (busyTask(a.id) || (currentApp && state.appAgents[currentApp].length <= minAppAgents(currentApp))) return;
      for (const t of state.tasks) {
        if (t.agentId !== a.id || t.status === "done") continue;
        cancelTask(t.id);
        patchTask(t, { agentId: null, target: "todo", status: "todo" });
      }
      if (currentApp) state.appAgents[currentApp] = state.appAgents[currentApp].filter(agentId => agentId !== a.id);
      state.agents = state.agents.filter(x => x.id !== a.id);
      saveNow();
      bus.notice(`${a.name} deleted`, "info");
      break;
    }
    case "agent.update": {
      const a = agentById(m.agentId);
      if (!a) return;
      const p = m.patch, before = a.name;
      if (p.name !== undefined) a.name = p.name.trim().slice(0, AGENT_NAME_MAX);
      if (p.personality !== undefined) a.personality = p.personality.trim().slice(0, AGENT_PERSONALITY_MAX) || undefined;
      if (p.shape !== undefined) a.shape = p.shape;
      if (p.color !== undefined) a.color = p.color;
      saveNow();
      const what = p.name !== undefined && p.name.trim() !== before ? `Renamed ${before} to ${a.name}` : p.personality !== undefined ? `Gave ${a.name} a new personality` : `Gave ${a.name} a new look`;
      log(a.id, what);
      bus.notice(what, "ok");
      break;
    }
    case "app.agent.add": {
      const agent = agentById(m.agentId);
      if (!APP_IDS.includes(m.app) || !agent) return;
      if (agent.id === "main") {
        send(c.ws, { type: "notice", text: "Omni runs your other agents and never joins an app. Choose another Task agent for this app.", tone: "warn" });
        return;
      }
      if (appOfAgent(agent.id)) {
        send(c.ws, { type: "notice", text: `${agent.name} is already assigned to an app. Choose another Task agent.`, tone: "warn" });
        return;
      }
      state.appAgents[m.app].push(agent.id);
      saveNow();
      log("main", `${agent.name} joined ${m.app}`);
      bus.notice(`${agent.name} joined ${m.app}`, "ok");
      break;
    }
    case "app.agent.replace": {
      const agent = agentById(m.newAgentId);
      const old = agentById(m.oldAgentId);
      if (!APP_IDS.includes(m.app) || !agent || !old || !state.appAgents[m.app].includes(old.id)) return;
      if (agent.id === "main" || appOfAgent(agent.id)) { send(c.ws, { type: "notice", text: "Choose an agent that is not assigned to an app.", tone: "warn" }); return; }
      if (busyTask(old.id)) { send(c.ws, { type: "notice", text: `Wait for ${old.name}'s current work to finish.`, tone: "warn" }); return; }
      state.appAgents[m.app] = state.appAgents[m.app].map(agentId => agentId === old.id ? agent.id : agentId);
      saveNow();
      log("main", `${agent.name} replaced ${old.name} in ${m.app}`);
      bus.notice(`${agent.name} replaced ${old.name} in ${m.app}`, "ok");
      break;
    }
    case "app.agent.remove": {
      const agent = agentById(m.agentId);
      if (!APP_IDS.includes(m.app) || !agent || !state.appAgents[m.app].includes(agent.id)) return;
      if (state.appAgents[m.app].length <= minAppAgents(m.app)) {
        send(c.ws, { type: "notice", text: `${agent.name} is the last ${m.app} agent. Add another first.`, tone: "warn" });
        return;
      }
      if (busyTask(agent.id)) { send(c.ws, { type: "notice", text: `Wait for ${agent.name}'s current work to finish.`, tone: "warn" }); return; }
      state.appAgents[m.app] = state.appAgents[m.app].filter(agentId => agentId !== agent.id);
      saveNow();
      log("main", `${agent.name} left ${m.app}`);
      bus.notice(`${agent.name} left ${m.app}`, "ok");
      break;
    }
    case "machine.check":
      machines.check(m.machineId);
      return;
    case "demo.reset":
      for (const t of state.tasks) cancelTask(t.id);
      resetState();
      machines.sync();
      bus.notice("Demo data reset", "info");
      break;
  }
  save();
  changed();
}

/* ------------------------------- Timers ------------------------------- */

setInterval(() => {
  const t = Date.now();
  const f = state.focus;
  if (f.running && f.endsAt && Date.parse(f.endsAt) <= t) {
    const wasFocus = f.kind === "focus";
    state.focus = { ...f, running: false, endsAt: null, remainingMs: f.lengthMs, round: wasFocus ? f.round + 1 : f.round };
    log("main", wasFocus ? "Focus round done" : "Break over");
    bus.notice(wasFocus ? "Focus round done. Take a break." : "Break's over.", "happy");
    save();
    changed();
  }
  const l = state.limits;
  if (l.resetAt && !l.back && Date.parse(l.resetAt) <= t) {
    state.limits = { ...l, back: true };
    bus.notice("Claude limits are back", "happy");
    save();
    changed();
  }
}, 1000);

// Read the real Claude Code window from connected machines every 2 minutes.
async function pollClaudeWindow() {
  if (state.limits.source === "manual") return;
  for (const link of machines.links()) {
    if (!link.online || !link.hello?.actions.includes("claude.window")) continue;
    const r = await link.run("claude.window", {}).catch(() => null);
    const d = r?.ok ? (r.data as { active?: boolean; endsAt?: string }) : null;
    if (!d) continue;
    if (d.active && d.endsAt) {
      if (state.limits.resetAt !== d.endsAt) {
        state.limits = { resetAt: d.endsAt, back: false, source: "claude-code", machine: link.name };
        save();
        changed();
      }
      return;
    }
  }
}
setInterval(() => void pollClaudeWindow(), 120_000);

machines.onOnline(name => {
  bus.notice(`${name} is back online`, "ok");
  resumePausedForMachines();
  void pollClaudeWindow();
});

/* ------------------------------- HTTP + WS ------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (await handleEngineHttp(req, res, url)) return;
  if (url.pathname === "/preview") {
    res.writeHead(308, { location: "/preview/" }).end();
  } else if (url.pathname.startsWith("/preview/")) {
    if (config.deviceToken) res.setHeader("content-security-policy", "sandbox allow-scripts allow-forms");
    await serveBuildPreview(req, res, url.pathname.slice("/preview/".length));
  } else if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, clients: clients.size, llm: hasLlm(), machines: machines.list().map(m => ({ name: m.name, online: m.online })) }));
  } else if (url.pathname === "/api/snapshot") {
    if (config.deviceToken) res.writeHead(403).end();
    else res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(snapshot()));
  } else if (url.pathname === "/setup") {
    await handleSetup(req, res, url);
  } else if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end(`Flip server. Device WebSocket: /ws. Setup: ${lanUrl()}/setup\n`);
  } else res.writeHead(404).end();
});

const wss = new WebSocketServer({
  noServer: true,
  path: "/ws",
  maxPayload: 40 * 1024 * 1024,
  handleProtocols: protocols => protocols.has(deviceProtocol) ? deviceProtocol : false,
  verifyClient: ({ req }: { req: http.IncomingMessage }) => {
    if (!config.deviceToken) return true;
    const protocols = req.headers["sec-websocket-protocol"]?.split(",").map(value => value.trim()) ?? [];
    return protocols.includes(deviceProtocol) && protocols.some(value => {
      const actual = Buffer.from(value);
      return actual.length === deviceCredential.length && timingSafeEqual(actual, deviceCredential);
    });
  },
});
// /ws is the Device. /preview/ passes the Build dev server's hot reload through (ADR 0033).
server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url || "/", "http://x").pathname;
  if (pathname === "/ws") wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  else if (pathname.startsWith("/preview/")) upgradeBuildPreview(req, socket, head);
  else socket.destroy();
});
wss.on("connection", ws => {
  const c: Client = { ws, kind: "device", mode: "handheld", deviceId: "" };
  clients.add(c);
  ws.on("message", raw => {
    const m = parseDeviceMessage(String(raw));
    if (!m) return;
    handle(c, m).catch(err => {
      console.error(`[ws] ${m.type} failed:`, err);
      send(ws, { type: "error", message: (err as Error).message });
    });
  });
  ws.on("close", () => {
    clients.delete(c);
    changed();
  });
  // Liveness: drop dead sockets so the Device notices it is offline.
  const alive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.ping(), 15000);
  ws.on("close", () => clearInterval(alive));
});

machines.sync();
resumeQueuedTasks();
server.listen(config.port, config.host, () => {
  console.log(`\nFlip server on ${lanUrl()}  (ws path /ws)`);
  console.log(`Setup page: ${lanUrl()}/setup`);
  console.log(`Agents: ${hasLlm() ? `${llmMode()} (${agentModel()})` : config.demoPlanner ? "demo planner" : "AI key required"} · Speech to text: ${sttMode()}`);
  console.log(`Machines: ${state.machines.map(m => `${m.name} (${m.url})`).join(", ") || "none"}\n`);
  const engine = engineModel();
  console.log(`Agent engine: ${engineEnabled() ? `OpenCode${engine ? ` (${engine.providerID}/${engine.modelID})` : ", waiting for a key"}` : "built-in loop"}`);
  warmEngine();
  restoreDev();
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { stopEngine(); saveNow(); process.exit(0); });
process.once("exit", stopEngine);
