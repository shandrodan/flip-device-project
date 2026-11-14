// Dock mode (ADR 0020): a StandBy-style carousel beside the desktop. Clock, Focus, coding agents, the
// To-Do board and a split screen of two blocks you pick. Docked, only the lid's controls are in reach:
// the in-app wheel turns screens (zooming out while it turns) and the push bar acts. On the split
// screen, pressing the wheel edits it: turn to change a block, push bar for the other side, press to finish.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { CodingAgent, CodingTool, Snapshot, Task } from "@app/protocol";
import { useControls } from "../../input/controls";
import { net } from "../../net/client";
import { useApp } from "../context";
import { useTick } from "../ui";
import { columns, tasksIn, timeOf } from "./Todo";
import "./dock.css";

type Page = "clock" | "focus" | "agents" | "todo" | "split";
type Block = "clock" | "focus" | "agents" | "today" | "limits";
const PAGES: Page[] = ["clock", "focus", "agents", "todo", "split"];
const BLOCKS: Block[] = ["clock", "focus", "agents", "today", "limits"];
const BLOCK_LABEL: Record<Block, string> = { clock: "Clock", focus: "Focus timer", agents: "Agents", today: "Today", limits: "Claude limits" };
const SPLIT_KEY = "flip-dock-split-v1";
const STEP = 808; // page width + gap while zoomed out

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const mmss = (ms: number) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; };
const longDate = (d: Date) => d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
const minutes = (ms: number) => {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min`;
  if (m < 24 * 60) return `${Math.floor(m / 60)} h ${m % 60} min`;
  const d = Math.floor(m / 1440);
  return d === 1 ? "1 day" : `${d} days`;
};
/** Every page sits within two steps of the current one, so the endless wheel never sweeps across. */
const pos = (k: number, i: number) => ((k - i + PAGES.length + 2) % PAGES.length) - 2;

function loadSplit(): [Block, Block] {
  try {
    const v = JSON.parse(localStorage.getItem(SPLIT_KEY) || "null");
    if (Array.isArray(v) && v.length === 2 && v.every(b => BLOCKS.includes(b))) return v as [Block, Block];
  } catch { /* storage can be unavailable */ }
  return ["clock", "today"];
}
function saveSplit(v: [Block, Block]) {
  try { localStorage.setItem(SPLIT_KEY, JSON.stringify(v)); } catch { /* storage can be unavailable */ }
}

function focusLeft(snap: Snapshot) {
  const f = snap.focus;
  return f.running && f.endsAt ? Math.max(0, Date.parse(f.endsAt) - Date.now()) : f.remainingMs || f.lengthMs;
}

/** Docked Device: the StandBy screen with the lid controls. */
export function Dock() {
  const { snap, online, toast } = useApp();
  return <StandBy snap={snap} online={online} toast={toast} />;
}

/** Shared by the docked Device and the /dock page. */
export function StandBy({ snap, online = true, toast }: { snap: Snapshot; online?: boolean; toast?: (t: string) => void }) {
  const [at, setAt] = useState({ i: 0, prev: 0 });
  const [zoomed, setZoomed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [side, setSide] = useState<0 | 1>(0);
  const [split, setSplit] = useState<[Block, Block]>(loadSplit);
  const [swap, setSwap] = useState<{ side: 0 | 1; dir: 1 | -1; k: number } | null>(null);
  const zoomTimer = useRef<number>();
  useEffect(() => () => window.clearTimeout(zoomTimer.current), []);
  const page = PAGES[at.i];
  const shown: (Page | Block)[] = page === "split" ? split : [page];
  const canFocus = shown.includes("focus");

  const turn = (dir: number) => {
    if (editing) {
      const next = [...split] as [Block, Block];
      next[side] = BLOCKS[(BLOCKS.indexOf(split[side]) + dir + BLOCKS.length) % BLOCKS.length];
      setSplit(next);
      saveSplit(next);
      setSwap({ side, dir: dir > 0 ? 1 : -1, k: Date.now() });
      return;
    }
    setAt(a => ({ i: (a.i + dir + PAGES.length) % PAGES.length, prev: a.i }));
    setZoomed(true);
    window.clearTimeout(zoomTimer.current);
    zoomTimer.current = window.setTimeout(() => setZoomed(false), 440);
  };
  const press = () => {
    if (page !== "split") return false;
    window.clearTimeout(zoomTimer.current);
    setZoomed(false);
    setEditing(e => !e);
    setSide(0);
    return true;
  };
  const push = () => {
    if (editing) { setSide(s => (s ? 0 : 1)); return true; }
    if (!canFocus) return false;
    if (!online) { toast?.("Offline. The timer lives on the server."); return true; }
    const f = snap.focus;
    net.send(f.running ? { type: "focus.stop" } : { type: "focus.start", minutes: Math.round(f.lengthMs / 60000) || 25, kind: "focus" });
    return true;
  };

  useControls(e => {
    if (e.c === "appWheel") { turn(e.dir || 1); return true; }
    if (e.c === "appWheelPress") return press();
    if (e.c === "pushBar") return push();
    if (e.c === "b" && editing) { setEditing(false); return true; }
    return false;
  }, {
    wheel: editing ? "Change" : "Screens",
    push: editing ? "Other side" : canFocus ? (snap.focus.running ? "End focus" : "Start focus") : undefined,
  });

  return <div className={"sb" + (zoomed ? " zoomed" : "") + (editing ? " editing" : "")}>
    <div className="sb-scaler">
      {PAGES.map((p, k) => {
        const to = pos(k, at.i), from = pos(k, at.prev), near = Math.abs(to) <= 1;
        return <section key={p} className={"sb-pg" + (k === at.i ? " cur" : "") + (Math.abs(to - from) > 1 ? " jump" : "")}
          style={{ transform: `translateX(${to * STEP}px)` }} aria-hidden={k !== at.i}>
          <div className="sb-in">
            {p === "clock" && <ClockPage />}
            {p === "focus" && <FocusPage snap={snap} visible={near} />}
            {p === "agents" && <AgentsPage snap={snap} />}
            {p === "todo" && <TodoPage snap={snap} />}
            {p === "split" && <div className="sb-split">
              {split.map((b, s) => <div key={s} className={"sb-slot" + (editing && side === s ? " sel" : "")}>
                <div key={swap?.side === s ? swap.k : 0} className={"sb-box" + (swap?.side === s ? (swap.dir > 0 ? " sw-d" : " sw-u") : "")}>
                  <BlockView block={b} snap={snap} visible={near} />
                </div>
              </div>)}
            </div>}
          </div>
        </section>;
      })}
    </div>
    <div className="sb-dots" aria-hidden="true">{PAGES.map((_, k) => <i key={k} className={k === at.i ? "on" : ""} />)}</div>
    {editing && <div className="sb-edit" role="status">
      <b>{side ? "Right" : "Left"}: {BLOCK_LABEL[split[side]]}</b>
      <span><i>Turn</i> to change · <i>Push bar</i> other side · <i>Press</i> done</span>
    </div>}
  </div>;
}

/* ================================ Full screens ================================ */

function ClockPage() {
  useTick(1000);
  const d = new Date();
  return <div className="sb-fs sb-clock">
    <div className="sb-date">{longDate(d)}</div>
    <div className="sb-hm tnum">{pad(d.getHours())}<span>:</span>{pad(d.getMinutes())}</div>
  </div>;
}

function FocusPage({ snap, visible }: { snap: Snapshot; visible: boolean }) {
  return <div className={"sb-fs sb-focus" + (snap.focus.running ? "" : " off")}><FocusBody snap={snap} visible={visible} radius={16} /></div>;
}

function FocusBody({ snap, visible, radius }: { snap: Snapshot; visible: boolean; radius: number }) {
  useTick(500);
  const f = snap.focus, on = f.running, brk = f.kind === "break";
  return <>
    <FocusGlow snap={snap} visible={visible} radius={radius} />
    <span className="f-big tnum">{mmss(focusLeft(snap))}</span>
    <span className="f-tag">{on ? (brk ? "Break" : `Focus · round ${f.round}`) : `Ready · ${Math.round(f.lengthMs / 60000)} min`}</span>
    <span className="f-hint">{on ? "Push bar to end" : "Push bar to start"}</span>
  </>;
}

// Icons live in public/agent-icons. They're drawn as a mask in the tool's colour, so dark and light
// originals look the same on the black Dock. Tools without an icon show their initials.
const TOOL_LOOK: Record<CodingTool, { ic: string; c: string; icon?: string }> = {
  "claude-code": { ic: "CC", c: "#d97757", icon: "ProviderIcon-claude.svg" },
  codex: { ic: "CX", c: "#e5e5ea", icon: "ProviderIcon-codex.svg" },
  opencode: { ic: "OC", c: "#5ac8fa", icon: "ProviderIcon-opencode.svg" },
  antigravity: { ic: "AG", c: "#34c759", icon: "ProviderIcon-antigravity.svg" },
  cursor: { ic: "CU", c: "#d1d1d6", icon: "ProviderIcon-cursor.svg" },
  gemini: { ic: "GE", c: "#4c8df6", icon: "ProviderIcon-gemini.svg" },
  aider: { ic: "AI", c: "#ffd60a" }, other: { ic: "··", c: "#8e8e93" },
};
function ToolIcon({ tool }: { tool: CodingTool }) {
  const look = TOOL_LOOK[tool] ?? TOOL_LOOK.other;
  return <span className="sb-ic" aria-hidden="true">
    {look.icon ? <i style={{ ["--icon" as string]: `url("/agent-icons/${look.icon}")` }} /> : look.ic}
  </span>;
}
const ORDER: Record<CodingAgent["state"], number> = { working: 0, idle: 1, finished: 2 };
const STATE_LABEL: Record<CodingAgent["state"], string> = { working: "Working", idle: "Idle", finished: "Finished" };
const sortCoding = (list: CodingAgent[]) => [...list].sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.state === "finished" ? b.since.localeCompare(a.since) : a.since.localeCompare(b.since)));
const where = (a: CodingAgent) => [a.repo, a.branch, a.machine].filter(Boolean).join(" · ");
const when = (a: CodingAgent) => a.state === "finished" ? `${minutes(Date.now() - Date.parse(a.since))} ago` : `for ${minutes(Date.now() - Date.parse(a.since))}`;

function codingEmpty(snap: Snapshot) {
  if (!snap.machines.some(m => m.online)) return { title: "No computer connected", body: "Run the PC agent on your laptop to see Claude Code, Codex and OpenCode here." };
  return { title: "No coding agents running", body: "Start Claude Code, Codex or OpenCode and they show up here." };
}

function AgentsPage({ snap }: { snap: Snapshot }) {
  useTick(30000);
  const list = sortCoding(snap.coding ?? []), shown = list.slice(0, 5);
  const working = list.filter(a => a.state === "working").length, finished = list.filter(a => a.state === "finished").length;
  return <div className="sb-fs">
    <div className="sb-head"><b>Agents</b><span>{list.length ? `${working} working${finished ? ` · ${finished} finished` : ""}` : ""}</span><span className="right">On your machines</span></div>
    {!list.length ? <Empty {...codingEmpty(snap)} /> : <ul className="sb-ag">
      {shown.map(a => <li key={a.id} className={"st-" + a.state} style={{ ["--c" as string]: TOOL_LOOK[a.tool].c }}>
        <ToolIcon tool={a.tool} />
        <span className="sb-main"><span className="sb-top"><b>{a.name}</b><span className="sb-where">{where(a)}</span></span></span>
        <span className="sb-st"><span className="sb-pill">{STATE_LABEL[a.state]}</span><span>{when(a)}</span></span>
      </li>)}
      {list.length > shown.length && <li className="sb-more">+{list.length - shown.length} more</li>}
    </ul>}
  </div>;
}

function TodoPage({ snap }: { snap: Snapshot }) {
  useTick(60000); // "Today" moves at midnight
  const cols = columns(snap.tasks), open = cols.reduce((n, c) => n + c.tasks.length, 0);
  return <div className="sb-fs">
    <div className="sb-head"><b>To-Do</b><span>Scheduled · {open} open</span></div>
    <div className="sb-board">
      {cols.map((c, k) => <section key={c.key} className={"sb-col" + (c.late ? " late" : "") + (!c.late && (k === 0 || cols[k - 1].late) ? " today" : "")}>
        <header><b>{c.label}</b><span className="n">{c.tasks.length || ""}</span></header>
        <div className="sb-cbody">
          {c.tasks.map(t => <TaskCard key={t.id} t={t} snap={snap} late={!!c.late} />)}
          {!c.tasks.length && <div className="sb-add"><i aria-hidden="true">+</i>Hold the mic to add</div>}
        </div>
      </section>)}
    </div>
  </div>;
}

function TaskCard({ t, snap, late }: { t: Task; snap: Snapshot; late: boolean }) {
  const ag = t.agentId ? snap.agents.find(a => a.id === t.agentId) : undefined;
  const p = t.projectId ? snap.projects.find(x => x.id === t.projectId) : undefined;
  const time = late ? (t.due ? new Date(t.due.slice(0, 10) + "T12:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + (timeOf(t) ? " " + timeOf(t) : "") : null) : timeOf(t);
  const agLine = ag ? (t.status === "running" ? `Working · ${ag.name}` : t.status === "awaiting-approval" || t.status === "held" ? `Waiting for your press · ${ag.name}` : ag.name) : null;
  return <div className="sb-tc">
    <span className="sb-chk" />
    <div className="sb-bd">
      <span className="sb-tt">{t.title}</span>
      {(time || agLine || p) && <span className="sb-meta">
        {time && <span className={"sb-due" + (late ? " late" : "")}>{time}</span>}
        {agLine && <span className="sb-agl">{agLine}</span>}
        {p && <span className="sb-proj" style={{ ["--pc" as string]: p.color }}><i />{p.name}</span>}
      </span>}
    </div>
  </div>;
}

function Empty({ title, body }: { title: string; body: string }) {
  return <div className="sb-empty"><b>{title}</b><span>{body}</span></div>;
}

/* ================================ Split blocks ================================ */

function BlockView({ block, snap, visible }: { block: Block; snap: Snapshot; visible: boolean }) {
  if (block === "clock") return <ClockBlock />;
  if (block === "focus") return <div className={"blk blk-focus" + (snap.focus.running ? "" : " off")}><FocusBody snap={snap} visible={visible} radius={26} /></div>;
  if (block === "agents") return <AgentsBlock snap={snap} />;
  if (block === "today") return <TodayBlock snap={snap} />;
  return <LimitsBlock snap={snap} />;
}

function ClockBlock() {
  useTick(1000);
  const d = new Date();
  return <div className="blk blk-clock"><div className="sb-date">{longDate(d)}</div><div className="sb-hm tnum">{hhmm(d)}</div></div>;
}

function BlockHead({ title, count }: { title: string; count?: ReactNode }) {
  return <header className="blk-head"><b>{title}</b>{count != null && <span>{count}</span>}</header>;
}

function AgentsBlock({ snap }: { snap: Snapshot }) {
  const list = sortCoding(snap.coding ?? []);
  return <div className="blk">
    <BlockHead title="Agents" count={list.length ? `${list.filter(a => a.state === "working").length} working` : undefined} />
    {!list.length ? <Empty {...codingEmpty(snap)} /> : <ul className="sb-rows">
      {list.slice(0, 5).map(a => <li key={a.id} className={"sb-r st-" + a.state}>
        <span className="sb-dot" />
        <span className="sb-rb"><span className="sb-rt">{a.name} · {a.repo}</span><span className="sb-rm">{STATE_LABEL[a.state]} · {when(a)}</span></span>
      </li>)}
    </ul>}
  </div>;
}

function TodayBlock({ snap }: { snap: Snapshot }) {
  useTick(60000);
  const list = tasksIn("today", snap.tasks), shown = list.slice(0, 6);
  return <div className="blk">
    <BlockHead title="Today" count={list.length ? `${list.length} left` : undefined} />
    {!list.length ? <Empty title="Nothing left for today" body="Hold the mic and say what needs doing." /> : <ul className="sb-rows">
      {shown.map(t => {
        const p = t.projectId ? snap.projects.find(x => x.id === t.projectId) : undefined;
        return <li key={t.id} className="sb-r"><span className="sb-chk" /><span className="sb-rb"><span className="sb-rt">{t.title}</span><span className="sb-rm">{[timeOf(t), p?.name ?? "Inbox"].filter(Boolean).join(" · ")}</span></span></li>;
      })}
    </ul>}
    {list.length > shown.length && <div className="blk-more">+{list.length - shown.length} more</div>}
  </div>;
}

function LimitsBlock({ snap }: { snap: Snapshot }) {
  useTick(30000);
  const l = snap.limits;
  const left = l.resetAt ? Math.max(0, Date.parse(l.resetAt) - Date.now()) : 0;
  if (l.back) return <div className="blk blk-limits"><div className="sb-eyebrow">Claude limits</div><div className="sb-big">Back</div><div className="sb-hint">Your 5-hour window has reset.</div></div>;
  if (!l.resetAt) return <div className="blk blk-limits"><div className="sb-eyebrow">Claude limits</div><Empty title="No window running" body="Run the PC agent where you use Claude Code." /></div>;
  const m = Math.ceil(left / 60000);
  return <div className="blk blk-limits">
    <div className="sb-eyebrow">Claude limits reset in</div>
    <div className="sb-big tnum">{m >= 60 ? `${Math.floor(m / 60)}:${pad(m % 60)}` : m}<small>{m >= 60 ? "h" : "min"}</small></div>
    <div className="sb-hint">At {hhmm(new Date(l.resetAt))}{l.machine ? ` · from ${l.machine}` : ""}</div>
    <span className="sb-bar"><i style={{ transform: `scaleX(${1 - Math.min(1, left / (5 * 3600e3))})` }} /></span>
  </div>;
}

/* ================================ Focus glow ================================ */
// A WebGL shader. The glow covers the part of the edge that still has time (top centre, clockwise):
// white at the very edge, red further in. It grows stronger as the session runs out and breathes.
// It only draws while its page is in view. No WebGL: a still CSS glow.

const VS = "attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }";
const FS = `precision mediump float;
  uniform vec2 res; uniform float t, heat, on, rem, dpr, rad;
  float seg(vec2 p, vec2 a, vec2 b){ vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
  float sdRound(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
  void main(){
    vec2 q = (gl_FragCoord.xy - res * .5) / dpr; q.y = -q.y;
    float W = res.x * .5 / dpr, H = res.y * .5 / dpr, L = 4. * W + 4. * H, lit = rem * L;
    float eR = max(0., -sdRound(q, vec2(W, H), rad));
    vec2 c0 = vec2(0., -H), c1 = vec2(W, -H), c2 = vec2(W, H), c3 = vec2(-W, H), c4 = vec2(-W, -H);
    float k = 16., sum = 0., s0 = 0., s1;
    s1 = W;               if (lit > s0) sum += exp(-seg(q, c0, mix(c0, c1, min(1., (lit - s0) / (s1 - s0)))) / k); s0 = s1;
    s1 = W + 2. * H;      if (lit > s0) sum += exp(-seg(q, c1, mix(c1, c2, min(1., (lit - s0) / (s1 - s0)))) / k); s0 = s1;
    s1 = 3. * W + 2. * H; if (lit > s0) sum += exp(-seg(q, c2, mix(c2, c3, min(1., (lit - s0) / (s1 - s0)))) / k); s0 = s1;
    s1 = 3. * W + 4. * H; if (lit > s0) sum += exp(-seg(q, c3, mix(c3, c4, min(1., (lit - s0) / (s1 - s0)))) / k); s0 = s1;
    s1 = L;               if (lit > s0) sum += exp(-seg(q, c4, mix(c4, c0, min(1., (lit - s0) / (s1 - s0)))) / k);
    float dL = sum > 0. ? max(0., -k * log(sum)) : 1e4;
    float litness = exp(-max(0., dL - eR) / 10.);
    float a = atan(q.y, q.x);
    float flow = .5 + .5 * sin(a * 2. + t * .4 + 1.5 * sin(t * .23));
    float pulse = .8 + .2 * sin(t * 1.6);
    float reach = 34. + 40. * heat;
    float red = exp(-dL / reach) * (.62 + .4 * heat) * pulse * (.8 + .2 * flow);
    float white = (exp(-eR / 4.5) * .95 + exp(-eR / 13.) * .22) * litness;
    vec3 tint = mix(vec3(1., .96, .93), vec3(1., .22, .15), smoothstep(2., 26., eR));
    vec3 glow = (tint * white + vec3(1., .22, .15) * red) * on;
    vec3 base = vec3(1.) * (exp(-eR / 2.5) * .14 + exp(-eR / 14.) * .03);
    gl_FragColor = vec4(max(base, glow), 1.);
  }`;

function FocusGlow({ snap, visible, radius }: { snap: Snapshot; visible: boolean; radius: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ snap, visible });
  live.current = { snap, visible };
  const [noGl, setNoGl] = useState(false);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const gl = cv.getContext("webgl", { antialias: false });
    if (!gl || gl.isContextLost()) { setNoGl(true); return; }
    const sh = (type: number, src: string) => { const s = gl.createShader(type); if (s) { gl.shaderSource(s, src); gl.compileShader(s); } return s; };
    const pr = gl.createProgram(), vs = sh(gl.VERTEX_SHADER, VS), fs = sh(gl.FRAGMENT_SHADER, FS);
    if (!pr || !vs || !fs) { setNoGl(true); return; }
    gl.attachShader(pr, vs);
    gl.attachShader(pr, fs);
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) { setNoGl(true); return; }
    gl.useProgram(pr);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(pr, n);
    const uT = U("t"), uHeat = U("heat"), uOn = U("on"), uRem = U("rem");
    // Layout size, so the carousel's zoom doesn't change the drawing.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.offsetWidth * dpr;
    cv.height = cv.offsetHeight * dpr;
    gl.viewport(0, 0, cv.width, cv.height);
    gl.uniform2f(U("res"), cv.width, cv.height);
    gl.uniform1f(U("dpr"), dpr);
    gl.uniform1f(U("rad"), radius);
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let on = live.current.snap.focus.running ? 1 : 0, raf = 0;
    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      const { snap: s, visible: v } = live.current;
      if (!v) return;
      on += ((s.focus.running ? 1 : 0) - on) * 0.04;
      const rem = s.focus.running ? Math.min(1, focusLeft(s) / s.focus.lengthMs) : 1;
      gl.uniform1f(uT, still ? 0 : ms / 1000);
      gl.uniform1f(uHeat, 1 - rem);
      gl.uniform1f(uOn, on);
      gl.uniform1f(uRem, rem);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    raf = requestAnimationFrame(frame);
    // The context goes with the canvas. Losing it here would break StrictMode's second effect run.
    return () => cancelAnimationFrame(raf);
  }, [radius]);

  return <canvas ref={ref} className={"fx" + (noGl ? " nogl" : "")} aria-hidden="true" />;
}
