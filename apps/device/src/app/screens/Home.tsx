// Home: the main agent (the white bot) on the left, and one honeycomb on the right that holds
// the apps and the user's bots side by side, laid out like the Apple Watch app grid: round
// icons in rows of 3 and 4 by turns, the selected one centred and full size, the rest
// shrinking toward the edges. The in-app wheel walks every cell left to right, row by row.
// The D-pad moves left/right in that order and up/down to the nearest cell. A opens it.
// An app that has its own bots sits fused to them in a cluster (a pair, a triangle of 3, a 2 × 2
// block of 4, circles merged with necks), so you see at a glance which bot belongs to which
// app. Each circle is still its own cell.
// Blue D on an app or a bot opens its menu over the left column (ADR 0017).
import { useState, type ReactNode } from "react";
import type { Agent, AppId, Snapshot } from "@app/protocol";
import { Bot } from "../../bot/Bot";
import { useControls, step } from "../../input/controls";
import { useApp, useTalkTarget, FN_LABEL } from "../context";
import { ACTIVE, AgentBot, Ico, moodFor } from "../ui";
import { CommandCenter } from "../CommandCenter";
import { CellMenu } from "../CellMenu";
import { APP_TONE, botsOf, toneVars, type Tone } from "../tone";

export const APPS: { fn: AppId; icon: ReactNode; about: string }[] = [
  { fn: "notes", icon: Ico.notes, about: "Talk, and the agent files it in the right note" },
  { fn: "todo", icon: Ico.tasks, about: "Today’s tasks" },
  { fn: "build", icon: Ico.build, about: "Talk, and watch your app change" },
  { fn: "agents", icon: Ico.agents, about: "What every bot is doing" },
  { fn: "focus", icon: Ico.focus, about: "Focus timer" },
  { fn: "settings", icon: Ico.settings, about: "Keys, machines, modes" },
];

/** `tone` is set on an app with linked bots and on those bots: the unit is painted in the app's
 *  colours (tone.tsx). An app on its own stays grey. */
export type Cell =
  | { kind: "app"; fn: AppId; icon: ReactNode; about: string; tone?: Tone }
  | { kind: "bot"; agent: Agent; tone?: Tone }
  | { kind: "new" };

// Survives leaving Home, so B brings you back to the cell you opened.
let lastSel = 0;
// Grid pitch and the visible area of the comb (px).
const DX = 92, DY = 80, VIEW_W = 496, VIEW_H = 428, REACH = 250;
// How far apart fused circles sit, as a share of the normal pitch (92px → ~64px: they overlap).
const FUSE = 0.7;

// Honeycomb rows alternate 3 and 4 cells: 3, 4, 3, 4… Each row of 3 sits in the gaps of the
// rows of 4 around it.
const SHORT = 3, LONG = 4;
const LEFT = (VIEW_W - (LONG - 1) * DX) / 2;
const rowLen = (r: number) => r % 2 ? LONG : SHORT;
const slotX = (r: number, c: number) => LEFT + c * DX + (r % 2 ? 0 : DX / 2);
type Slot = { row: number; col: number; x: number; y: number };
const slot = (row: number, col: number): Slot => ({ row, col, x: slotX(row, col), y: row * DY });
const key = (row: number, col: number) => row * 8 + col;

/** The slots a unit of n cells takes with its first cell at (r, c), or null if it doesn't fit.
 *  A unit is a cluster, not a line: a pair side by side, and the rest in the rows below, as
 *  close to the pair's middle as the grid allows. 3 makes a triangle (the third cell sits in
 *  the gap under the pair), 4 a 2 × 2 block. */
function shapeAt(n: number, r: number, c: number, used: Set<number>): Slot[] | null {
  const out: Slot[] = [];
  const take = (row: number, col: number) => {
    if (col < 0 || col >= rowLen(row) || used.has(key(row, col))) return false;
    out.push(slot(row, col));
    return true;
  };
  if (!take(r, c)) return null;
  if (n === 1) return out;
  if (!take(r, c + 1)) return null;
  const mid = (slotX(r, c) + slotX(r, c + 1)) / 2;
  for (let left = n - 2, row = r + 1; left > 0; row++) {
    const k = Math.min(2, left);
    const cols = Array.from({ length: rowLen(row) }, (_, j) => j)
      .sort((a, b) => Math.abs(slotX(row, a) - mid) - Math.abs(slotX(row, b) - mid) || a - b)
      .slice(0, k).sort((a, b) => a - b);
    for (const col of cols) if (!take(row, col)) return null;
    left -= k;
  }
  return out;
}

/** The comb: units (an app fused with its own bots, or a lone cell) and the slot of each cell,
 *  both in reading order. Apps come first, then the other bots, then the cell that makes a new
 *  bot. Each unit takes the first place it fits, so a lone bot can fill a hole a cluster left.
 *  An app's bots are the fixed ones (tone.tsx), then every Task agent assigned to it, so adding
 *  an agent to an app on the Device links it on the comb straight away. */
export function combLayout(snap: Snapshot) {
  const linked = new Set(APPS.flatMap(a => botsOf(snap, a.fn)));
  const raw: Cell[][] = [
    ...APPS.map(a => {
      const bots = botsOf(snap, a.fn).flatMap(id => snap.agents.filter(g => g.id === id));
      const tone = bots.length ? APP_TONE[a.fn] : undefined;
      return [{ kind: "app" as const, ...a, tone }, ...bots.map(agent => ({ kind: "bot" as const, agent, tone }))];
    }),
    ...snap.agents.filter(g => !linked.has(g.id)).map(agent => [{ kind: "bot" as const, agent }]),
  ];
  const used = new Set<number>();
  const placed = raw.map(u => {
    let at: Slot[] | null = null;
    for (let r = 0; !at; r++) for (let c = 0; c < rowLen(r) && !at; c++) at = shapeAt(u.length, r, c, used);
    at.forEach(p => used.add(key(p.row, p.col)));
    return { u, at };
  }).sort((a, b) => key(a.at[0].row, a.at[0].col) - key(b.at[0].row, b.at[0].col));
  // The New bot cell goes in the first free slot after everything else.
  let k = Math.max(-1, ...used) + 1;
  while (used.has(k) || k % 8 >= rowLen(Math.floor(k / 8))) k++;
  placed.push({ u: [{ kind: "new" }], at: [slot(Math.floor(k / 8), k % 8)] });
  return { units: placed.map(p => p.u), slots: placed.map(p => p.at) };
}
/** The comb's cells in Home order. The system wheel flywheel uses the same order. */
export const combUnits = (snap: Snapshot) => combLayout(snap).units;

/** Where cell m of an n-cell unit sits, from the unit's centre, before fusing. Up to 3 the
 *  grid slots already make the shape; 4 and more are drawn as square rows of 2, like dice. */
function clusterOffset(n: number, m: number, at: Slot, centre: { x: number; y: number }) {
  if (n <= 3) return { x: at.x - centre.x, y: at.y - centre.y };
  const rows = Math.ceil(n / 2), row = Math.floor(m / 2), single = row === rows - 1 && n % 2 === 1;
  return { x: single ? 0 : (m % 2 ? 1 : -1) * DX / 2, y: (row - (rows - 1) / 2) * DX };
}

/** D-pad up/down: the nearest cell in the row above or below (left one on a tie). */
function vertical(i: number, dir: 1 | -1, pos: Slot[]) {
  const me = pos[i];
  let best = -1, bestDx = Infinity;
  pos.forEach((p, k) => {
    if (p.row !== me.row + dir) return;
    const dx = Math.abs(p.x - me.x);
    if (dx < bestDx - 0.5) { best = k; bestDx = dx; }
  });
  return best < 0 ? null : best;
}

export function Home() {
  const { snap, push, go, online } = useApp();
  useTalkTarget({ kind: "main" }, []);
  const active = snap.tasks.filter(t => t.agentId && ACTIVE.includes(t.status));
  const waiting = active.filter(t => ["held", "paused", "awaiting-approval"].includes(t.status));
  const running = active.filter(t => t.status === "running");
  const pending = snap.notes.find(n => n.suggestionState === "ready");
  const todo = snap.tasks.filter(t => t.status !== "done").length;

  const { units, slots } = combLayout(snap);
  const cells: Cell[] = units.flat(), pos = slots.flat();
  const group = units.flatMap((u, n) => u.map(() => n));
  const [cc, setCc] = useState(false);
  // The open cell menu, by cell key, so it follows the cell if the comb reorders.
  const [menu, setMenu] = useState<string | null>(null);
  const [sel, setSelState] = useState(lastSel);
  const setSel = (n: number) => { lastSel = n; setSelState(n); };
  const i = Math.min(sel, cells.length - 1);
  const cur = cells[i];

  const workOf = (id: string) => active.find(t => t.agentId === id);
  const keyOf = (c: Cell, k = 0) => c.kind === "bot" ? c.agent.id : c.kind === "app" ? c.fn : "new" + k;
  const menuCell = menu ? cells.find((c): c is Extract<Cell, { kind: "app" | "bot" }> => (c.kind === "app" || c.kind === "bot") && keyOf(c) === menu) : undefined;

  useControls(e => {
    if (e.c === "up" || e.c === "down") {
      const v = vertical(i, e.c === "up" ? -1 : 1, pos);
      if (v !== null) setSel(v);
      return true;
    }
    const n = step(i, e, cells.length, { dpad: "horizontal" });
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a") {
      if (cur.kind === "app") go(cur.fn);
      else if (cur.kind === "bot") push({ name: "agent", agentId: cur.agent.id });
      else push({ name: "create" });
      return true;
    }
    if (e.c === "d" && cur.kind !== "new") { setMenu(keyOf(cur)); return true; }
    if (e.c === "d" && pending) { push({ name: "suggest", noteId: pending.id }); return true; }
    // C opens the command center. Only Home does this; apps leave C to themselves.
    if (e.c === "c") { setCc(true); return true; }
    return false;
  }, {
    a: cur.kind === "new" ? "New bot" : "Open",
    d: cur.kind !== "new" ? "Menu" : pending ? "Suggestions" : undefined,
    c: "Command center",
    wheel: "Browse",
    dpad: "Browse",
  });

  const recent = Date.now() - Date.parse(snap.activity[0]?.at || "0") < 3000 && /^Finished/.test(snap.activity[0]?.text || "");
  const state = recent ? "happy" : running.length ? "think" : waiting.length ? "wide" : !online ? "sad" : "idle";
  const first = running[0], ag = first && snap.agents.find(a => a.id === first.agentId);
  const line = first ? `${ag?.name ?? "An agent"} is on it: ${first.title.charAt(0).toLowerCase() + first.title.slice(1)}`
    : waiting.length ? `${waiting.length} task${waiting.length > 1 ? "s" : ""} need${waiting.length > 1 ? "" : "s"} you`
    : "Hold the mic to talk to Main agent.";

  // Columns stay put (the comb is centred in its area); only rows scroll, so the selected row
  // sits in the middle and every row is always seen whole.
  const me = pos[i];
  /** Where cell k sits and how big it is: scroll so the selected row is in the middle, then
   *  shrink by distance from the selected cell (fisheye). */
  const geo = (k: number) => {
    const p = pos[k], x = p.x, y = p.y - me.y + VIEW_H / 2;
    // Sideways distance counts for less, so a whole row stays readable.
    const d = Math.hypot((x - me.x) * 0.45, y - VIEW_H / 2) / REACH;
    // Fused cells are pulled toward their unit's centre so the circles overlap, like drops
    // that ran into each other.
    const ks = cells.flatMap((_, j) => group[j] === group[k] ? [j] : []);
    const c = { x: ks.reduce((s, j) => s + pos[j].x, 0) / ks.length, y: ks.reduce((s, j) => s + pos[j].y, 0) / ks.length };
    const off = clusterOffset(ks.length, ks.indexOf(k), p, c);
    const fx = c.x + off.x * FUSE, fy = c.y - me.y + VIEW_H / 2 + off.y * FUSE;
    return { x: fx, y: fy, scale: k === i ? 1 : Math.max(0.2, 0.86 - d * d * 0.55), fade: Math.max(0, Math.min(1, 1.6 - d)) };
  };
  const partners = units[group[i]].filter(c => c !== cur)
    .map(c => c.kind === "app" ? FN_LABEL[c.fn] : c.kind === "bot" ? c.agent.name : "");

  const name = cur.kind === "app" ? FN_LABEL[cur.fn] : cur.kind === "bot" ? cur.agent.name : "New bot";
  const about = cur.kind === "app" ? `${cur.about} · ${snap.appAgents[cur.fn].map(id => snap.agents.find(agent => agent.id === id)?.name ?? "Unavailable").join(", ") || "Main agent"}`
    : cur.kind === "bot" ? (() => { const w = workOf(cur.agent.id); return w ? (w.status === "running" ? "Working: " : "Waiting: ") + w.title : cur.agent.role; })()
    : "Your main agent builds it from what you say";

  return <div className="scr home">
    <div className="home-left">
      <div className="home-main in">
        <Bot state={state} size={150} seed={3} />
        <p className="say">{line}</p>
        <div className="home-chips">
          {pending && <span className="chip blue"><i className="dot" />{pending.suggestions.length} suggested</span>}
          <span className="chip">{todo} task{todo === 1 ? "" : "s"} today</span>
          {snap.focus.running && <span className="chip">Focus round {snap.focus.round}</span>}
          {!online && <span className="chip warn"><i className="dot" />Offline · notes still work</span>}
        </div>
      </div>
      <div className="home-cap" key={i}>
        <b>{name}</b>
        <span className="mute">{about}</span>
        {partners.length > 0 && <span className="home-link">Linked with {partners.length > 1 ? partners.slice(0, -1).join(", ") + " and " + partners.at(-1) : partners[0]}</span>}
      </div>
    </div>

    <div className={"comb-view in in-2" + (menuCell ? " dim" : "")}>
      <svg className="goo-defs" aria-hidden>
        <filter id="goo"><feGaussianBlur in="SourceGraphic" stdDeviation="5" />
          <feColorMatrix values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" /></filter>
      </svg>
      {/* Fused units: a soft silhouette under the circles. The goo filter melts the circles and
          the bar between them into one shape with a pinched neck. */}
      {units.map((u, n) => {
        if (u.length < 2) return null;
        const ks = cells.flatMap((_, k) => group[k] === n ? [k] : []), g = ks.map(geo);
        const tone = (u[0] as Extract<Cell, { kind: "app" }>).tone;
        return <div key={n} className={"goo" + (group[i] === n ? " lit" : "") + (tone ? " toned" : "")} style={{ opacity: Math.min(...g.map(o => o.fade)), ...toneVars(tone) }}>
          {g.map((o, m) => <i key={m} className="blob" style={{ transform: `translate(${o.x - 42}px, ${o.y - 42}px) scale(${o.scale})` }} />)}
          {/* A neck between every two circles that touch, so a cluster melts into one shape. */}
          {g.flatMap((a, m) => g.slice(m + 1).map((b, j) => {
            const len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
            if (len > DX * FUSE * 1.5) return null;
            const thick = 42 * Math.min(a.scale, b.scale);
            return <i key={`b${m}-${j}`} className="bridge" style={{ transform: `translate(${a.x}px, ${a.y}px) rotate(${ang}rad) scale(${len}, ${thick})` }} />;
          }))}
        </div>;
      })}
      {cells.map((c, k) => {
        const { x, y, scale, fade } = geo(k);
        const fused = units[group[k]].length > 1;
        const work = c.kind === "bot" ? workOf(c.agent.id) : undefined;
        const tone = c.kind === "app" || c.kind === "bot" ? c.tone : undefined;
        const needs = (c.kind === "app" && c.fn === "todo" && waiting.length > 0) || (work && work.status !== "running");
        return <div key={keyOf(c)}
          className={"orb" + (k === i ? " sel" : "") + (c.kind === "new" ? " new" : "") + (c.kind === "app" ? " app" : "") + (fused ? " fused" : "") + (fused && group[k] === group[i] ? " lit" : "") + (tone ? " toned" : "")}
          style={{ transform: `translate(${x - 42}px, ${y - 42}px) scale(${scale})`, opacity: fade, zIndex: k === i ? 2 : 1, ...toneVars(tone) }}>
          {c.kind === "app" ? <span className="orb-ico">{c.icon}</span>
            : c.kind === "bot" ? <AgentBot agent={c.agent} size={58} state={moodFor(work)} fps={k === i ? 30 : 10} onTone={c.tone} />
            : <span className="orb-ico">{Ico.plus}</span>}
          {needs && <i className="badge" />}
        </div>;
      })}
    </div>


    {menuCell && <CellMenu key={menu} cell={menuCell.kind === "app" ? { kind: "app", fn: menuCell.fn, icon: menuCell.icon, tone: menuCell.tone } : menuCell} onClose={() => setMenu(null)} />}
    <CommandCenter open={cc} onClose={() => setCc(false)} />
  </div>;
}
