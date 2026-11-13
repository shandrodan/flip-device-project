// PC agent: the small program on the user's laptop. The server reaches it over Tailscale
// (ADR 0006) and asks it to run one of a short list of actions (ADR 0008). Every path must
// sit inside an allowed root. Deletes never delete: files go to ~/.flip-trash.
//
//   PC_AGENT_TOKEN=... pnpm --filter pc-agent dev
//
// Env / flags:
//   PC_AGENT_PORT   (7077)
//   PC_AGENT_HOST   where to listen. Default: 127.0.0.1 with the dev token, 0.0.0.0 once you set
//                   a real token. Best: your Tailscale IP (100.x.y.z) so only your tailnet sees it.
//   PC_AGENT_TOKEN  shared secret, must match the server's PC_AGENT_TOKEN
//   PC_AGENT_NAME   shown on the Device (defaults to the hostname)
//   PC_AGENT_ROOTS  comma list of folders it may touch (defaults below)
//   --allow-shell   enables the "shell" action (always needs an approval press unless Full mode)

import { WebSocketServer, WebSocket } from "ws";
import os from "node:os";
import fs from "node:fs/promises";
import { createReadStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, exec } from "node:child_process";
import type { FsEntry, PcAction, PcAgentCommand, PcAgentResult } from "@app/protocol";

const HOME = os.homedir();
const PORT = Number(process.env.PC_AGENT_PORT || 7077);
const TOKEN = process.env.PC_AGENT_TOKEN || "dev-token";
// Never expose the default token beyond this machine.
const HOST = process.env.PC_AGENT_HOST || (TOKEN === "dev-token" ? "127.0.0.1" : "0.0.0.0");
const NAME = process.env.PC_AGENT_NAME || prettyHost();
const ALLOW_SHELL = process.argv.includes("--allow-shell") || process.env.PC_AGENT_ALLOW_SHELL === "1";
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
const ACTIONS: PcAction[] = ["fs.list", "fs.read", "fs.write", "fs.mkdir", "fs.move", "fs.trash", "fs.duplicates", "open", "notify", "claude.window", ...(ALLOW_SHELL ? (["shell"] as PcAction[]) : [])];
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

const short = (p: string) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);

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
  const ok = ACTIVE_ROOTS.some(r => real === r || real.startsWith(r + path.sep));
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
    const command = String(args.command || "");
    const cwd = args.cwd ? await inRoots(args.cwd) : WORKSPACE;
    progress(`$ ${command}`);
    return await new Promise<Result>((resolve, reject) => {
      exec(command, { cwd, timeout: 60_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const out = (stdout + (stderr ? `\n${stderr}` : "")).trim().slice(-8000);
        if (err && !out) reject(new Error(err.message));
        else resolve({ output: err ? `Exited with an error` : `Done`, data: { stdout: out, code: err ? (err as { code?: number }).code ?? 1 : 0 } });
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

/* ---------------------------------- Server ---------------------------------- */

const wss = new WebSocketServer({ host: HOST, port: PORT });

wss.on("connection", (ws: WebSocket, req) => {
  let authed = false;
  const peer = req.socket.remoteAddress;
  const send = (m: PcAgentResult) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  const kill = setTimeout(() => !authed && ws.close(4001, "auth timeout"), 5000);

  ws.on("message", async raw => {
    let msg: PcAgentCommand;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!authed) {
      if (msg.type === "pc.auth" && safeEqual(msg.token, TOKEN)) {
        authed = true;
        clearTimeout(kill);
        say("●", c.green, `Server connected from ${peer}`);
        send({ type: "pc.hello", machineId: MACHINE_ID, name: NAME, platform: process.platform, home: HOME, roots: ACTIVE_ROOTS.map(short), actions: ACTIONS });
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
  ws.on("close", () => authed && say("○", c.dim, "Server disconnected"));
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
