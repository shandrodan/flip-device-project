// The VM's screen and resource use, for the twin on the laptop (ADR 0024). No dependencies.
//   GET  /         a monitor page: the live screen and what each service uses
//   GET  /stream   the kiosk browser's screen as MJPEG (an <img> can show it)
//   POST /key      {code, type: "down" | "up" | "press"}: a Device control, as the keyboard sends it
//   POST /mic      raw audio from the laptop's mic (s16le, 48 kHz, mono), while the mic is held
//   GET  /metrics  RAM, CPU and per-service use, from the kernel and each service's cgroup
// It talks to the kiosk Chromium over the DevTools protocol on 127.0.0.1:9222, and feeds the mic
// audio into PulseAudio's pipe source, which the kiosk records like any microphone.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";

const PORT = Number(process.env.RELAY_PORT || 7900);
const CDP = process.env.CDP_URL || "http://127.0.0.1:9222";
const MIC = process.env.MIC_FIFO || "/run/flip-audio/mic.fifo";
const UNITS = ["flip-server", "flip-device", "flip-display", "flip-kiosk", "flip-audio", "flip-relay"];

/* ------------------------------ Screen ------------------------------ */
let frame = null; // last JPEG
const viewers = new Set();
let cdp = null, seq = 0;
const pending = new Map();

function call(method, params = {}) {
  if (!cdp || cdp.readyState !== 1) return Promise.resolve(null);
  const id = ++seq;
  cdp.send(JSON.stringify({ id, method, params }));
  return new Promise(r => { pending.set(id, r); setTimeout(() => pending.delete(id) && r(null), 3000); });
}

async function connect() {
  try {
    const pages = await (await fetch(`${CDP}/json`)).json();
    const page = pages.find(p => p.type === "page");
    if (!page) throw new Error("no page yet");
    cdp = new WebSocket(page.webSocketDebuggerUrl);
    cdp.onopen = async () => {
      await call("Emulation.setFocusEmulationEnabled", { enabled: true });
      // The Device's panel size, whatever the browser window around it.
      await call("Emulation.setDeviceMetricsOverride", { width: 784, height: 504, deviceScaleFactor: 1, mobile: false });
      await call("Page.startScreencast", { format: "jpeg", quality: 85, maxWidth: 784, maxHeight: 504 });
      console.log("screen: streaming");
    };
    cdp.onmessage = ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
      if (m.method === "Page.screencastFrame") {
        call("Page.screencastFrameAck", { sessionId: m.params.sessionId });
        frame = Buffer.from(m.params.data, "base64");
        for (const v of viewers) push(v);
      }
    };
    cdp.onclose = () => { console.log("screen: kiosk gone, reconnecting"); cdp = null; setTimeout(connect, 1000); };
    cdp.onerror = () => {};
  } catch {
    setTimeout(connect, 1000); // the kiosk is still starting, or restarting
  }
}
connect();

function push(res) {
  if (!frame) return;
  res.write(`--f\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`);
  res.write(frame);
  res.write("\r\n");
}

// Only the keys the Device's keymap uses (apps/device/src/input/controls.ts).
const KEYS = {
  Enter: ["Enter", 13], Space: [" ", 32], Escape: ["Escape", 27], Backspace: ["Backspace", 8],
  ArrowUp: ["ArrowUp", 38], ArrowDown: ["ArrowDown", 40], ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39],
};
for (const c of "KLIJQEWSD") KEYS[`Key${c}`] = [c.toLowerCase(), c.charCodeAt(0)];

async function key(code, type) {
  const k = KEYS[code];
  if (!k || !cdp || cdp.readyState !== 1) return false;
  const ev = t => call("Input.dispatchKeyEvent", { type: t, code, key: k[0], windowsVirtualKeyCode: k[1] });
  if (code === "Space" && type === "down") micOpen();
  if (code === "Space" && type === "up") await micDrained(); // the last words reach the kiosk first
  if (type !== "up") await ev("keyDown");
  if (type !== "down") await ev("keyUp");
  return true;
}

/* ------------------------------ Mic ------------------------------ */
// The kiosk starts recording a moment after the mic goes down, so the laptop's audio waits
// PREROLL ms before it plays into the pipe: nothing said right after the press is lost.
// A steady 48 kHz clock writes the queue, or silence, so the source never starves.
const RATE = 48000, PREROLL = 350;
let fifo = null, queue = [], talking = false, playFrom = 0;
function openFifo() {
  try { fifo = fs.openSync(MIC, fs.constants.O_RDWR | fs.constants.O_NONBLOCK); console.log("mic: ready"); }
  catch { setTimeout(openFifo, 1000); } // PulseAudio creates it
}
openFifo();
function micOpen() { queue = []; talking = true; playFrom = Date.now() + PREROLL; }
async function micDrained() {
  const until = Date.now() + 8000;
  await new Promise(r => setTimeout(r, 150)); // the laptop's last chunk is in flight
  while ((queue.length || Date.now() < playFrom) && Date.now() < until) await new Promise(r => setTimeout(r, 20));
  await new Promise(r => setTimeout(r, 120)); // and through PulseAudio
  talking = false;
}
let clock = Date.now(), written = 0;
setInterval(() => {
  const due = Math.floor(((Date.now() - clock) * RATE) / 1000) - written;
  if (due <= 0) return;
  if (due > RATE) { written += due; return; } // the process stalled: skip ahead, don't burst
  const out = Buffer.alloc(due * 2);
  let at = 0;
  while (Date.now() >= playFrom && queue.length && at < out.length) {
    const n = queue[0].copy(out, at);
    at += n;
    queue[0] = queue[0].subarray(n);
    if (!queue[0].length) queue.shift();
  }
  written += due;
  if (fifo !== null) try { fs.writeSync(fifo, out); } catch { /* full or no reader: drop */ }
}, 20);

/* ------------------------------ Resources ------------------------------ */
const read = f => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const meminfo = () => Object.fromEntries(read("/proc/meminfo").split("\n").filter(Boolean)
  .map(l => { const [k, v] = l.split(":"); return [k, parseInt(v) * 1024]; }));
const cpuTotals = () => { const n = read("/proc/stat").split("\n")[0].split(/\s+/).slice(1).map(Number); return { idle: n[3] + n[4], all: n.reduce((a, b) => a + b, 0) }; };
const cg = u => `/sys/fs/cgroup/system.slice/${u}.service`;
const usage = u => Number((read(`${cg(u)}/cpu.stat`).match(/usage_usec (\d+)/) || [])[1] || 0);

let last = { t: Date.now(), cpu: cpuTotals(), units: Object.fromEntries(UNITS.map(u => [u, usage(u)])) };
let latest = null;
const history = [];
function sample() {
  const t = Date.now(), cpu = cpuTotals(), m = meminfo();
  const dt = (t - last.t) * 1000, cores = os.cpus().length;
  const units = {};
  for (const u of UNITS) {
    const us = usage(u);
    units[u] = { memMB: Math.round(Number(read(`${cg(u)}/memory.current`) || 0) / 1048576), cpuPct: dt ? +(((us - last.units[u]) / dt) * 100).toFixed(1) : 0 };
    last.units[u] = us;
  }
  const busy = 1 - (cpu.idle - last.cpu.idle) / Math.max(1, cpu.all - last.cpu.all);
  latest = {
    t, cores,
    memTotalMB: Math.round(m.MemTotal / 1048576),
    memUsedMB: Math.round((m.MemTotal - m.MemAvailable) / 1048576),
    swapMB: Math.round((m.SwapTotal - m.SwapFree) / 1048576),
    cpuPct: +(busy * 100).toFixed(1), // of all cores
    load: os.loadavg()[0],
    units,
  };
  last = { t, cpu, units: last.units };
  history.push({ t, mem: latest.memUsedMB, cpu: latest.cpuPct });
  if (history.length > 600) history.shift();
}
setInterval(sample, 1000);
sample();

/* ------------------------------ HTTP ------------------------------ */
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "cache-control": "no-store" };
http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://x");
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  if (url.pathname === "/stream") {
    res.writeHead(200, { ...cors, "content-type": "multipart/x-mixed-replace; boundary=f", connection: "close" });
    viewers.add(res);
    push(res);
    req.on("close", () => viewers.delete(res));
    return;
  }
  if (url.pathname === "/key" && req.method === "POST") {
    let body = "";
    for await (const c of req) body += c;
    const { code, type = "press" } = JSON.parse(body || "{}");
    const ok = await key(code, type);
    return res.writeHead(ok ? 204 : 400, cors).end();
  }
  if (url.pathname === "/mic" && req.method === "POST") {
    const parts = [];
    for await (const c of req) parts.push(c);
    let pcm = Buffer.concat(parts);
    if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1);
    if (talking && pcm.length) queue.push(pcm);
    return res.writeHead(204, cors).end();
  }
  if (url.pathname === "/metrics") {
    return res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ ...latest, history: url.searchParams.has("history") ? history : undefined }));
  }
  if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  res.writeHead(404, cors).end();
}).listen(PORT, "127.0.0.1", () => console.log(`relay on 127.0.0.1:${PORT}`));

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Board monitor</title>
<style>
:root{color-scheme:dark;--bg:#0b0b0c;--fg:#f5f5f7;--dim:#8e8e93;--line:#2c2c2e;--ok:#30d158;--warn:#ff9f0a}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif;display:grid;gap:20px;justify-items:center}
img{width:min(784px,100%);aspect-ratio:784/504;background:#000;border-radius:12px;display:block}
.box{width:min(784px,100%)}
h1{font-size:15px;margin:0 0 4px} p{margin:0;color:var(--dim)}
.big{display:flex;gap:28px;margin:14px 0}.big b{display:block;font-size:28px;font-variant-numeric:tabular-nums}
.bar{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin-top:6px}.bar i{display:block;height:100%;background:var(--ok)}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:6px 0;border-bottom:1px solid var(--line);text-align:right}td:first-child,th:first-child{text-align:left}th{color:var(--dim);font-weight:500}
</style>
<img src="/stream" alt="The Device screen, rendered on the VM">
<div class="box">
  <h1>Pi 5-class VM: arm64, 4 cores, 2 GB RAM, no swap</h1>
  <p>Proves the Device software fits the memory of a Pi 5 2 GB. Not Pi CPU speed: these cores are faster.</p>
  <div class="big"><div><span>RAM used</span><b id="mem">…</b><div class="bar"><i id="membar"></i></div></div><div><span>CPU (all cores)</span><b id="cpu">…</b></div><div><span>Load</span><b id="load">…</b></div></div>
  <table><thead><tr><th>Service</th><th>RAM</th><th>CPU (1 core = 100%)</th></tr></thead><tbody id="rows"></tbody></table>
</div>
<script>
const names={"flip-server":"Server (agents, voice)","flip-device":"Device app server","flip-display":"Screen framebuffer","flip-kiosk":"Kiosk browser","flip-audio":"Microphone (PulseAudio)","flip-relay":"Screen and mic relay"};
async function tick(){try{const m=await (await fetch("/metrics")).json();
mem.textContent=m.memUsedMB+" / "+m.memTotalMB+" MB";membar.style.width=(100*m.memUsedMB/m.memTotalMB)+"%";membar.style.background=m.memUsedMB/m.memTotalMB>.8?"var(--warn)":"var(--ok)";
cpu.textContent=m.cpuPct+"%";load.textContent=m.load.toFixed(2);
rows.innerHTML=Object.entries(m.units).map(([k,u])=>"<tr><td>"+(names[k]||k)+"</td><td>"+u.memMB+" MB</td><td>"+u.cpuPct+"%</td></tr>").join("");}catch{}}
setInterval(tick,1000);tick();
</script>`;
