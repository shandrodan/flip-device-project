// The Build project on the server machine (BUILD_HOST=server, ADR 0033).
// On the cloud VM the agent edits the project here, runs commands here, and starts the project's dev
// server here. The Device previews it through /preview/ on this server, so nothing else is exposed.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { save, state } from "./store.js";

export const localBuild = () => config.buildHost === "server";

/** The project folder as an absolute path on this machine. Created with a starter page. */
export function projectDir(): string {
  const dir = path.resolve(state.build.dir.replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.html"), `<!doctype html>\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${state.build.name}</title>\n<h1>${state.build.name}</h1>\n<p>Ask the Build agent to make something.</p>\n`);
  }
  return dir;
}

/** An absolute path inside the project, or null when it would leave it. */
export function insideProject(target: string): string | null {
  const root = projectDir();
  const full = path.resolve(root, target.replace(/^~(?=\/|$)/, os.homedir()));
  return full === root || full.startsWith(root + path.sep) ? full : null;
}

/** Run a command in the project folder. Output is cut to the last 15 KB. */
export function runInProject(command: string, timeoutMs = 180_000): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    const child = spawn("bash", ["-lc", command], { cwd: projectDir(), env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, detached: true });
    let output = "";
    const add = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-15000); };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* gone */ }
      output += `\n[stopped after ${Math.round(timeoutMs / 1000)} s. Long-running servers go through build_serve.]`;
    }, timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: `${output.trim() || "(no output)"}\n[exit ${code}]` });
    });
    child.on("error", err => { clearTimeout(timer); resolve({ ok: false, output: err.message }); });
  });
}

/* ------------------------------- Dev server ------------------------------- */

let dev: { child: ChildProcess; port: number; command: string; log: string } | null = null;
/** Characters the dev server has written since the server started, to find what is new (P1.7). */
let logTotal = 0;
export const devLogMark = () => logTotal;
/** What the dev server wrote after `mark` (as much as is still kept). */
export function devLogSince(mark: number): string {
  if (!dev) return "";
  const fresh = logTotal - mark;
  return fresh <= 0 ? "" : dev.log.slice(-Math.min(fresh, dev.log.length));
}

export function devServer() {
  return dev ? { port: dev.port, command: dev.command, running: dev.child.exitCode === null } : null;
}

export function devLog() {
  return dev?.log.trim() || "No dev server has run yet.";
}

function portOpen(port: number) {
  return new Promise<boolean>(resolve => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

export function stopDev() {
  if (dev?.child.exitCode === null) {
    try { process.kill(-dev.child.pid!, "SIGTERM"); } catch { /* gone */ }
  }
  dev = null;
  state.buildServer = null;
  save();
}

/** Start the project's dev server and wait until it answers on its port. */
export async function startDev(command: string, port: number): Promise<{ ok: boolean; output: string }> {
  stopDev();
  if (await portOpen(port)) return { ok: false, output: `Port ${port} is already in use. Pick another port.` };
  const child = spawn("bash", ["-lc", command], { cwd: projectDir(), env: { ...process.env, PORT: String(port), BROWSER: "none", FORCE_COLOR: "0" }, detached: true });
  const current = { child, port, command, log: "" };
  dev = current;
  const add = (chunk: Buffer) => { const text = chunk.toString(); logTotal += text.length; current.log = (current.log + text).slice(-8000); };
  child.stdout!.on("data", add);
  child.stderr!.on("data", add);
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null) break;
    if (await portOpen(port)) {
      state.buildServer = { command, port };
      save();
      return { ok: true, output: `Dev server is up on port ${port}. The Device preview shows it.\n${current.log.slice(-1500)}` };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  const log = current.log.slice(-3000);
  stopDev();
  return { ok: false, output: `The dev server did not open port ${port}.\n${log}` };
}

/** After a restart, bring back the dev server the agent started. */
export function restoreDev() {
  if (!localBuild() || !state.buildServer) return;
  const { command, port } = state.buildServer;
  startDev(command, port).then(r => console.log(`[build] ${r.ok ? `dev server back on ${port}` : `dev server did not come back: ${r.output.split("\n")[0]}`}`));
}

process.once("exit", () => {
  if (dev?.child.exitCode === null) try { process.kill(-dev.child.pid!, "SIGTERM"); } catch { /* gone */ }
});
