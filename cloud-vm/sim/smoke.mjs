// Smoke test of the cloud architecture (ADR 0033). Everything goes through the 2 GB device box on
// :5173, exactly like the kiosk on the Device VM: the Device UI in a real browser, agent requests over
// its /ws, and the Build preview through its /preview/ in a frame sandboxed like the Device's.
//   node cloud-vm/sim/smoke.mjs            (run.sh starts the boxes first)
//   DEVICE=http://localhost:15173 node cloud-vm/sim/smoke.mjs   (against the real VMs through pi-vm/tunnel.sh)
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const DEVICE = (process.env.DEVICE || "http://127.0.0.1:5173").replace(/\/$/, "");
const OUT = path.join(path.dirname(new URL(import.meta.url).pathname), "out");
const VITE = process.env.VITE !== "0";
fs.mkdirSync(OUT, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failed = 0;
const pass = (name, extra = "") => console.log(`✓ ${name}${extra ? `  ${extra}` : ""}`);
const fail = (name, why) => { failed++; console.log(`✕ ${name}\n    ${why}`); };

/* ----------------------------- Device protocol ----------------------------- */
let snap = null;
const ws = new WebSocket(`${DEVICE.replace(/^http/, "ws")}/ws`, ["flip-device"]);
ws.addEventListener("message", e => { const m = JSON.parse(String(e.data)); if (m.type === "snapshot") snap = m.snapshot; });
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", () => rej(new Error(`no WebSocket at ${DEVICE}/ws`))); });
const send = m => ws.send(JSON.stringify(m));
const PROTOCOL = Number(fs.readFileSync(new URL("../../packages/protocol/src/index.ts", import.meta.url), "utf8").match(/PROTOCOL_VERSION = (\d+)/)?.[1] ?? 0);
send({ type: "hello", deviceId: "smoke", mode: "handheld", client: "device", protocol: PROTOCOL });

async function until(fn, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await sleep(200); }
  return null;
}
async function ask(target, text, ms = 300_000) {
  const requestId = `smoke_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const t0 = Date.now();
  send({ type: "voice.message", requestId, target, text });
  const pressed = new Set();
  const task = await until(() => {
    for (const a of snap?.approvals ?? []) if (!pressed.has(a.requestId)) { pressed.add(a.requestId); send({ type: "approval.press", requestId: a.requestId, approved: true, via: "push-bar" }); }
    const t = snap?.tasks.find(x => x.requestMessageId === requestId);
    return t && ["done", "failed", "todo", "paused"].includes(t.status) ? t : null;
  }, ms);
  return { task, seconds: Math.round((Date.now() - t0) / 1000), presses: pressed.size };
}

/* ---------------------------------- Run ---------------------------------- */
const health = await fetch(`${DEVICE}/health`).then(r => r.json()).catch(e => ({ error: String(e) }));
if (health.ok) pass("cloud reachable through the device box", `llm=${health.llm}`); else fail("cloud reachable through the device box", JSON.stringify(health));
await until(() => snap, 10_000);
send({ type: "settings.update", patch: { permissionMode: "auto" } });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 784, height: 504 } });
let frames = 0;
page.on("websocket", socket => socket.on("framereceived", f => { if (String(f.payload).includes("\"snapshot\"")) frames++; }));
await page.goto(`${DEVICE}/?kiosk=1`);
await until(() => frames > 0, 15_000);
await page.screenshot({ path: path.join(OUT, "device-home.png") });
frames > 0 ? pass("Device UI loads on the device box and gets live state from the cloud", "out/device-home.png") : fail("Device UI connects", "no snapshot reached the page");

{
  const r = await ask({ kind: "main" }, "Create three notes with the texts Cloud 1, Cloud 2 and Cloud 3. Then delete Cloud 2.");
  const texts = (snap?.notes ?? []).map(n => n.text.trim());
  const ok = r.task?.status === "done" && texts.includes("Cloud 1") && texts.includes("Cloud 3") && !texts.includes("Cloud 2");
  ok ? pass("Omni: create three notes, delete the second", `${r.seconds}s, ${r.presses} press`) : fail("Omni notes", `${r.task?.status}: ${r.task?.detail} · notes ${JSON.stringify(texts.slice(0, 6))}`);
}

{
  const r = await ask({ kind: "app", app: "build" }, "Make the Build project a one-page site called Flip Cloud, with a big button that counts clicks.");
  r.task?.status === "done" ? pass("Build: static site written on the cloud", `${r.seconds}s`) : fail("Build static", `${r.task?.status}: ${r.task?.detail}`);
}

async function previewShows(word, file) {
  // The Device's frame: sandbox="allow-scripts allow-forms", so the page runs with an opaque origin.
  await page.setContent(`<iframe id="p" sandbox="allow-scripts allow-forms" style="width:760px;height:480px;border:0" src="${DEVICE}/preview/"></iframe>`);
  const frame = await (await page.waitForSelector("#p")).contentFrame();
  const seen = await (async () => {
    for (let i = 0; i < 40; i++) {
      const text = await frame.evaluate(() => document.body?.innerText || "").catch(() => "");
      if (text.includes(word)) return text;
      await sleep(500);
    }
    return null;
  })();
  await page.screenshot({ path: path.join(OUT, file) });
  if (!seen) return { ok: false, why: "text never appeared" };
  const button = await frame.$("button");
  if (!button) return { ok: true, clicked: false };
  const before = await button.innerText();
  await button.click();
  await sleep(300);
  return { ok: true, clicked: (await button.innerText()) !== before || (await frame.evaluate(() => document.body.innerText)) !== seen };
}

{
  const r = await previewShows("Flip Cloud", "preview-static.png");
  r.ok ? pass("Preview through the device box, sandboxed like the Device", `button works: ${r.clicked} · out/preview-static.png`) : fail("Static preview", r.why);
}

if (VITE) {
  const r = await ask({ kind: "app", app: "build" }, "Turn the Build project into a Vite + React app. Keep the Flip Cloud title and the counter button. Install it and run its dev server so I see it in the preview.", 600_000);
  if (r.task?.status !== "done") fail("Build: Vite + React dev server", `${r.task?.status}: ${r.task?.detail}`);
  else {
    const p = await previewShows("Flip Cloud", "preview-vite.png");
    const client = await fetch(`${DEVICE}/preview/@vite/client`).then(x => x.status).catch(() => 0);
    p.ok && client === 200 ? pass("Build: Vite + React dev server streamed from the cloud's localhost", `${r.seconds}s, React renders, button works: ${p.clicked} · out/preview-vite.png`) : fail("Vite preview", `${p.why ?? ""} vite client ${client}`);
  }
}

await browser.close();
ws.close();

try {
  const stats = execSync(`docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.MemPerc}}'`).toString().trim().split("\n").filter(l => /cloud|device/.test(l));
  console.log("\nMemory:");
  for (const line of stats) console.log(`  ${line}`);
} catch { /* not on Docker */ }

console.log(failed ? `\n${failed} failed` : "\nAll passed");
process.exit(failed ? 1 : 0);
