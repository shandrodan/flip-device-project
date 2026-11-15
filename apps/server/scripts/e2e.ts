// End-to-end check of the demo flow, no browser needed:
//   dump -> note -> suggestions -> accept -> PC agent works -> approval press -> done.
// Spawns a real server and a real PC agent against a throwaway home folder.
//   pnpm test:e2e            (add RUNS=20 to run the flow 20 times in a row)
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { PROTOCOL_VERSION, isAppCommand, minAppAgents, type AppId, type DeviceMessage, type ServerMessage, type Snapshot, type Task } from "@app/protocol";

const RUNS = Number(process.env.RUNS || 1);
const PORT = 18787, PC_PORT = 17077;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "flip-e2e-"));
const home = path.join(root, "home");
const shots = path.join(home, "Desktop", "Screenshots");
const procs: ChildProcess[] = [];

function seed() {
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(shots, { recursive: true });
  fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });
  fs.writeFileSync(path.join(home, "Downloads", "Pitch-v7.pdf"), "%PDF-1.4 fake deck");
  const old = Date.now() / 1000 - 30 * 86400;
  for (let i = 0; i < 6; i++) {
    const f = path.join(shots, `Screenshot old ${i}.png`);
    fs.writeFileSync(f, `old-${i}`);
    fs.utimesSync(f, old, old);
  }
  for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(shots, `Screenshot new ${i}.png`), `new-${i}`);
  fs.writeFileSync(path.join(shots, "Screenshot new 0 copy.png"), "new-0"); // duplicate
  fs.writeFileSync(path.join(shots, "Screenshot new 1 copy.png"), "new-1"); // duplicate
  // The Build app's project (ADR 0021).
  fs.mkdirSync(path.join(home, "Flip", "build"), { recursive: true });
  fs.writeFileSync(path.join(home, "Flip", "build", "index.html"), "<h1>Flip Device</h1>");
}

function start(name: string, cwd: string, env: Record<string, string>) {
  const p: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.on("data", d => process.env.VERBOSE && process.stdout.write(`[${name}] ${d}`));
  p.stderr!.on("data", d => process.stdout.write(`[${name}!] ${d}`));
  procs.push(p);
  return p;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
function fail(msg: string): never {
  console.error(`\n✕ ${msg}`);
  cleanup();
  process.exit(1);
}
function cleanup() {
  for (const p of procs) p.kill();
  fs.rmSync(root, { recursive: true, force: true });
}

async function connect(protocols?: string[], onMessage?: (raw: WebSocket.RawData) => void) {
  for (let i = 0; i < 60; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, protocols);
      if (onMessage) ws.on("message", onMessage);
      await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      return ws;
    } catch { await sleep(250); }
  }
  fail("server didn't start");
}

async function main() {
  seed();
  const legacyDir = path.join(root, "data");
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, "state.json"), JSON.stringify({
    agents: [{ id: "main", name: "Main agent", purpose: "main", shape: "circle", color: "#fff", seed: 3, role: "Coordinates work.", builtin: true }],
    appOwners: { todo: "app_todo" },
    notes: [{ id: "legacy_note", text: "Keep this old Note", createdAt: new Date().toISOString(), transcribedBy: "local", editedByUser: false, suggestionState: "none", suggestions: [], taskIds: [] }],
  }));
  const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  // An external mail viewer can keep the fixture open on Windows between runs.
  const pcEnv = { HOME: home, USERPROFILE: home, PC_AGENT_PORT: String(PC_PORT), PC_AGENT_HOST: "127.0.0.1", PC_AGENT_TOKEN: "e2e", PC_AGENT_NAME: "Test laptop", PC_AGENT_ALLOW_OPEN: "0", PC_AGENT_ALLOW_SHELL: "0" };
  let pc = start("pc", path.join(here, "../pc-agent"), pcEnv);
  const serverEnv = {
    HOST: "127.0.0.1",
    PORT: String(PORT),
    PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    DATA_DIR: path.join(root, "data"),
    PC_AGENTS: `Test laptop=ws://127.0.0.1:${PC_PORT}`,
    PC_AGENT_TOKEN: "e2e",
    HOSTING: "self",
    DEVICE_ACCESS_TOKEN: "",
    DEMO_PLANNER: "1",
    AGENT_ENGINE: "builtin",
    ANTHROPIC_API_KEY: process.env.E2E_CLAUDE ? process.env.ANTHROPIC_API_KEY ?? "" : "",
    OPENROUTER_API_KEY: "",
    STT_API_KEY: "",
    LOCAL_STT_URL: "",
    SMTP_URL: "",
    BUILD_DIR: "~/Flip/build",
    BUILD_PREVIEW_URL: "",
  };
  let serverProc = start("server", here, serverEnv);

  const ws = await connect();
  let snap: Snapshot | null = null;
  const events: ServerMessage[] = [];
  ws.on("message", raw => {
    const m = JSON.parse(String(raw)) as ServerMessage;
    if (m.type === "snapshot") snap = m.snapshot;
    else events.push(m);
  });
  const sendMsg = (m: DeviceMessage) => ws.send(JSON.stringify(m));
  const until = async <T>(what: string, fn: () => T | undefined | null | false, ms = 15000): Promise<T> => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    fail(`timed out waiting for: ${what}`);
  };

  sendMsg({ type: "hello", deviceId: "e2e", mode: "handheld", client: "device", protocol: PROTOCOL_VERSION });
  await until("PC agent online", () => snap?.machines.some(m => m.online));
  if (!snap!.notes.some(note => note.id === "legacy_note") || snap!.appAgents.todo[0] !== "app_todo" || !snap!.agents.some(agent => agent.id === snap!.appAgents.todo[0]))
    fail("older state lost data or did not get app owners");
  if (new Set(Object.values(snap!.appAgents).flat()).size !== 5 || Object.entries(snap!.appAgents).some(([app, agents]) => agents.length < minAppAgents(app as AppId))) fail("apps did not get distinct Task agents");
  if (snap!.appAgents.build.length || !snap!.build) fail("Build should start with no agent of its own");
  if (snap!.build.previewMode !== "proxy" || !snap!.build.previewUrl) fail("Build should start with the server preview");
  const preview = await fetch(snap!.build.previewUrl);
  if (!preview.ok || !(await preview.text()).includes("<h1>Flip Device</h1>")) fail("Build preview did not serve the project from the PC agent");
  console.log("✓ server up, PC agent online");

  for (let run = 1; run <= RUNS; run++) {
    if (run > 1) { seed(); sendMsg({ type: "demo.reset" }); await sleep(300); }
    events.length = 0;
    const t0 = Date.now();
    sendMsg({
      type: "voice.scripted",
      text: "okay so before Sunday I need to send Jonas the pitch deck, and my screenshots folder is a mess, clean it up but keep the ones from this week",
      cloudText: "Before Sunday I need to send Jonas the pitch deck. And my screenshots folder is a mess. Clean it up, but keep the ones from this week.",
      durationMs: 9000,
      target: { kind: "note" },
    });
    const saved = await until("note.saved", () => events.find(e => e.type === "note.saved"));
    const reaction = Date.now() - t0;
    const noteId = saved.type === "note.saved" ? saved.note.id : "";
    const note = await until("suggestions", () => snap?.notes.find(n => n.id === noteId && n.suggestionState === "ready"));
    console.log(`✓ run ${run}: note saved in ${reaction} ms; suggestions: ${note.suggestions.map(s => `${s.title} → ${s.agentId ?? "todo"}`).join(" | ")}`);
    if (reaction > 2000) fail("first reaction took over 2 s");
    if (note.suggestions.length !== 2) fail(`expected 2 suggestions, got ${note.suggestions.length}`);
    if (!note.suggestions.some(s => s.agentId === "mail")) fail("no task routed to the mail agent");
    if (!note.suggestions.some(s => s.agentId === "pc")) fail("no task routed to the PC agent");

    sendMsg({ type: "suggestion.accept", noteId, suggestionIds: note.suggestions.map(s => s.id), asTodos: false });

    // Two risky approvals arrive (send, delete). Hold one with "Not now", resume it, then approve.
    const pressed = new Set<string>();
    let heldOnce = false;
    await until("both tasks done", () => {
      const s = snap!;
      for (const ap of s.approvals) {
        if (ap.held || pressed.has(ap.requestId)) continue;
        if (ap.kind !== "risky") fail(`expected only risky approvals in Auto, got ${ap.title}`);
        if (!heldOnce && ap.risk === "delete") {
          if (fs.readdirSync(path.join(shots, "Archive")).length !== 6) fail("the older screenshots did not move before approval");
          if (fs.existsSync(path.join(home, ".flip-trash"))) fail("files were trashed before the Approval press");
          heldOnce = true;
          pressed.add(ap.requestId);
          sendMsg({ type: "approval.press", requestId: ap.requestId, approved: false, via: "b-button" });
          setTimeout(() => {
            pressed.delete(ap.requestId);
            sendMsg({ type: "task.resume", taskId: ap.taskId! });
          }, 300);
          continue;
        }
        pressed.add(ap.requestId);
        console.log(`  ↳ approval: "${ap.title}" (${ap.risk}) → push bar`);
        sendMsg({ type: "approval.press", requestId: ap.requestId, approved: true, via: "push-bar" });
      }
      const ids = s.notes.find(n => n.id === noteId)?.taskIds ?? [];
      const tasks = s.tasks.filter(t => ids.includes(t.id));
      const bad = tasks.find(t => t.status === "failed" || t.status === "paused");
      if (bad) fail(`task "${bad.title}" ${bad.status}: ${bad.detail}`);
      return tasks.length === 2 && tasks.every(t => t.status === "done") ? tasks : null;
    }, 30000).then(tasks => tasks.forEach(t => console.log(`  ✓ ${t.title}: ${t.detail}`)));

    // The files really moved on the "laptop".
    const left = fs.readdirSync(shots).filter(f => f.endsWith(".png")).sort();
    const archived = fs.readdirSync(path.join(shots, "Archive"));
    const outbox = fs.readdirSync(path.join(home, "Flip", "Outbox"));
    const trash = fs.readdirSync(path.join(home, ".flip-trash"));
    if (archived.length !== 6) fail(`expected 6 archived, got ${archived.length}`);
    if (left.length !== 4) fail(`expected 4 kept, got ${left.join(", ")}`);
    if (!outbox.some(f => f.endsWith(".eml"))) fail("no email in Outbox");
    const eml = fs.readFileSync(path.join(home, "Flip", "Outbox", outbox[0]), "utf8");
    if (!eml.includes("Pitch-v7.pdf")) fail("email has no attachment");
    if (!trash.length) fail("duplicates not in .flip-trash");
    if (!left.includes("Screenshot new 0.png") || left.some(f => f.includes("copy"))) fail(`kept the copies instead of the originals: ${left.join(", ")}`);
    console.log(`  ✓ on disk: kept ${left.length}, archived ${archived.length}, 2 duplicates in .flip-trash, ${outbox[0]} with Pitch-v7.pdf`);
  }

  // Home voice reaches main. Main asks Mail agent, waits, then answers the user.
  events.length = 0;
  sendMsg({ type: "voice.scripted", streamId: "voice-main-e2e", text: "Send pitch deck to Jonas", durationMs: 3000, target: { kind: "main" } });
  const mainAccepted = await until("main voice accepted", () => events.find(e => e.type === "voice.accepted" && e.streamId === "voice-main-e2e"));
  if (mainAccepted.type !== "voice.accepted") fail("main voice had no Task");
  const mainTaskId = mainAccepted.taskId;
  const mailChild = await until("main delegated to Mail agent", () => snap?.tasks.find(t => t.parentTaskId === mainTaskId && t.agentId === "mail"));
  const mainApprovals = new Set<string>();
  await until("main reported the Mail result", () => {
    for (const approval of snap?.approvals ?? []) {
      if (mainApprovals.has(approval.requestId)) continue;
      mainApprovals.add(approval.requestId);
      sendMsg({ type: "approval.press", requestId: approval.requestId, approved: true, via: "push-bar" });
    }
    return snap?.tasks.find(t => t.id === mainTaskId && t.status === "done");
  }, 30000);
  if (snap!.tasks.find(t => t.id === mailChild.id)?.status !== "done") fail("Mail agent did not finish");
  if (!snap!.messages.some(m => m.fromAgentId === "main" && m.toAgentId === "mail" && m.taskId === mailChild.id)) fail("main request was not saved");
  if (!snap!.messages.some(m => m.fromAgentId === "mail" && m.toAgentId === "main" && m.taskId === mailChild.id)) fail("Mail reply was not saved");
  if (!snap!.messages.some(m => m.fromAgentId === "main" && m.toAgentId === "user" && m.taskId === mainTaskId)) fail("main did not answer the user");
  console.log("✓ Home voice: main delegated, got a reply and answered");

  // A Task agent added during this run can receive direct voice and change To-Do.
  events.length = 0;
  sendMsg({ type: "agent.create", agent: { name: "Helper", purpose: "custom", shape: "pebble", color: "#34d17a" } });
  const created = await until("new Task agent", () => events.find(e => e.type === "agent.created"));
  if (created.type !== "agent.created") fail("Task agent was not created");
  const helperId = created.agentId;
  sendMsg({ type: "voice.scripted", streamId: "voice-helper-e2e", text: "Add a todo to review the prototype", durationMs: 3000, target: { kind: "agent", agentId: helperId } });
  const directAccepted = await until("direct voice accepted", () => events.find(e => e.type === "voice.accepted" && e.streamId === "voice-helper-e2e"));
  if (directAccepted.type !== "voice.accepted" || directAccepted.agentId !== helperId) fail("direct voice went to the wrong Task agent");
  await until("direct Task agent answered", () => snap?.tasks.find(t => t.id === directAccepted.taskId && t.status === "done"));
  const todoOwner = snap!.appAgents.todo[0];
  const todoChild = snap!.tasks.find(t => t.parentTaskId === directAccepted.taskId && t.appRequest?.app === "todo");
  if (!todoChild || todoChild.agentId !== todoOwner || todoChild.status !== "done") fail("To-Do work bypassed its assigned Task agent");
  if (!snap!.messages.some(m => m.fromAgentId === helperId && m.toAgentId === todoOwner && m.taskId === todoChild.id)) fail("To-Do owner request was not saved");
  if (!snap!.tasks.some(t => t.target === "todo" && t.title === "review the prototype")) fail("Task agent did not change To-Do");
  if (!snap!.messages.some(m => m.fromAgentId === helperId && m.toAgentId === "user" && m.taskId === directAccepted.taskId)) fail("Task agent did not answer the user");
  console.log("✓ Direct voice: a new Task agent changed To-Do and answered");

  // Two Task agents exchange a request and a reply. The second changes Focus.
  events.length = 0;
  sendMsg({ type: "voice.scripted", streamId: "voice-agent-request-e2e", text: "Ask PC agent to start focus for 5 minutes", durationMs: 3000, target: { kind: "agent", agentId: helperId } });
  const agentRequest = await until("agent request accepted", () => events.find(e => e.type === "voice.accepted" && e.streamId === "voice-agent-request-e2e"));
  if (agentRequest.type !== "voice.accepted") fail("agent request had no Task");
  const focusChild = await until("Task agent asked PC agent", () => snap?.tasks.find(t => t.parentTaskId === agentRequest.taskId && t.agentId === "pc"));
  await until("PC agent changed Focus and replied", () => snap?.tasks.find(t => t.id === agentRequest.taskId && t.status === "done") && snap?.focus.running);
  if (!snap!.messages.some(m => m.fromAgentId === helperId && m.toAgentId === "pc" && m.taskId === focusChild.id)) fail("Task agent request was not saved");
  if (!snap!.messages.some(m => m.fromAgentId === "pc" && m.toAgentId === helperId && m.taskId === focusChild.id)) fail("PC agent reply was not saved");
  const focusOwnerTask = snap!.tasks.find(t => t.parentTaskId === focusChild.id && t.appRequest?.app === "focus");
  if (!focusOwnerTask || !snap!.appAgents.focus.includes(focusOwnerTask.agentId!) || focusOwnerTask.status !== "done") fail("Focus work bypassed its assigned Task agent");
  console.log("✓ Task agents exchanged a request and reply; Focus changed");

  // A queued voice transcript gets one Task and can change Notes.
  events.length = 0;
  sendMsg({ type: "voice.message", requestId: "voice-offline-e2e", text: "Save a note that the prototype is ready", target: { kind: "agent", agentId: helperId } });
  const queuedAccepted = await until("queued voice accepted", () => events.find(e => e.type === "voice.accepted" && e.streamId === "voice-offline-e2e"));
  if (queuedAccepted.type !== "voice.accepted") fail("queued voice had no Task");
  await until("queued voice changed Notes", () => snap?.tasks.find(t => t.id === queuedAccepted.taskId && t.status === "done") && snap?.notes.find(n => n.text === "the prototype is ready"));
  const notesOwnerTask = snap!.tasks.find(t => t.parentTaskId === queuedAccepted.taskId && t.appRequest?.app === "notes");
  if (!notesOwnerTask || !snap!.appAgents.notes.includes(notesOwnerTask.agentId!) || notesOwnerTask.status !== "done") fail("Notes work bypassed its assigned Task agent");
  sendMsg({ type: "voice.message", requestId: "voice-offline-e2e", text: "Save a note that the prototype is ready", target: { kind: "agent", agentId: helperId } });
  await until("repeat queued voice receipt", () => events.filter(e => e.type === "voice.accepted" && e.streamId === "voice-offline-e2e").length === 2);
  if (snap!.messages.filter(m => m.id === "voice-offline-e2e").length !== 1) fail("replayed voice made a second message");
  console.log("✓ Queued voice changed Notes and replay made no second Task");

  // One agent can join only one app. One app can have several agents and must keep one.
  sendMsg({ type: "app.agent.add", app: "todo", agentId: "app_notes" });
  await until("cross-app agent rejected", () => events.find(e => e.type === "notice" && e.text.includes("already assigned to an app")));
  sendMsg({ type: "app.agent.add", app: "todo", agentId: "main" });
  await until("main app agent rejected", () => events.find(e => e.type === "notice" && e.text.includes("never joins an app")));
  if (snap!.appAgents.todo.length !== 1) fail("An agent joined two apps, or Main joined an app");
  sendMsg({ type: "app.agent.add", app: "todo", agentId: helperId });
  await until("second To-Do agent", () => snap?.appAgents.todo.includes(helperId));

  // Hold the first agent at an approval. The next app voice task goes to the free agent.
  sendMsg({ type: "settings.update", patch: { permissionMode: "manual" } });
  await until("Manual mode for app routing", () => snap?.settings.permissionMode === "manual");
  events.length = 0;
  sendMsg({ type: "voice.scripted", streamId: "app-voice-first", text: "Add a todo to check the first app agent", durationMs: 3000, target: { kind: "app", app: "todo" } });
  const firstAppVoice = await until("first app voice accepted", () => events.find(e => e.type === "voice.accepted" && e.streamId === "app-voice-first"));
  if (firstAppVoice.type !== "voice.accepted" || firstAppVoice.agentId !== todoOwner) fail("first app voice missed the first agent");
  await until("first app agent waits for approval", () => snap?.approvals.some(approval => approval.taskId === firstAppVoice.taskId));
  sendMsg({ type: "voice.scripted", streamId: "app-voice-second", text: "Add a todo to check the second app agent", durationMs: 3000, target: { kind: "app", app: "todo" } });
  const secondAppVoice = await until("second app voice accepted", () => events.find(e => e.type === "voice.accepted" && e.streamId === "app-voice-second"));
  if (secondAppVoice.type !== "voice.accepted" || secondAppVoice.agentId !== helperId) fail("second app voice did not go to the less busy agent");
  const appApprovals = new Set<string>();
  await until("both app agents finished", () => {
    for (const approval of snap?.approvals ?? []) {
      if (appApprovals.has(approval.requestId)) continue;
      appApprovals.add(approval.requestId);
      sendMsg({ type: "approval.press", requestId: approval.requestId, approved: true, via: "a-button" });
    }
    return snap?.tasks.find(task => task.id === firstAppVoice.taskId && task.status === "done") && snap?.tasks.find(task => task.id === secondAppVoice.taskId && task.status === "done");
  });
  sendMsg({ type: "settings.update", patch: { permissionMode: "auto" } });
  await until("Auto mode restored", () => snap?.settings.permissionMode === "auto");

  events.length = 0;
  sendMsg({ type: "agent.create", agent: { name: "Replacement", purpose: "custom", shape: "pebble", color: "#34d17a" } });
  const replacement = await until("replacement agent created", () => events.find(e => e.type === "agent.created"));
  if (replacement.type !== "agent.created") fail("replacement agent was not created");
  sendMsg({ type: "app.agent.replace", app: "todo", oldAgentId: helperId, newAgentId: replacement.agentId });
  await until("To-Do agent replaced", () => snap?.appAgents.todo.includes(replacement.agentId) && !snap.appAgents.todo.includes(helperId));
  if (!snap!.agents.some(agent => agent.id === helperId)) fail("Change deleted the old agent");
  events.length = 0;
  sendMsg({ type: "agent.delete", agentId: replacement.agentId });
  const deleteApproval = await until("app agent deletion approval", () => snap?.approvals.find(approval => approval.title.includes("Delete Replacement")));
  sendMsg({ type: "approval.press", requestId: deleteApproval.requestId, approved: true, via: "push-bar" });
  await until("second app agent deleted", () => snap?.appAgents.todo.length === 1 && !snap.agents.some(agent => agent.id === replacement.agentId));
  events.length = 0;
  sendMsg({ type: "agent.delete", agentId: todoOwner });
  await until("last app agent deletion rejected", () => events.find(e => e.type === "notice" && e.text.includes("Add or choose another")));
  if (snap!.appAgents.todo[0] !== todoOwner) fail("The last app agent was deleted");

  events.length = 0;
  sendMsg({ type: "agent.create", app: "todo", agent: { name: "New To-Do agent", purpose: "custom", shape: "pebble", color: "#ffd60a" } });
  const newAppAgent = await until("new app agent created", () => events.find(e => e.type === "agent.created"));
  if (newAppAgent.type !== "agent.created") fail("new app agent was not created");
  await until("new app agent assigned", () => snap?.appAgents.todo.includes(newAppAgent.agentId));
  sendMsg({ type: "agent.delete", agentId: todoOwner });
  const builtinApproval = await until("default app agent deletion approval", () => snap?.approvals.find(approval => approval.title.includes("Delete To-Do agent")));
  sendMsg({ type: "approval.press", requestId: builtinApproval.requestId, approved: true, via: "push-bar" });
  await until("default app agent deleted", () => snap?.appAgents.todo.length === 1 && snap.appAgents.todo[0] === newAppAgent.agentId);
  console.log("✓ App agent add, change, delete, least-busy routing, and one-agent minimum");

  // Build (ADR 0021): no agent of its own means the main agent does the work. An assigned agent
  // takes over, and deleting the last one hands the work back to main.
  const buildVoice = async (streamId: string) => {
    events.length = 0;
    const rev = snap!.build!.rev;
    sendMsg({ type: "voice.scripted", streamId, text: "Add a waitlist form under the hero", durationMs: 3000, target: { kind: "app", app: "build" } });
    const accepted = await until(`${streamId} accepted`, () => events.find(e => e.type === "voice.accepted" && e.streamId === streamId));
    if (accepted.type !== "voice.accepted") fail("Build voice was not accepted");
    const task = await until(`${streamId} finished`, () => snap?.tasks.find(t => t.id === accepted.taskId && t.status === "done"));
    if (task.app !== "build") fail("Build task lost its app");
    if (!task.steps.some(st => st.text.includes("build: 1 items"))) fail(`Build task didn't look at the project: ${task.steps.map(st => st.text).join(" | ")}`);
    await until(`${streamId} preview reload`, () => snap!.build!.rev > rev);
    return accepted.agentId;
  };
  if (await buildVoice("build-main") !== "main") fail("Build with no agent didn't fall back to the main agent");
  events.length = 0;
  sendMsg({ type: "agent.create", app: "build", agent: { name: "Builder", purpose: "custom", shape: "squircle", color: "#f4c534" } });
  const builder = await until("Build agent created", () => events.find(e => e.type === "agent.created"));
  if (builder.type !== "agent.created") fail("Build agent was not created");
  await until("Build agent assigned", () => snap?.appAgents.build.includes(builder.agentId));
  if (await buildVoice("build-own") !== builder.agentId) fail("Build didn't use its own agent");
  sendMsg({ type: "agent.delete", agentId: builder.agentId });
  const builderDelete = await until("Build agent deletion approval", () => snap?.approvals.find(approval => approval.title.includes("Delete Builder")));
  sendMsg({ type: "approval.press", requestId: builderDelete.requestId, approved: true, via: "push-bar" });
  await until("last Build agent deleted", () => snap?.appAgents.build.length === 0);
  if (await buildVoice("build-back") !== "main") fail("Build didn't hand the work back to the main agent");
  console.log("✓ Build falls back to the main agent, uses its own agent once assigned, and hands back on delete");

  sendMsg({ type: "voice.scripted", text: "Add a todo to inspect the app map", durationMs: 3000, target: { kind: "note" } });
  const appNote = await until("app task suggestion", () => snap?.notes.find(note => note.text === "Add a todo to inspect the app map" && note.suggestionState === "ready"));
  const appSuggestion = appNote.suggestions.find(item => snap!.appAgents.todo.includes(item.agentId!));
  if (!appSuggestion) fail("Notes did not suggest the assigned To-Do agent");
  sendMsg({ type: "suggestion.accept", noteId: appNote.id, suggestionIds: [appSuggestion.id], asTodos: false });
  const appTask = await until("suggested app task finished", () => snap?.tasks.find(task => task.noteId === appNote.id && snap!.appAgents.todo.includes(task.agentId!) && task.status === "done"));
  if (!appTask || !snap!.tasks.some(task => task.target === "todo" && task.title === "inspect the app map")) fail("suggested app owner did not change To-Do");
  console.log("✓ A task suggested from a Dump went to its app owner");

  // Offline note sync + re-transcription rule.
  events.length = 0;
  sendMsg({ type: "note.sync", note: { localId: "l1", text: "remind me to call the venue", createdAt: new Date().toISOString(), durationMs: 3000, editedByUser: false, cloudText: "Remind me to call the venue about the projector adapter." } });
  const synced = await until("offline note", () => events.find(e => e.type === "note.saved" && e.localId === "l1"));
  const sn = await until("recheck", () => snap?.notes.find(n => synced.type === "note.saved" && n.id === synced.note.id && n.transcribedBy === "cloud"));
  console.log(`✓ offline note re-checked with the cloud: "${sn.text}"`);
  sendMsg({ type: "note.sync", note: { localId: "l2", text: "my own words", createdAt: new Date().toISOString(), durationMs: 3000, editedByUser: true, cloudText: "Something else" } });
  await sleep(800);
  const kept = snap!.notes.find(n => n.text === "my own words");
  if (!kept || kept.transcribedBy !== "local") fail("edited offline note was overwritten");
  console.log("✓ edited offline note kept as the user wrote it");

  // Manual mode: every step asks with a soft card (A button), nothing risky involved.
  sendMsg({ type: "settings.update", patch: { permissionMode: "manual" } });
  await sleep(200);
  const todo = snap!.tasks.find(t => t.status === "todo")!;
  sendMsg({ type: "task.assign", taskId: todo.id, agentId: "main" });
  let softs = 0;
  const seen = new Set<string>();
  await until("manual task done", () => {
    for (const ap of snap!.approvals) {
      if (seen.has(ap.requestId)) continue;
      seen.add(ap.requestId);
      if (ap.kind !== "step") fail(`expected a soft approval in Manual, got ${ap.kind}`);
      softs++;
      sendMsg({ type: "approval.press", requestId: ap.requestId, approved: true, via: "a-button" });
    }
    const t = snap!.tasks.find(x => x.id === todo.id)!;
    if (t.status === "failed") fail(`manual task failed: ${t.detail}`);
    return t.status === "done" && t;
  });
  if (!softs) fail("Manual mode didn't ask");
  console.log(`✓ Manual mode: ${softs} soft approval${softs > 1 ? "s" : ""}, task done`);
  sendMsg({ type: "settings.update", patch: { permissionMode: "auto" } });

  // The laptop drops off: the task pauses, then resumes by itself when it's back.
  pc.kill();
  await until("machine offline", () => snap?.machines.every(m => !m.online));
  const t2 = snap!.tasks.find(t => t.status === "todo")!;
  sendMsg({ type: "task.assign", taskId: t2.id, agentId: "pc" });
  const paused = await until("task paused", () => snap?.tasks.find(t => t.id === t2.id && t.status === "paused"));
  console.log(`✓ laptop offline: "${paused.detail}"`);
  pc = start("pc", path.join(here, "../pc-agent"), pcEnv);
  await until("task resumed and done", () => snap?.tasks.find(t => t.id === t2.id && t.status === "done"), 20000);
  console.log("✓ laptop back: the task resumed by itself and finished");

  // Focus timer, permission rule.
  sendMsg({ type: "settings.update", patch: { permissionMode: "full", hosting: "cloud" } });
  await sleep(300);
  if (snap!.settings.permissionMode === "full") fail("Full mode allowed on our cloud");
  sendMsg({ type: "focus.start", minutes: 25, kind: "focus" });
  await until("focus running", () => snap?.focus.running);
  sendMsg({ type: "focus.stop" });
  await until("focus stopped", () => snap && !snap.focus.running);
  console.log("✓ settings rules and focus timer");

  // Two turns of one Task agent run; the third waits in the saved queue.
  sendMsg({ type: "settings.update", patch: { permissionMode: "manual" } });
  await until("Manual mode for queue", () => snap?.settings.permissionMode === "manual");
  const queueIds = [1, 2, 3].map(i => `voice-queue-${i}`);
  for (const [index, requestId] of queueIds.entries())
    sendMsg({ type: "voice.scripted", streamId: requestId, text: `Add a todo to queue task ${index + 1}`, durationMs: 3000, target: { kind: "agent", agentId: helperId } });
  const queuedTasks = await until("three queued voice Tasks", () => {
    const list = queueIds.map(requestId => {
      const message = snap?.messages.find(item => item.id === requestId);
      return snap?.tasks.find(task => task.id === message?.taskId);
    });
    return list.every(Boolean) ? list as NonNullable<(typeof list)[number]>[] : null;
  });
  await until("third Task waits for a run slot", () => queuedTasks.filter(task => snap?.tasks.find(item => item.id === task.id)?.status === "queued").length === 1);
  const queueApprovals = new Set<string>();
  await until("all queued Tasks done", () => {
    for (const approval of snap?.approvals ?? []) {
      if (queueApprovals.has(approval.requestId)) continue;
      queueApprovals.add(approval.requestId);
      sendMsg({ type: "approval.press", requestId: approval.requestId, approved: true, via: "a-button" });
    }
    return queuedTasks.every(task => snap?.tasks.find(item => item.id === task.id)?.status === "done");
  });
  sendMsg({ type: "settings.update", patch: { permissionMode: "auto" } });
  await until("Auto mode after queue", () => snap?.settings.permissionMode === "auto");
  console.log("✓ One Task agent queued excess work and drained it after approvals");

  // A restart keeps messages and tasks. Work at an approval becomes paused.
  events.length = 0;
  sendMsg({ type: "voice.scripted", streamId: "voice-restart-e2e", text: "Send a note to Jonas", durationMs: 3000, target: { kind: "agent", agentId: "mail" } });
  const pendingAccepted = await until("pending voice accepted", () => events.find(e => e.type === "voice.accepted" && e.streamId === "voice-restart-e2e"));
  if (pendingAccepted.type !== "voice.accepted") fail("pending voice had no Task");
  await until("pending approval", () => snap?.tasks.find(t => t.id === pendingAccepted.taskId && t.status === "awaiting-approval"));
  serverProc.kill();
  await new Promise<void>(resolve => serverProc.once("exit", () => resolve()));
  ws.close();
  serverProc = start("server", here, serverEnv);
  const ws2 = await connect();
  let restartSnap: Snapshot | null = null;
  const restartEvents: ServerMessage[] = [];
  ws2.on("message", raw => {
    const message = JSON.parse(String(raw)) as ServerMessage;
    if (message.type === "snapshot") restartSnap = message.snapshot;
    else restartEvents.push(message);
  });
  ws2.send(JSON.stringify({ type: "hello", deviceId: "e2e-restart", mode: "handheld", client: "device", protocol: PROTOCOL_VERSION } satisfies DeviceMessage));
  await until("saved state after restart", () => restartSnap?.tasks.find(t => t.id === pendingAccepted.taskId && t.status === "paused"));
  if (restartSnap!.appAgents.todo.length !== 1 || restartSnap!.appAgents.todo[0] !== newAppAgent.agentId || restartSnap!.agents.some(agent => agent.id === todoOwner))
    fail("deleted default app agent returned after restart");
  if (!restartSnap!.messages.some(m => m.id === "voice-main-e2e")) fail("main voice message was lost after restart");
  if (!restartSnap!.messages.some(m => m.id === "voice-restart-e2e")) fail("pending voice message was lost after restart");
  ws2.send(JSON.stringify({ type: "voice.message", requestId: "voice-main-e2e", text: "Send pitch deck to Jonas", target: { kind: "main" } } satisfies DeviceMessage));
  await until("repeat voice receipt", () => restartEvents.find(e => e.type === "voice.accepted" && e.streamId === "voice-main-e2e"));
  await until("same task count", () => restartSnap?.tasks.length === snap?.tasks.length);
  console.log("✓ Restart: messages stayed, waiting work paused, repeated voice made no second Task");

  // The setup page resets Notes and To-Dos in one press and keeps everything else.
  const agentsBefore = restartSnap!.agents.length;
  const reset = await fetch(`http://127.0.0.1:${PORT}/setup`, { method: "POST", body: new URLSearchParams({ action: "resetNotesTodos" }) });
  if (!reset.ok || !(await reset.text()).includes("Cleared")) fail("setup reset did not answer");
  await until("Notes and To-Dos cleared", () => restartSnap?.notes.length === 0 && restartSnap.tasks.length === 0);
  if (restartSnap!.agents.length !== agentsBefore || restartSnap!.messages.length || restartSnap!.approvals.length) fail("reset touched agents or left messages or approvals");
  console.log("✓ Setup page reset cleared Notes and To-Dos and kept agents");

  ws2.close();
  serverProc.kill();
  pc.kill();
  await Promise.all([once(serverProc, "exit"), once(pc, "exit")]);
  await modelFlow(here, pcEnv, serverEnv);
  cleanup();
  console.log(`\nAll good. ${RUNS} run${RUNS > 1 ? "s" : ""} of the demo flow passed.`);
  process.exit(0);
}

async function modelFlow(here: string, pcEnv: Record<string, string>, serverEnv: Record<string, string>) {
  const token = "test-device-access-token-123";
  const pcToken = "test-private-pc-token-123";
  const modelData = path.join(root, "model-data");
  const existingTodo = { id: "move-fixture", title: "Review the hardware drawings", status: "todo", target: "todo", agentId: null, steps: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } satisfies Task;
  const assignedWork = { ...existingTodo, id: "assigned-fixture", title: "Move Review the hardware drawings to the Pitch deck project for 18 Dec 2026 at 14:30" };
  fs.mkdirSync(modelData);
  fs.writeFileSync(path.join(modelData, "state.json"), JSON.stringify({ tasks: [existingTodo, assignedWork] }));
  const filename = path.join(root, "model-result.txt");
  const command = process.platform === "win32"
    ? "Set-Content -LiteralPath 'model-result.txt' -Value 'tool worked'; Get-Content -LiteralPath 'model-result.txt'"
    : "printf 'tool worked\\n' > model-result.txt && cat model-result.txt";
  const calls: { messages: unknown[]; tools: { name: string }[]; system: string }[] = [];
  const today = new Date().toLocaleDateString("sv-SE");
  const tool = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", id: `toolu_${calls.length}`, name, input });
  const reply = (text: string) => ({ type: "text", text });
  const provider = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    calls.push(JSON.parse(raw));
    // Dumps in Notes and To-Do ask two short questions in parallel (ADR 0031). Answer those by prompt,
    // and script only the agent turns, in order.
    const system = String(calls.at(-1)!.system ?? "");
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", role: "assistant", content: [reply(JSON.stringify(value))], stop_reason: "end_turn" }));
    };
    if (system.includes("Decide what their words are")) return json({ intent: "command" });
    if (system.includes("Decide where it goes")) return json({ action: "new", noteId: "", text: "Unused.", why: "Unused" });
    if (system.includes("Decide the action")) return json({ action: "add", title: "Unused", day: "", time: "", clearDate: false, projectId: "", agentId: "", complete: false, why: "Unused" });
    const turn = calls.filter(call => !/Decide (what their words are|where it goes|the action)/.test(String(call.system ?? ""))).length;
    const turns = [
      () => tool("notes_create", { texts: ["Weekly Summary"], say: "Save the title in Notes" }),
      () => reply("I saved Weekly Summary in Notes."),
      () => tool("run_shell", { command, cwd: root, machine: "Test laptop", say: "Write and verify the result" }),
      () => reply("I wrote and verified model-result.txt."),
      () => tool("read_app", { app: "todo", say: "Look up the To-Do and project" }),
      () => {
        const messages = calls.at(-1)!.messages as { content: unknown }[];
        const [result] = messages.at(-1)!.content as { content: string }[];
        const data = JSON.parse(result.content) as { projects: { id: string; name: string }[]; tasks: { id: string; title: string }[] };
        return tool("todo_update", {
          ids: [data.tasks.find(task => task.title === existingTodo.title)?.id],
          projectId: data.projects.find(project => project.name === "Pitch deck")?.id, due: "2026-12-18T14:30", say: "Move and reschedule the To-Do",
        });
      },
      () => reply("I moved the To-Do to Pitch deck for December 18."),
      () => tool("focus_start", { minutes: 12, say: "Start a twelve-minute Focus timer" }),
      () => reply("I started a twelve-minute Focus timer."),
      () => tool("read_app", { app: "notes", say: "Find Weekly Summary" }),
      () => {
        const messages = calls.at(-1)!.messages as { content: unknown }[];
        const [result] = messages.at(-1)!.content as { content: string }[];
        const { notes } = JSON.parse(result.content) as { notes: { id: string; text: string }[] };
        return tool("notes_replace", {
          id: notes.find(note => note.text === "Weekly Summary")?.id,
          text: "Weekly Build Summary", say: "Replace the Note text",
        });
      },
      () => reply("I updated the Note to Weekly Build Summary."),
      // ADR 0031: "Delete all the notes" spoken in Notes is a command for the Notes agent.
      () => tool("read_app", { app: "notes", say: "Read every Note" }),
      () => {
        const messages = calls.at(-1)!.messages as { content: unknown }[];
        const [result] = messages.at(-1)!.content as { content: string }[];
        const { notes } = JSON.parse(result.content) as { notes: { id: string }[] };
        return tool("notes_delete", { ids: notes.map(note => note.id), say: "Delete all Notes" });
      },
      () => reply("I deleted your Note."),
      // "Move this one to today" spoken in To-Do acts on the selected To-Do.
      () => tool("todo_update", { ids: [existingTodo.id], due: today, projectId: null, say: "Move it to today in Inbox" }),
      () => reply("I moved it to today."),
    ];
    const content = turns[turn - 1]?.() ?? reply("Unexpected model request.");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ type: "message", role: "assistant", content: [content], stop_reason: content.type === "tool_use" ? "tool_use" : "end_turn" }));
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Mock model server didn't start.");
  try {
    start("model-pc", path.join(here, "../pc-agent"), { ...pcEnv, PC_AGENT_TOKEN: pcToken, PC_AGENT_ALLOW_SHELL: "1" });
    start("model-server", here, {
      ...serverEnv,
      DATA_DIR: modelData,
      PC_AGENT_TOKEN: pcToken,
      DEVICE_ACCESS_TOKEN: token,
      DEMO_PLANNER: "0",
      ANTHROPIC_API_KEY: "local-test-key",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
      // The mock speaks the Messages API to the built-in loop. scripts/agent-e2e.ts tests the engine (ADR 0032).
      AGENT_ENGINE: "builtin",
    });
    const url = `ws://127.0.0.1:${PORT}/ws`;
    let snapshot: Snapshot | undefined;
    const socket = await connect(["flip-device", `auth.${token}`], raw => {
      const message = JSON.parse(String(raw)) as ServerMessage;
      if (message.type === "snapshot") snapshot = message.snapshot;
    });
    try {
      if (socket.protocol !== "flip-device") throw new Error("The Device token was echoed as a negotiated protocol.");
      const listen = new WebSocket(url, ["flip-device", "auth.invalid"]);
      const [authError] = await once(listen, "error");
      if (!String(authError).includes("401")) throw new Error("Unauthenticated Device was not rejected.");

      const send = (message: DeviceMessage) => socket.send(JSON.stringify(message));
      const until = async (predicate: () => boolean) => {
        for (let i = 0; i < 120; i++) {
          if (predicate()) return;
          await sleep(50);
        }
        throw new Error("The model flow did not reach the expected state.");
      };
      const talk = (requestId: string, text: string) => send({ type: "voice.message", requestId, text, target: { kind: "main" } });
      send({ type: "hello", deviceId: "model-e2e", mode: "handheld", client: "device", protocol: PROTOCOL_VERSION });
      await until(() => !!snapshot?.machines.some(machine => machine.online && machine.actions?.includes("shell")));
      talk("model-first", "I'd like Weekly Summary in my Notes so I can come back to it.");
      await until(() => !!snapshot?.messages.some(message => message.replyToMessageId === "model-first"));
      if (!snapshot!.notes.some(note => note.text === "Weekly Summary")
        || !snapshot!.tasks.some(task => task.appRequest?.app === "notes" && task.agentId === snapshot!.appAgents.notes[0] && task.status === "done")
        || JSON.stringify(calls[0].messages).includes("Previous exchanges"))
        throw new Error("The Main agent didn't save a Note through its assigned agent on the first turn.");
      talk("model-follow-up", "Now write that one out and check it.");
      await until(() => !!snapshot?.approvals.length);
      const approval = snapshot!.approvals[0];
      if (approval.preview?.command !== command || !approval.body?.includes(root) || fs.existsSync(filename))
        throw new Error("The command ran early or the approval didn't show the command and folder.");
      if (!JSON.stringify(calls[2].messages).includes("Previous exchanges") || !JSON.stringify(calls[2].messages).includes("Weekly Summary") || !calls[2].tools.some(tool => tool.name === "run_shell"))
        throw new Error("The follow-up was missing conversation history or shell capability.");
      send({ type: "approval.press", requestId: approval.requestId, approved: true, via: "a-button" });
      await until(() => !!snapshot?.messages.some(message => message.replyToMessageId === "model-follow-up"));
      if (fs.readFileSync(filename, "utf8").trim() !== "tool worked" || !JSON.stringify(calls[3].messages).includes("tool worked"))
        throw new Error("The shell result didn't reach the model after approval.");
      console.log("✓ LLM follow-up received conversation context and verified an approved shell action outside the file roots");

      send({ type: "task.assign", taskId: assignedWork.id, agentId: snapshot!.appAgents.notes[0] });
      await until(() => !!snapshot?.tasks.some(task => task.id === assignedWork.id && task.status === "done"));
      const moved = snapshot!.tasks.find(task => task.id === existingTodo.id);
      const project = snapshot!.projects.find(item => item.name === "Pitch deck");
      if (!project || moved?.projectId !== project.id || moved?.due !== "2026-12-18T14:30"
        || snapshot!.tasks.filter(task => task.target === "todo" && task.title === existingTodo.title).length !== 1
        || !snapshot!.tasks.some(task => task.appRequest?.input.action === "todo.update" && task.agentId === snapshot!.appAgents.todo[0] && task.status === "done")
        || JSON.stringify(calls[4].messages).includes("Previous exchanges"))
        throw new Error("The Notes agent didn't move the existing To-Do through its owner from a saved Task with no conversation.");

      send({ type: "voice.message", requestId: "model-focus", text: "Give me twelve minutes of quiet work", target: { kind: "app", app: "focus" } });
      await until(() => !!snapshot?.messages.some(message => message.replyToMessageId === "model-focus"));
      if (!snapshot!.focus.running || snapshot!.focus.lengthMs !== 720_000
        || !snapshot!.messages.some(message => message.id === "model-focus" && message.toAgentId === snapshot!.appAgents.focus[0])
        || JSON.stringify(calls[7].messages).includes("Previous exchanges"))
        throw new Error("The Focus agent didn't start the timer on its first request.");
      console.log("✓ Main saved a Note, Notes moved a To-Do from an assigned Task, and Focus started a timer, all without prior conversation");

      const noteId = snapshot!.notes.find(note => note.text === "Weekly Summary")?.id;
      talk("model-note-edit", "Replace my Weekly Summary note with Weekly Build Summary.");
      await until(() => !!snapshot?.approvals.some(item => item.title === "Replace this Note's text?"));
      const replace = snapshot!.approvals.find(item => item.title === "Replace this Note's text?")!;
      if (replace.agentId !== snapshot!.appAgents.notes[0] || snapshot!.notes.find(note => note.id === noteId)?.text !== "Weekly Summary")
        throw new Error("The Note edit was applied before its assigned agent received approval.");
      send({ type: "approval.press", requestId: replace.requestId, approved: true, via: "a-button" });
      await until(() => !!snapshot?.messages.some(message => message.replyToMessageId === "model-note-edit"));
      if (snapshot!.notes.find(note => note.id === noteId)?.text !== "Weekly Build Summary" || snapshot!.notes.length !== 1)
        throw new Error("The approved edit did not update the original Note.");
      console.log("✓ Main found an existing Note and edited it in place through the Notes agent after approval");

      // ADR 0031: a command spoken in Notes goes to the Notes agent and is not saved as a Note.
      send({ type: "voice.scripted", streamId: "model-notes-cmd", text: "Hey, delete all the notes", durationMs: 2000, target: { kind: "auto", openNoteId: noteId ?? null } });
      await until(() => !!snapshot?.approvals.some(item => item.risk === "delete"));
      const del = snapshot!.approvals.find(item => item.risk === "delete")!;
      if (del.kind !== "risky" || del.agentId !== snapshot!.appAgents.notes[0] || snapshot!.notes.length !== 1 || snapshot!.notes.some(note => /delete/i.test(note.text)))
        throw new Error("The spoken delete was saved as a Note, skipped the push bar, or deleted early.");
      send({ type: "approval.press", requestId: del.requestId, approved: true, via: "push-bar" });
      await until(() => !!snapshot?.tasks.some(task => task.requestMessageId === "model-notes-cmd" && task.status === "done"));
      const delTask = snapshot!.tasks.find(task => task.requestMessageId === "model-notes-cmd")!;
      // The socket handler replaces snapshot, so read it again instead of trusting the narrowed type.
      const notesLeft = () => snapshot!.notes.length;
      if (notesLeft() !== 0 || !isAppCommand(delTask) || delTask.detail !== "I deleted your Note.")
        throw new Error("The Notes agent didn't delete the Notes or answer.");
      console.log("✓ \"Delete all the notes\" in Notes went to the Notes agent, took the push bar, and saved no Note");

      // A command in To-Do reaches the To-Do agent with the selected To-Do, and makes no new To-Do.
      const todoCount = snapshot!.tasks.filter(task => !isAppCommand(task)).length;
      send({ type: "voice.scripted", streamId: "model-todo-cmd", text: "Move this one to today and take it out of the project", durationMs: 2000, target: { kind: "task", listId: "inbox", taskId: existingTodo.id } });
      await until(() => !!snapshot?.tasks.some(task => task.requestMessageId === "model-todo-cmd" && task.status === "done"));
      const movedToday = snapshot!.tasks.find(task => task.id === existingTodo.id);
      if (movedToday?.due !== today || movedToday.projectId || snapshot!.tasks.filter(task => !isAppCommand(task)).length !== todoCount
        || !calls.some(call => JSON.stringify(call.messages).includes(`The selected To-Do is ${existingTodo.id}`)))
        throw new Error("The To-Do agent didn't move the selected To-Do, or the command became a To-Do.");
      console.log("✓ A command in To-Do moved the selected To-Do through the To-Do agent and added no To-Do");
    } finally {
      socket.close();
    }
  } finally {
    provider.close();
  }
}

process.on("SIGINT", () => { cleanup(); process.exit(1); });
main().catch(err => fail(String(err?.stack || err)));
