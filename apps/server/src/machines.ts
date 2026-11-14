// Connections to PC agents over Tailscale (ADR 0006). The server dials each configured
// machine, authenticates with the shared token, and keeps the link open with retries.
import WebSocket from "ws";
import type { CodingAgent, CodingTool, Machine, PcAction, PcAgentCommand, PcAgentResult, PcCodingSession, PcHello } from "@app/protocol";
import { config } from "./config.js";
import { state, id, type MachineConfig } from "./store.js";
import { bus } from "./bus.js";

export class MachineOffline extends Error {
  constructor(public machineName: string) {
    super(`Can't reach ${machineName}`);
  }
}

interface Pending {
  resolve: (r: { ok: boolean; output?: string; data?: unknown }) => void;
  onProgress?: (step: string) => void;
  timer: NodeJS.Timeout;
}

class Link {
  ws: WebSocket | null = null;
  hello: PcHello | null = null;
  /** Coding agents the PC agent last reported (ADR 0020). */
  coding: PcCodingSession[] = [];
  lastSeen: string | undefined;
  pending = new Map<string, Pending>();
  retry: NodeJS.Timeout | null = null;
  closed = false;
  backoff = 1000;
  onOnline: () => void = () => {};

  constructor(public cfg: MachineConfig) {
    this.connect();
  }

  get online() {
    return !!this.hello && this.ws?.readyState === WebSocket.OPEN;
  }

  get name() {
    return this.cfg.name || this.hello?.name || this.cfg.url;
  }

  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.cfg.url, { handshakeTimeout: 4000 });
    this.ws = ws;
    ws.on("open", () => {
      const auth: PcAgentCommand = { type: "pc.auth", token: config.pcToken, server: "flip-server" };
      ws.send(JSON.stringify(auth));
    });
    ws.on("message", raw => {
      let m: PcAgentResult;
      try { m = JSON.parse(String(raw)); } catch { return; }
      this.lastSeen = new Date().toISOString();
      if (m.type === "pc.hello") {
        const wasOnline = !!this.hello;
        this.hello = m;
        this.backoff = 1000;
        console.log(`[pc] ${this.name} online (${m.platform}), folders: ${m.roots.join(", ")}`);
        bus.changed();
        if (!wasOnline) this.onOnline();
      } else if (m.type === "pc.progress") {
        this.pending.get(m.requestId)?.onProgress?.(m.step);
      } else if (m.type === "pc.done") {
        const p = this.pending.get(m.requestId);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(m.requestId);
          p.resolve({ ok: m.ok, output: m.output, data: m.data });
        }
      } else if (m.type === "pc.coding" && Array.isArray(m.sessions)) {
        codingReport(this, m.sessions);
        bus.changed();
      } else if (m.type === "pc.error") {
        console.warn(`[pc] ${this.name}: ${m.message}`);
      }
    });
    ws.on("close", () => this.dropped());
    ws.on("error", () => { /* close follows */ });
  }

  dropped() {
    const was = !!this.hello;
    this.hello = null;
    this.coding = []; // unknown while offline; not "finished"
    for (const [rid, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, output: `Lost the connection to ${this.name}` });
      this.pending.delete(rid);
    }
    if (was) {
      console.log(`[pc] ${this.name} went offline`);
      bus.changed();
    }
    if (this.closed) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = setTimeout(() => this.connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 1.6, 8000);
  }

  run(action: PcAction, args: Record<string, unknown>, onProgress?: (s: string) => void, timeoutMs = 90_000): Promise<PcRunResult> {
    if (!this.online || !this.ws) return Promise.reject(new MachineOffline(this.name));
    if (this.hello && !this.hello.actions.includes(action)) {
      return Promise.resolve({ ok: false, output: `${this.name} doesn't allow "${action}"` });
    }
    const requestId = id("pc");
    const cmd: PcAgentCommand = { type: "pc.run", requestId, action, args };
    return new Promise<{ ok: boolean; output?: string; data?: unknown }>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: false, output: `${this.name} didn't answer in time` });
      }, timeoutMs);
      this.pending.set(requestId, { resolve, onProgress, timer });
      this.ws!.send(JSON.stringify(cmd));
    });
  }

  close() {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.ws?.close();
  }

  checkNow() {
    if (this.online) return;
    if (this.retry) clearTimeout(this.retry);
    this.backoff = 1000;
    this.ws?.terminate();
    this.connect();
  }
}

/* ------------------------------ Coding agents (ADR 0020) ------------------------------ */
const TOOL_LABEL: Record<CodingTool, string> = {
  "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity",
  cursor: "Cursor Agent", gemini: "Gemini CLI", aider: "Aider", other: "Coding agent",
};
const FINISHED_KEEP_MS = 30 * 60e3;
/** Sessions that ended while we watched, shown as "finished" for half an hour. */
const ended = new Map<string, CodingAgent>();
const codingId = (link: Link, pid: number) => `${machineId(link.cfg.url)}:${pid}`;
const asAgent = (link: Link, s: PcCodingSession): CodingAgent => ({
  id: codingId(link, s.pid), tool: s.tool, name: TOOL_LABEL[s.tool] ?? TOOL_LABEL.other, machine: link.name,
  repo: s.repo, branch: s.branch, state: s.busy ? "working" : "idle", since: s.startedAt,
});

function codingReport(link: Link, sessions: PcCodingSession[]) {
  const now = new Date().toISOString();
  const still = new Set(sessions.map(s => s.pid));
  for (const s of link.coding) if (!still.has(s.pid)) ended.set(codingId(link, s.pid), { ...asAgent(link, s), state: "finished", since: now });
  for (const s of sessions) ended.delete(codingId(link, s.pid));
  link.coding = sessions;
}

const links = new Map<string, Link>();
let onlineHook: (name: string) => void = () => {};

export const machines = {
  sync() {
    const wanted = new Set(state.machines.map(m => m.url));
    for (const [url, link] of links) if (!wanted.has(url)) { link.close(); links.delete(url); }
    for (const m of state.machines) {
      if (links.has(m.url)) { links.get(m.url)!.cfg = m; continue; }
      const link = new Link(m);
      link.onOnline = () => onlineHook(link.name);
      links.set(m.url, link);
    }
    bus.changed();
  },
  onOnline(fn: (name: string) => void) {
    onlineHook = fn;
  },
  list(): Machine[] {
    return [...links.values()].map(l => ({
      id: machineId(l.cfg.url),
      name: l.name,
      url: l.cfg.url,
      online: l.online,
      platform: l.hello?.platform,
      roots: l.hello?.roots,
      actions: l.hello?.actions,
      lastSeen: l.lastSeen,
    }));
  },
  /** An explicit name must identify one machine. With no name, use the first one online. */
  pick(name?: string): Link {
    const all = [...links.values()];
    if (!all.length) throw new MachineOffline("your computer (no PC agent configured)");
    if (name) {
      const n = name.toLowerCase();
      const exact = all.filter(l => l.name.toLowerCase() === n);
      const matches = exact.length ? exact : all.filter(l => l.name.toLowerCase().includes(n));
      if (matches.length === 1) return matches[0];
      throw new Error(matches.length ? `"${name}" matches more than one machine. Use its exact name.` : `No configured machine matches "${name}".`);
    }
    return all.find(l => l.online) || all[0];
  },
  anyOnline() {
    return [...links.values()].some(l => l.online);
  },
  check(machineIdOrUrl: string) {
    for (const l of links.values()) if (machineId(l.cfg.url) === machineIdOrUrl || l.cfg.url === machineIdOrUrl) l.checkNow();
  },
  links() {
    return [...links.values()];
  },
  /** Running coding agents on every online machine, then the ones that finished in the last 30 min. */
  coding(): CodingAgent[] {
    const cutoff = Date.now() - FINISHED_KEEP_MS;
    for (const [k, a] of ended) if (Date.parse(a.since) < cutoff) ended.delete(k);
    const live = [...links.values()].filter(l => l.online).flatMap(l => l.coding.map(s => asAgent(l, s)));
    const done = [...ended.values()].sort((a, b) => b.since.localeCompare(a.since)).slice(0, 8);
    return [...live, ...done];
  },
};

export type MachineLink = Link;
export interface PcRunResult { ok: boolean; output?: string; data?: unknown }
const machineId = (url: string) => "m_" + Buffer.from(url).toString("base64url").slice(-10);
