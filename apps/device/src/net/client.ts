// The Device's only link to the server: one WebSocket speaking @app/protocol.
// Offline-first notes (ADR 0005): a dump made offline is kept here and synced when back.
import { useSyncExternalStore } from "react";
import {
  APP_IDS,
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientKind,
  type DeviceMessage,
  type DeviceMode,
  type Note,
  type VoiceTarget,
  type ServerMessage,
  type Snapshot,
  type AppId,
  minAppAgents,
} from "@app/protocol";

export type Conn = "connecting" | "online" | "offline";

export interface OfflineNote {
  localId: string;
  text: string;
  createdAt: string;
  durationMs: number;
  editedByUser: boolean;
  audio?: string;
  mime?: string;
  cloudText?: string;
}

type Listener = (m: ServerMessage) => void;
const OFFLINE_KEY = "flip-offline-notes";
const OFFLINE_MESSAGES_KEY = "flip-offline-agent-messages";
type OfflineAgentMessage = { requestId: string; target: Extract<VoiceTarget, { kind: "main" | "agent" | "app" }>; text: string; audio?: string; mime?: string };

function store<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function persist(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or blocked */
  }
}

const DEFAULT_APP_OWNERS: Record<AppId, string | null> = {
  notes: "app_notes", todo: "app_todo", focus: "app_focus", agents: "app_agents", settings: "app_settings", build: null,
};
function withAppAgents(snapshot: Snapshot | null): Snapshot | null {
  if (!snapshot) return null;
  const saved = (snapshot as Partial<Snapshot> & { appOwners?: Partial<Record<AppId, string>> }).appAgents;
  const legacy = (snapshot as Snapshot & { appOwners?: Partial<Record<AppId, string>> }).appOwners;
  // Build may have no agent of its own (ADR 0021): an empty list is kept as it is.
  const fallback = (app: AppId) => { const id = legacy?.[app] ?? DEFAULT_APP_OWNERS[app]; return id ? [id] : []; };
  const appAgents = Object.fromEntries(APP_IDS.map(app => [app, Array.isArray(saved?.[app]) && (saved[app].length || minAppAgents(app) === 0) ? saved[app] : fallback(app)])) as Record<AppId, string[]>;
  return { ...snapshot, appAgents };
}

function serverUrl() {
  const q = new URLSearchParams(location.search).get("server");
  if (q) return q.replace(/^http/, "ws").replace(/\/?$/, q.endsWith("/ws") ? "" : "/ws");
  const env = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (env) return env;
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}

class Net {
  /** Last snapshot, cached so the Device still works after a reboot while offline. */
  snap: Snapshot | null = withAppAgents(store<Snapshot | null>("flip-last-snapshot", null));
  private snapSaved = 0;
  conn: Conn = "connecting";
  /** Simulated network loss from the dev panel. */
  forcedOffline = false;
  mode: DeviceMode = "handheld";
  offlineNotes: OfflineNote[] = store(OFFLINE_KEY, []);
  offlineAgentMessages: OfflineAgentMessage[] = store(OFFLINE_MESSAGES_KEY, []);
  version = 0;
  private ws: WebSocket | null = null;
  private subs = new Set<() => void>();
  private listeners = new Set<Listener>();
  private retry: number | undefined;
  private backoff = 500;
  readonly deviceId: string;
  readonly url = serverUrl();
  lastPong = 0;

  constructor(readonly kind: ClientKind) {
    let did = store<string>("flip-device-id", "");
    if (!did) {
      did = "dev_" + Math.random().toString(36).slice(2, 10);
      persist("flip-device-id", did);
    }
    this.deviceId = did;
    this.connect();
    setInterval(() => this.conn === "online" && this.send({ type: "ping", t: Date.now() }), 10000);
  }

  private bump() {
    this.version++;
    for (const s of this.subs) s();
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn);
    return () => { this.subs.delete(fn); };
  };

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private connect() {
    if (this.forcedOffline) return;
    clearTimeout(this.retry);
    this.conn = this.conn === "online" ? "online" : "connecting";
    const token = new URLSearchParams(location.hash.slice(1)).get("deviceToken");
    const protocols = token && /^[A-Za-z0-9_-]{24,}$/.test(token) ? ["flip-device", `auth.${token}`] : undefined;
    const ws = new WebSocket(this.url, protocols);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.sendRaw({ type: "hello", deviceId: this.deviceId, mode: this.mode, client: this.kind, protocol: PROTOCOL_VERSION });
    };
    ws.onmessage = ev => {
      const m = parseServerMessage(String(ev.data));
      if (!m) return;
      if (m.type === "welcome") {
        this.conn = "online";
        this.flushOffline();
      }
      if (m.type === "snapshot") {
        this.snap = withAppAgents(m.snapshot);
        if (Date.now() - this.snapSaved > 5000) { this.snapSaved = Date.now(); persist("flip-last-snapshot", m.snapshot); }
      }
      if (m.type === "pong") this.lastPong = Date.now() - m.t;
      if (m.type === "note.saved" && m.localId) this.dropOffline(m.localId);
      if (m.type === "voice.accepted") this.dropOfflineAgentMessage(m.streamId);
      if (m.type === "voice.rejected") this.dropOfflineAgentMessage(m.streamId);
      for (const l of this.listeners) l(m);
      this.bump();
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.conn = "offline";
      this.bump();
      if (!this.forcedOffline) {
        this.retry = window.setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 1.7, 5000);
      }
    };
    ws.onerror = () => ws.close();
  }

  private sendRaw(m: DeviceMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(m));
      return true;
    }
    return false;
  }

  /** Send to the server. Returns false when offline (the caller decides what to do). */
  send(m: DeviceMessage) {
    if (this.conn !== "online") return false;
    return this.sendRaw(m);
  }

  get online() {
    return this.conn === "online";
  }

  setForcedOffline(off: boolean) {
    this.forcedOffline = off;
    if (off) {
      const ws = this.ws;
      this.ws = null;
      ws?.close();
      this.conn = "offline";
      this.bump();
    } else {
      this.backoff = 500;
      this.connect();
      this.bump();
    }
  }

  setMode(mode: DeviceMode) {
    this.mode = mode;
    this.send({ type: "mode.changed", mode });
    this.bump();
  }

  saveOffline(n: OfflineNote) {
    this.offlineNotes = [n, ...this.offlineNotes];
    // Audio can be big; keep it only if storage takes it.
    persist(OFFLINE_KEY, this.offlineNotes);
    try {
      localStorage.getItem(OFFLINE_KEY);
    } catch {
      /* ignore */
    }
    this.bump();
  }

  appendOffline(localId: string, text: string) {
    this.offlineNotes = this.offlineNotes.map(n => (n.localId === localId ? { ...n, text: `${n.text} ${text}`.trim(), editedByUser: true } : n));
    persist(OFFLINE_KEY, this.offlineNotes);
    this.bump();
  }

  saveOfflineAgentMessage(message: OfflineAgentMessage) {
    this.offlineAgentMessages = [...this.offlineAgentMessages.filter(item => item.requestId !== message.requestId), message];
    persist(OFFLINE_MESSAGES_KEY, this.offlineAgentMessages);
    this.bump();
  }

  private dropOfflineAgentMessage(requestId: string) {
    this.offlineAgentMessages = this.offlineAgentMessages.filter(message => message.requestId !== requestId);
    persist(OFFLINE_MESSAGES_KEY, this.offlineAgentMessages);
  }

  private dropOffline(localId: string) {
    this.offlineNotes = this.offlineNotes.filter(n => n.localId !== localId);
    persist(OFFLINE_KEY, this.offlineNotes);
  }

  private flushOffline() {
    for (const n of [...this.offlineNotes].reverse()) this.sendRaw({ type: "note.sync", note: n });
    for (const message of this.offlineAgentMessages) this.sendRaw({ type: "voice.message", ...message });
  }
}

const kind: ClientKind = location.pathname.startsWith("/dock") ? "dock" : "device";
export const net = new Net(kind);

/** Notes as the screen shows them: offline ones first, then the server's. */
export function offlineAsNotes(list: OfflineNote[]): Note[] {
  return list.map(n => ({
    id: "local:" + n.localId,
    text: n.text,
    createdAt: n.createdAt,
    transcribedBy: "local",
    editedByUser: n.editedByUser,
    durationMs: n.durationMs,
    suggestionState: "offline",
    suggestions: [],
    taskIds: [],
  }));
}

export function useNet() {
  useSyncExternalStore(net.subscribe, () => net.version);
  return net;
}
