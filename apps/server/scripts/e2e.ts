// End-to-end check of the demo flow, no browser needed:
//   dump -> note -> suggestions -> accept -> PC agent works -> approval press -> done.
// Spawns a real server and a real PC agent against a throwaway home folder.
//   pnpm test:e2e            (add RUNS=20 to run the flow 20 times in a row)
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import type { DeviceMessage, ServerMessage, Snapshot } from "@app/protocol";

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

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      await new Promise((res, rej) => { ws.once("open", res); ws.once("error", rej); });
      return ws;
    } catch { await sleep(250); }
  }
  fail("server didn't start");
}

async function main() {
  seed();
  const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const pcEnv = { HOME: home, PC_AGENT_PORT: String(PC_PORT), PC_AGENT_HOST: "127.0.0.1", PC_AGENT_TOKEN: "e2e", PC_AGENT_NAME: "Test laptop" };
  let pc = start("pc", path.join(here, "../pc-agent"), pcEnv);
  start("server", here, { PORT: String(PORT), DATA_DIR: path.join(root, "data"), PC_AGENTS: `Test laptop=ws://127.0.0.1:${PC_PORT}`, PC_AGENT_TOKEN: "e2e", ANTHROPIC_API_KEY: process.env.E2E_CLAUDE ? process.env.ANTHROPIC_API_KEY ?? "" : "", STT_API_KEY: "" });

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

  sendMsg({ type: "hello", deviceId: "e2e", mode: "handheld", client: "device", protocol: 2 });
  await until("PC agent online", () => snap?.machines.some(m => m.online));
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

  ws.close();
  cleanup();
  console.log(`\nAll good. ${RUNS} run${RUNS > 1 ? "s" : ""} of the demo flow passed.`);
  process.exit(0);
}

process.on("SIGINT", () => { cleanup(); process.exit(1); });
main().catch(err => fail(String(err?.stack || err)));
