// Flip server: the WebSocket hub for the Device and Dock, the task agents, voice, focus and limits.
//   pnpm --filter server dev     ->  ws://localhost:8787/ws, setup page at http://localhost:8787/setup
import http from "node:http";
import os from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  parseDeviceMessage,
  type ClientKind,
  type DeviceMessage,
  type DeviceMode,
  type ServerMessage,
  type Snapshot,
  type Task,
} from "@app/protocol";
import { config } from "./config.js";
import { state, save, id, now, agentById, taskById, noteById, log, patchTask, resetState, PURPOSE_ROLES } from "./store.js";
import { bus } from "./bus.js";
import { machines } from "./machines.js";
import { hasLlm, apiKey } from "./llm.js";
import { sttMode } from "./voice.js";
import { press, requestApproval, resumeHeld } from "./approvals.js";
import { startTask, cancelTask, isRunning, resumePausedForMachines } from "./agents/runner.js";
import { voiceStart, voiceChunk, voiceEnd, voiceCancel, voiceScripted, syncOfflineNote, runSuggestions } from "./notes.js";
import { handleSetup } from "./setup.js";

const SERVER_ID = id("srv");

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

function snapshot(): Snapshot {
  const devices = [...clients];
  const handheld = devices.filter(c => c.kind === "device");
  return {
    version: PROTOCOL_VERSION,
    serverTime: now(),
    notes: state.notes.slice(0, 80),
    tasks: state.tasks.slice(0, 120),
    agents: state.agents,
    activity: state.activity.slice(0, 20),
    approvals: state.approvals,
    machines: machines.list(),
    settings: {
      permissionMode: state.permissionMode,
      hosting: state.hosting,
      serverUrl: lanUrl(),
      provider: "anthropic",
      keySet: hasLlm(),
      keyHint: apiKey() ? apiKey().slice(-4) : undefined,
      model: config.agentModel,
      setupUrl: `${lanUrl()}/setup`,
    },
    focus: state.focus,
    limits: state.limits,
    services: { llm: hasLlm() ? "claude" : "planner", stt: sttMode(), smtp: !!config.smtpUrl },
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
      return voiceScripted(m.text, m.cloudText, m.durationMs, m.target);
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
      log("main", `Made ${agent.name}`);
      send(c.ws, { type: "agent.created", agentId: agent.id });
      break;
    }
    case "agent.delete": {
      const a = agentById(m.agentId);
      if (!a || a.builtin) return;
      const ok = await requestApproval({ agentId: "main", kind: "risky", risk: "delete", title: `Delete ${a.name}?`, body: "Its open tasks move back to your list. Deleting always needs your press." });
      if (!ok) return;
      for (const t of state.tasks) {
        if (t.agentId !== a.id || t.status === "done") continue;
        cancelTask(t.id);
        patchTask(t, { agentId: null, target: "todo", status: "todo" });
      }
      state.agents = state.agents.filter(x => x.id !== a.id);
      bus.notice(`${a.name} deleted`, "info");
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
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, clients: clients.size, llm: hasLlm(), machines: machines.list().map(m => ({ name: m.name, online: m.online })) }));
  } else if (url.pathname === "/api/snapshot") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" }).end(JSON.stringify(snapshot()));
  } else if (url.pathname === "/setup") {
    await handleSetup(req, res, url);
  } else if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/plain" }).end(`Flip server. Device WebSocket: /ws. Setup: ${lanUrl()}/setup\n`);
  } else res.writeHead(404).end();
});

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 40 * 1024 * 1024 });
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
server.listen(config.port, config.host, () => {
  console.log(`\nFlip server on ${lanUrl()}  (ws path /ws)`);
  console.log(`Setup page: ${lanUrl()}/setup`);
  console.log(`Agents: ${hasLlm() ? `Claude (${config.agentModel})` : "built-in planner (no ANTHROPIC_API_KEY yet)"} · Speech to text: ${sttMode()}`);
  console.log(`Machines: ${state.machines.map(m => `${m.name} (${m.url})`).join(", ") || "none"}\n`);
});
