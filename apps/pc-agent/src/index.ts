// PC agent: the small program on the user's laptop. The server reaches it over Tailscale
// (ADR 0006) and asks it to run one of a short list of actions (ADR 0008). Every path must
// passed to file tools must sit inside an allowed root. The trash tool moves files to ~/.flip-trash.
//
//   PC_AGENT_TOKEN=... pnpm --filter pc-agent dev
//
// Env / flags:
//   PC_AGENT_PORT   (7077)
//   PC_AGENT_HOST   where to listen. Defaults to loopback with the dev token or shell enabled.
//                   For a remote PC agent, use its Tailscale IP (100.x.y.z).
//   PC_AGENT_TOKEN  shared secret, must match the server's PC_AGENT_TOKEN
//   PC_AGENT_NAME   shown on the Device (defaults to the hostname)
//   PC_AGENT_ROOTS  comma list of folders it may touch (defaults below)
//   --allow-shell   enables the "shell" action (always needs an approval press unless Full mode)

import { WebSocketServer, WebSocket } from "ws";
import os from "node:os";
import fs from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, exec, execFile } from "node:child_process";
import type { CodingTool, FsEntry, PcAction, PcAgentCommand, PcAgentResult, PcCodingSession } from "@app/protocol";

const HOME = os.homedir();
const PORT = Number(process.env.PC_AGENT_PORT || 7077);
const TOKEN = process.env.PC_AGENT_TOKEN || "dev-token";
const ALLOW_SHELL = process.argv.includes("--allow-shell") || process.env.PC_AGENT_ALLOW_SHELL === "1";
if (ALLOW_SHELL && (TOKEN === "dev-token" || TOKEN.length < 24))
  throw new Error("Shell access requires a private PC_AGENT_TOKEN of at least 24 characters.");
// Never expose the default token beyond this machine.
const HOST = TOKEN === "dev-token" ? "127.0.0.1" : process.env.PC_AGENT_HOST || (ALLOW_SHELL ? "127.0.0.1" : "0.0.0.0");
const NAME = process.env.PC_AGENT_NAME || prettyHost();
const ALLOW_OPEN = process.env.PC_AGENT_ALLOW_OPEN !== "0";
const TRASH = path.join(HOME, ".flip-trash");
const WORKSPACE = path.join(HOME, "Flip");

const ROOTS = (process.env.PC_AGENT_ROOTS
  ? process.env.PC_AGENT_ROOTS.split(",")
  : ["~/Desktop", "~/Documents", "~/Downloads", "~/Pictures", "~/Flip"]
)
  .map(r => expand(r.trim()))
  .filter(Boolean);

mkdirSync(WORKSPACE, { recursive: true });
const ACTIVE_ROOTS = ROOTS.filter(r => existsSync(r));
// Compare against resolved roots: on macOS /var is /private/var, and Desktop may be a symlink.
const REAL_ROOTS = ACTIVE_ROOTS.map(r => realpathSync(r));
const ACTIONS: PcAction[] = ["fs.list", "fs.read", "fs.write", "fs.mkdir", "fs.move", "fs.trash", "fs.duplicates", "notify", "claude.window"];
if (ALLOW_OPEN) ACTIONS.push("open");
if (ALLOW_SHELL) ACTIONS.push("shell");
const MACHINE_ID = crypto.createHash("sha1").update(os.hostname() + HOME).digest("hex").slice(0, 10);

/* ---------------------------------- Console ---------------------------------- */
// The projector shows this terminal, so keep it readable.
const c = { dim: "\x1b[2m", bold: "\x1b[1m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", reset: "\x1b[0m" };
const say = (icon: string, color: string, text: string) => console.log(`${c.dim}${new Date().toLocaleTimeString()}${c.reset} ${color}${icon}${c.reset} ${text}`);

function prettyHost() {
  const h = os.hostname().replace(/\.local$/, "");
  return h.length > 24 ? h.slice(0, 24) : h;
}

function expand(p: string) {
  if (!p) return "";
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return path.resolve(p);
}

const short = (p: string) => p === HOME ? "~" : p.startsWith(HOME + path.sep)
  ? "~/" + p.slice(HOME.length + 1).split(path.sep).join("/") : p;

/** Resolve a path and refuse anything outside the allowed roots (symlinks included). */
async function inRoots(p: unknown, { mustExist = true } = {}): Promise<string> {
  if (typeof p !== "string" || !p.trim()) throw new Error("A path is required");
  const abs = expand(p.trim());
  let real = abs;
  if (mustExist) real = await fs.realpath(abs);
  else {
    // For new files, check the nearest existing parent.
    let dir = path.dirname(abs);
    while (!existsSync(dir) && dir !== path.dirname(dir)) dir = path.dirname(dir);
    real = path.join(await fs.realpath(dir), path.relative(dir, abs));
  }
  const ok = REAL_ROOTS.some(r => real === r || real.startsWith(r + path.sep));
  if (!ok) throw new Error(`${short(abs)} is outside the folders this machine allows (${ACTIVE_ROOTS.map(short).join(", ")})`);
  return real;
}

async function freeName(dir: string, name: string) {
  const ext = path.extname(name), base = path.basename(name, ext);
  let candidate = path.join(dir, name), i = 2;
  while (existsSync(candidate)) candidate = path.join(dir, `${base} ${i++}${ext}`);
  return candidate;
}

/* ---------------------------------- Actions ---------------------------------- */

type Progress = (step: string) => void;
type Result = { output: string; data?: unknown };
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" ? [v] : []);

const actions: Record<PcAction, (args: Record<string, unknown>, progress: Progress) => Promise<Result>> = {
  async "fs.list"(args) {
    const dir = await inRoots(args.path);
    const limit = Math.min(Number(args.limit) || 400, 2000);
    const names = await fs.readdir(dir);
    const entries: FsEntry[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      try {
        const st = await fs.stat(path.join(dir, name));
        entries.push({ name, path: short(path.join(dir, name)), isDir: st.isDirectory(), size: st.size, mtime: st.mtime.toISOString() });
      } catch { /* vanished */ }
    }
    entries.sort((a, b) => b.mtime.localeCompare(a.mtime));
    const files = entries.filter(e => !e.isDir).length;
    return { output: `${short(dir)}: ${files} files, ${entries.length - files} folders`, data: entries.slice(0, limit) };
  },

  async "fs.read"(args) {
    const file = await inRoots(args.path);
    const base64 = args.encoding === "base64";
    const max = base64 ? 25e6 : Math.min(Number(args.maxBytes) || 20000, 200000);
    const buf = await fs.readFile(file);
    if (base64 && buf.length > max) throw new Error(`${short(file)} is too big to attach (${mb(buf.length)})`);
    const text = buf.subarray(0, max).toString(base64 ? "base64" : "utf8");
    return { output: `Read ${short(file)} (${mb(buf.length)})`, data: { text, truncated: buf.length > max, bytes: buf.length, name: path.basename(file) } };
  },

  async "fs.write"(args) {
    const target = await inRoots(args.path, { mustExist: false });
    await fs.mkdir(path.dirname(target), { recursive: true });
    const file = args.overwrite ? target : await freeName(path.dirname(target), path.basename(target));
    await fs.writeFile(file, String(args.content ?? ""), "utf8");
    return { output: `Wrote ${short(file)}`, data: { path: short(file) } };
  },

  async "fs.mkdir"(args) {
    const dir = await inRoots(args.path, { mustExist: false });
    await fs.mkdir(dir, { recursive: true });
    return { output: `Folder ready: ${short(dir)}`, data: { path: short(dir) } };
  },

  async "fs.move"(args, progress) {
    const to = await inRoots(args.to, { mustExist: false });
    await fs.mkdir(to, { recursive: true });
    const paths = asStrings(args.paths);
    let moved = 0;
    for (const p of paths) {
      const from = await inRoots(p);
      const dest = await freeName(to, path.basename(from));
      await fs.rename(from, dest);
      moved++;
      if (moved % 25 === 0) progress(`Moved ${moved} of ${paths.length}`);
    }
    return { output: `Moved ${moved} item${moved === 1 ? "" : "s"} to ${short(to)}`, data: { moved, to: short(to) } };
  },

  async "fs.trash"(args) {
    const paths = asStrings(args.paths);
    const bin = path.join(TRASH, new Date().toISOString().replace(/[:.]/g, "-"));
    await fs.mkdir(bin, { recursive: true });
    let bytes = 0, n = 0;
    for (const p of paths) {
      const from = await inRoots(p);
      const st = await fs.stat(from);
      bytes += st.size;
      await fs.rename(from, await freeName(bin, path.basename(from)));
      n++;
    }
    return { output: `Moved ${n} item${n === 1 ? "" : "s"} (${mb(bytes)}) to ${short(bin)}. Undo by moving them back.`, data: { trashed: n, bytes, bin: short(bin) } };
  },

  async "fs.duplicates"(args, progress) {
    const dir = await inRoots(args.path);
    const names = (await fs.readdir(dir)).filter(n => !n.startsWith("."));
    const bySize = new Map<number, { p: string; mtime: number }[]>();
    for (const n of names) {
      const p = path.join(dir, n);
      const st = await fs.stat(p).catch(() => null);
      if (!st || !st.isFile()) continue;
      const list = bySize.get(st.size) || [];
      list.push({ p, mtime: st.mtimeMs });
      bySize.set(st.size, list);
    }
    const groups: { keep: string; dupes: string[]; size: number }[] = [];
    let hashed = 0;
    for (const [size, list] of bySize) {
      if (list.length < 2) continue;
      const byHash = new Map<string, { p: string; mtime: number }[]>();
      for (const f of list) {
        const h = await hashFile(f.p);
        if (++hashed % 50 === 0) progress(`Compared ${hashed} files`);
        byHash.set(h, [...(byHash.get(h) || []), f]);
      }
      for (const same of byHash.values()) {
        if (same.length < 2) continue;
        same.sort((a, b) => copyish(a.p) - copyish(b.p) || a.mtime - b.mtime); // keep the original, else the oldest
        groups.push({ keep: short(same[0].p), dupes: same.slice(1).map(x => short(x.p)), size });
      }
    }
    const count = groups.reduce((s, g) => s + g.dupes.length, 0);
    const bytes = groups.reduce((s, g) => s + g.size * g.dupes.length, 0);
    return { output: `Found ${count} duplicate${count === 1 ? "" : "s"} (${mb(bytes)}) in ${short(dir)}`, data: { groups, count, bytes } };
  },

  async open(args) {
    const target = String(args.target || "");
    if (!target) throw new Error("Nothing to open");
    const isUrl = /^https?:\/\//i.test(target);
    const resolved = isUrl ? target : await inRoots(target);
    const [cmd, cmdArgs] =
      process.platform === "darwin" ? ["open", [resolved]] :
      process.platform === "win32" ? ["cmd", ["/c", "start", "", resolved]] :
      ["xdg-open", [resolved]];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(cmd as string, cmdArgs as string[], { detached: true, stdio: "ignore" });
      child.on("error", reject);
      child.on("spawn", () => { child.unref(); resolve(); });
    }).catch(err => { throw new Error(`Couldn't open it here (${(err as Error).message}). Path: ${isUrl ? resolved : short(resolved)}`); });
    return { output: `Opened ${isUrl ? resolved : short(resolved)}` };
  },

  async notify(args) {
    const title = String(args.title || "Flip"), body = String(args.body || "");
    const q = (s: string) => JSON.stringify(s);
    const cmd =
      process.platform === "darwin" ? `osascript -e ${q(`display notification ${q(body)} with title ${q(title)}`)}` :
      process.platform === "linux" ? `notify-send ${q(title)} ${q(body)}` : "";
    if (cmd) await new Promise<void>(r => exec(cmd, () => r()));
    console.log(`${c.bold}${c.cyan}  ┌ ${title}${c.reset}\n${c.cyan}  └ ${body}${c.reset}`);
    return { output: `Showed: ${title}` };
  },

  async shell(args, progress) {
    if (!ALLOW_SHELL) throw new Error("Shell is off on this machine. Start the PC agent with --allow-shell.");
    const command = args.command;
    if (typeof command !== "string" || !command.trim()) throw new Error("A command is required.");
    if (args.cwd !== undefined && (typeof args.cwd !== "string" || !args.cwd.trim())) throw new Error("Invalid working folder.");
    const cwd = typeof args.cwd === "string" ? await fs.realpath(expand(args.cwd)) : WORKSPACE;
    progress(`$ ${command}`);
    const windows = process.platform === "win32";
    const shell = windows ? "powershell.exe" : "/bin/sh";
    const shellArgs = windows
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];
    return await new Promise<Result>((resolve, reject) => {
      execFile(shell, shellArgs, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        const out = (stdout + (stderr ? `\n${stderr}` : "")).trim().slice(-8000);
        if (err) {
          const reason = err.killed ? "Command stopped before completion" : `Command failed (${err.code ?? err.signal ?? "unknown error"})`;
          reject(new Error(out ? `${reason}\n${out}` : reason));
        } else {
          resolve({ output: out || "Command exited successfully." });
        }
      });
    });
  },

  // Reads Claude Code's local logs to find when the current 5-hour usage window resets.
  async "claude.window"() {
    const dir = path.join(HOME, ".claude", "projects");
    if (!existsSync(dir)) return { output: "No Claude Code logs on this machine", data: { active: false } };
    const since = Date.now() - 12 * 3600e3;
    const stamps: number[] = [];
    for (const file of await walk(dir, 4)) {
      if (!file.endsWith(".jsonl")) continue;
      const st = await fs.stat(file).catch(() => null);
      if (!st || st.mtimeMs < since) continue;
      const text = await fs.readFile(file, "utf8").catch(() => "");
      for (const m of text.matchAll(/"timestamp"\s*:\s*"([^"]+)"/g)) {
        const t = Date.parse(m[1]);
        if (t >= since) stamps.push(t);
      }
    }
    if (!stamps.length) return { output: "No Claude Code use in the last 12 hours", data: { active: false } };
    stamps.sort((a, b) => a - b);
    // Blocks: start at the first message (floored to the hour), last 5 hours.
    let start = floorHour(stamps[0]);
    for (const t of stamps) if (t >= start + 5 * 3600e3) start = floorHour(t);
    const end = start + 5 * 3600e3;
    const active = Date.now() < end;
    return { output: active ? `Claude window resets at ${new Date(end).toLocaleTimeString()}` : "Claude window is open (no active block)",
      data: { active, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), lastActivity: new Date(stamps[stamps.length - 1]).toISOString() } };
  },
};

const floorHour = (t: number) => Math.floor(t / 3600e3) * 3600e3;
const mb = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} bytes`);
/** Copies look like "x copy.png", "x copy 2.png" or "x (1).png": keep the original name. */
const copyish = (p: string) => /( copy( \d+)?| \(\d+\))$/i.test(path.basename(p, path.extname(p))) ? 1 : 0;

async function walk(dir: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p, depth - 1)));
    else out.push(p);
  }
  return out;
}

function hashFile(p: string) {
  return new Promise<string>((resolve, reject) => {
    const h = crypto.createHash("sha1");
    createReadStream(p).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/* ---------------------------------- Coding agents ---------------------------------- */
// ADR 0020: the Dock shows which coding agents run on this machine (Claude Code, Codex, OpenCode, …)
// and whether each is busy. We only read the process list, the working folder and its git branch.
// Nothing about the code or the conversation leaves the machine.

const execText = (cmd: string, timeout = 3000) => new Promise<string>(resolve =>
  exec(cmd, { timeout, maxBuffer: 4e6 }, (_err, out) => resolve(String(out || ""))));

const TOOL_NAMES: Record<string, CodingTool> = {
  claude: "claude-code", codex: "codex", opencode: "opencode", antigravity: "antigravity",
  "cursor-agent": "cursor", gemini: "gemini", aider: "aider",
};
const RUNTIMES = new Set(["node", "bun", "deno", "python", "python3"]);

/** Which coding tool a command line is, if any. Desktop chat apps (Claude.app, Codex.app) don't count. */
function toolOf(args: string): CodingTool | null {
  const parts = args.trim().split(/\s+/);
  const base = (s = "") => path.basename(s).toLowerCase().replace(/\.(js|mjs|exe)$/, "");
  let name = base(parts[0]);
  if (RUNTIMES.has(name)) name = base(parts[1]);
  if (/\/Antigravity\.app\/Contents\/MacOS\/Antigravity$/i.test(parts[0])) return "antigravity";
  if (/\.app\//i.test(parts[0])) return null;
  return TOOL_NAMES[name] ?? null;
}

const startedAt = new Map<number, string>();
const lastBusy = new Map<number, number>();
const gitCache = new Map<string, { at: number; repo: string; branch?: string }>();

async function cwdOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  if (process.platform === "linux") {
    await Promise.all(pids.map(async pid => { const d = await fs.readlink(`/proc/${pid}/cwd`).catch(() => ""); if (d) out.set(pid, d); }));
    return out;
  }
  if (process.platform !== "darwin") return out;
  let pid = 0;
  for (const line of (await execText(`lsof -a -d cwd -Fn -p ${pids.join(",")}`)).split("\n")) {
    if (line[0] === "p") pid = Number(line.slice(1));
    else if (line[0] === "n" && pid) out.set(pid, line.slice(1));
  }
  return out;
}

async function gitOf(dir: string) {
  const hit = gitCache.get(dir);
  if (hit && Date.now() - hit.at < 30_000) return hit;
  const [top = "", branch = ""] = (await execText(`git -C ${JSON.stringify(dir)} rev-parse --show-toplevel --abbrev-ref HEAD`)).trim().split("\n");
  const v = { at: Date.now(), repo: path.basename(top || dir) || short(dir), branch: branch && branch !== "HEAD" ? branch : undefined };
  gitCache.set(dir, v);
  return v;
}

/** Claude Code writes its transcript as it works: a fresh write means it's busy. */
async function claudeWroteRecently(dir: string) {
  const folder = path.join(HOME, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"));
  const files = await fs.readdir(folder).catch(() => [] as string[]);
  let newest = 0;
  for (const f of files) if (f.endsWith(".jsonl")) newest = Math.max(newest, (await fs.stat(path.join(folder, f)).catch(() => null))?.mtimeMs ?? 0);
  return Date.now() - newest < 8000;
}

/** ps "elapsed" time, [[dd-]hh:]mm:ss, in seconds. */
function etimeSec(t: string) {
  const [d, rest] = t.includes("-") ? t.split("-") : ["0", t];
  return rest.split(":").map(Number).reduce((a, n) => a * 60 + n, 0) + Number(d) * 86400;
}

async function scanCoding(): Promise<PcCodingSession[]> {
  if (process.platform === "win32") return [];
  const rows = (await execText("ps -axo pid=,ppid=,pcpu=,etime=,args=")).split("\n").map(l => {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+([\d:-]+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), ppid: Number(m[2]), cpu: Number(m[3]), age: etimeSec(m[4]), tool: toolOf(m[5]) } : null;
  }).filter((r): r is { pid: number; ppid: number; cpu: number; age: number; tool: CodingTool } => !!r && !!r.tool && r.pid !== process.pid);
  // A tool's own helper processes have a parent of the same tool: count the session once.
  const byPid = new Map(rows.map(r => [r.pid, r]));
  const top = rows.filter(r => byPid.get(r.ppid)?.tool !== r.tool);
  const cwds = await cwdOf(top.map(r => r.pid));
  const now = Date.now();
  const sessions: PcCodingSession[] = [];
  for (const r of top) {
    const dir = cwds.get(r.pid);
    if (!dir) continue;
    if (!startedAt.has(r.pid)) startedAt.set(r.pid, new Date(Math.floor((now - r.age * 1000) / 60e3) * 60e3).toISOString());
    const git = await gitOf(dir);
    let busy = r.cpu > 2;
    if (r.tool === "claude-code") busy = busy || await claudeWroteRecently(dir);
    if (busy) lastBusy.set(r.pid, now);
    sessions.push({ pid: r.pid, tool: r.tool, repo: git.repo, branch: git.branch, busy: now - (lastBusy.get(r.pid) ?? 0) < 6000, startedAt: startedAt.get(r.pid)! });
  }
  for (const pid of startedAt.keys()) if (!byPid.has(pid)) { startedAt.delete(pid); lastBusy.delete(pid); }
  return sessions.sort((a, b) => a.pid - b.pid);
}

let coding: PcCodingSession[] = [];
let codingKey = "";
const codingSubs = new Set<(s: PcCodingSession[]) => void>();
async function watchCoding() {
  try {
    const next = await scanCoding();
    const key = JSON.stringify(next);
    if (key !== codingKey) {
      codingKey = key;
      coding = next;
      for (const fn of codingSubs) fn(coding);
    }
  } catch { /* try again next tick */ }
  setTimeout(watchCoding, 3000);
}
void watchCoding();

/* ---------------------------------- Server ---------------------------------- */

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on("connection", (ws: WebSocket, req) => {
  if (req.headers.origin) {
    ws.close(4003, "PC agent requires a server connection");
    return;
  }
  let authed = false;
  const peer = req.socket.remoteAddress;
  const send = (m: PcAgentResult) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const kill = setTimeout(() => !authed && ws.close(4001, "auth timeout"), 5000);
  const pushCoding = (sessions: PcCodingSession[]) => send({ type: "pc.coding", sessions });

  ws.on("message", async raw => {
    let msg: PcAgentCommand;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!authed) {
      if (msg.type === "pc.auth" && safeEqual(msg.token, TOKEN)) {
        authed = true;
        clearTimeout(kill);
        say("●", c.green, `Server connected from ${peer}`);
        send({ type: "pc.hello", machineId: MACHINE_ID, name: NAME, platform: process.platform, home: HOME, roots: ACTIVE_ROOTS.map(short), actions: ACTIONS });
        send({ type: "pc.coding", sessions: coding });
        codingSubs.add(pushCoding);
      } else {
        say("✕", c.red, `Rejected a connection from ${peer} (bad token)`);
        send({ type: "pc.error", message: "bad token" });
        ws.close(4003, "bad token");
      }
      return;
    }
    if (msg.type === "pc.ping") return send({ type: "pc.pong", t: msg.t });
    if (msg.type !== "pc.run") return;
    const fn = actions[msg.action];
    if (!fn || !ACTIONS.includes(msg.action)) {
      say("✕", c.red, `Refused unknown action ${msg.action}`);
      return send({ type: "pc.done", requestId: msg.requestId, ok: false, output: `This machine doesn't allow "${msg.action}"` });
    }
    say("▶", c.yellow, `${c.bold}${msg.action}${c.reset} ${describe(msg.args)}`);
    try {
      const r = await fn(msg.args || {}, step => { say("…", c.dim, step); send({ type: "pc.progress", requestId: msg.requestId, step }); });
      say("✓", c.green, r.output);
      send({ type: "pc.done", requestId: msg.requestId, ok: true, output: r.output, data: r.data });
    } catch (err) {
      const message = (err as Error).message;
      say("✕", c.red, message);
      send({ type: "pc.done", requestId: msg.requestId, ok: false, output: message });
    }
  });
  ws.on("close", () => { codingSubs.delete(pushCoding); if (authed) say("○", c.dim, "Server disconnected"); });
});

function safeEqual(a: unknown, b: string) {
  if (typeof a !== "string") return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function describe(args: Record<string, unknown>) {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args || {})) {
    if (k === "content") parts.push(`content=${String(v).length} chars`);
    else if (Array.isArray(v)) parts.push(`${k}=[${v.length}]`);
    else parts.push(`${k}=${String(v).slice(0, 80)}`);
  }
  return c.dim + parts.join(" ") + c.reset;
}

wss.on("listening", () => {
  console.log(`\n${c.bold}PC agent${c.reset} · ${NAME} · ws://${HOST}:${PORT}`);
  console.log(`${c.dim}Allowed folders:${c.reset} ${ACTIVE_ROOTS.map(short).join(", ") || "(none exist!)"}`);
  console.log(`${c.dim}Actions:${c.reset} ${ACTIONS.join(", ")}`);
  if (TOKEN === "dev-token") console.log(`${c.yellow}Default token: only this machine can connect. To let your server in over Tailscale, set the same PC_AGENT_TOKEN here and on the server.${c.reset}`);
  console.log("");
});
wss.on("error", err => { console.error(`PC agent couldn't start: ${err.message}`); process.exit(1); });
