// Home: the main agent (the white bot) on the left, and one honeycomb on the right that holds
// the apps and the user's bots side by side, laid out like the Apple Watch app grid: round
// icons in rows of 3 and 4 by turns, the selected one centred and full size, the rest
// shrinking toward the edges. The in-app wheel walks every cell left to right, row by row.
// The D-pad moves left/right in that order and up/down to the nearest cell. A opens it.
// An app that has its own bots sits fused to them (two circles merged with a neck), so you see
// at a glance which bot belongs to which app. Each circle is still its own cell.
// Blue D on an app or a bot opens its menu over the left column (ADR 0017).
import { useState, type ReactNode } from "react";
import type { Agent, AppId } from "@app/protocol";
import { Bot } from "../../bot/Bot";
import { useControls, step } from "../../input/controls";
import { useApp, useTalkTarget, FN_LABEL } from "../context";
import { ACTIVE, AgentBot, Ico, moodFor } from "../ui";
import { CommandCenter } from "../CommandCenter";
import { CellMenu } from "../CellMenu";

const APPS: { fn: AppId; icon: ReactNode; about: string }[] = [
  { fn: "notes", icon: Ico.notes, about: "Talk, and the agent files it in the right note" },
  { fn: "todo", icon: Ico.tasks, about: "Today’s tasks" },
  { fn: "agents", icon: Ico.agents, about: "What every bot is doing" },
  { fn: "focus", icon: Ico.focus, about: "Focus timer" },
  { fn: "settings", icon: Ico.settings, about: "Keys, machines, modes" },
];

/** Bots that belong to an app besides its assigned Task agents (snapshot.appAgents). All of them
 *  sit fused to the app on the comb instead of with the other bots. */
const APP_BOTS: Partial<Record<AppId, string[]>> = {
  notes: ["main"], // the main agent hears every dump and files it in the right note
};

type Cell =
  | { kind: "app"; fn: AppId; icon: ReactNode; about: string }
  | { kind: "bot"; agent: Agent }
  | { kind: "new" }
  /** An empty slot at the end of a row, left so a fused unit starts on the next row whole. */
  | { kind: "gap" };

// Survives leaving Home, so B brings you back to the cell you opened.
let lastSel = 0;
// Grid pitch and the visible area of the comb (px).
const DX = 92, DY = 80, VIEW_W = 496, VIEW_H = 428, REACH = 250;
// How far apart fused circles sit, as a share of the normal pitch (92px → ~64px: they overlap).
const FUSE = 0.7;

// Honeycomb rows alternate 3 and 4 cells: 3, 4, 3, 4… Each row of 3 sits in the gaps of the
// rows of 4 around it, so every 7 cells make one row pair.
const SHORT = 3, LONG = 4, PAIR = SHORT + LONG;
const LEFT = (VIEW_W - (LONG - 1) * DX) / 2;
function place(k: number) {
  const pair = Math.floor(k / PAIR), rem = k % PAIR;
  const short = rem < SHORT;
  const row = pair * 2 + (short ? 0 : 1), col = short ? rem : rem - SHORT;
  return { row, x: LEFT + col * DX + (short ? DX / 2 : 0), y: row * DY };
}
/** How many cells are left in the row that cell k starts. */
function rowLeft(k: number) {
  const rem = k % PAIR;
  return rem < SHORT ? SHORT - rem : PAIR - rem;
}
/** Lay out units (an app with its bots, or a lone cell) in order, but never split a fused unit
 *  across rows: if one doesn't fit, the next lone cell that fits fills the row first. If nothing
 *  fits, the rest of the row stays empty and the unit starts the next row. Only a unit longer
 *  than a whole row is split. */
function arrange(units: Cell[][]) {
  const out: Cell[][] = [], queue = [...units];
  let k = 0;
  while (queue.length) {
    const left = rowLeft(k), fresh = left === (k % PAIR < SHORT ? SHORT : LONG);
    let j = queue.findIndex(u => u.length <= left);
    if (j < 0 && !fresh) {
      for (let n = 0; n < left; n++) out.push([{ kind: "gap" }]);
      k += left;
      continue;
    }
    if (j < 0) j = 0;
    const [u] = queue.splice(j, 1);
    out.push(u);
    k += u.length;
  }
  return out;
}

/** D-pad up/down: the nearest cell in the row above or below (left one on a tie). */
function vertical(i: number, dir: 1 | -1, count: number, skip: (k: number) => boolean) {
  const me = place(i);
  let best = -1, bestDx = Infinity;
  for (let k = 0; k < count; k++) {
    const p = place(k);
    if (p.row !== me.row + dir || skip(k)) continue;
    const dx = Math.abs(p.x - me.x);
    if (dx < bestDx - 0.5) { best = k; bestDx = dx; }
  }
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

  // Apps first (each fused with its own bots), then the other bots, then the cell that makes
  // a new bot. group[k] is the index of the fused unit cell k belongs to.
  // An app's bots: the fixed ones above, then every Task agent assigned to it, so adding an
  // agent to an app on the Device links it on the comb straight away.
  const botsOf = (fn: AppId) => [...new Set([...(APP_BOTS[fn] ?? []), ...snap.appAgents[fn]])];
  const linked = new Set(APPS.flatMap(a => botsOf(a.fn)));
  const units = arrange([
    ...APPS.map(a => [
      { kind: "app" as const, ...a },
      ...botsOf(a.fn).flatMap(id => snap.agents.filter(g => g.id === id)).map(agent => ({ kind: "bot" as const, agent })),
    ]),
    ...snap.agents.filter(g => !linked.has(g.id)).map(agent => [{ kind: "bot" as const, agent }]),
  ]);
  units.push([{ kind: "new" }]);
  const cells: Cell[] = units.flat();
  const group = units.flatMap((u, n) => u.map(() => n));
  const [cc, setCc] = useState(false);
  // The open cell menu, by cell key, so it follows the cell if the comb reorders.
  const [menu, setMenu] = useState<string | null>(null);
  const [sel, setSelState] = useState(lastSel);
  const setSel = (n: number) => { lastSel = n; setSelState(n); };
  const gap = (k: number) => cells[k]?.kind === "gap";
  // Gaps are never selected (and never sit last, where the New bot cell is).
  let i = Math.min(sel, cells.length - 1);
  while (gap(i)) i++;
  const cur = cells[i] as Exclude<Cell, { kind: "gap" }>;

  const workOf = (id: string) => active.find(t => t.agentId === id);
  const keyOf = (c: Cell, k = 0) => c.kind === "bot" ? c.agent.id : c.kind === "app" ? c.fn : c.kind === "gap" ? "gap" + k : "new";
  const menuCell = menu ? cells.find((c): c is Extract<Cell, { kind: "app" | "bot" }> => (c.kind === "app" || c.kind === "bot") && keyOf(c) === menu) : undefined;

  useControls(e => {
    if (e.c === "up" || e.c === "down") {
      const v = vertical(i, e.c === "up" ? -1 : 1, cells.length, gap);
      if (v !== null) setSel(v);
      return true;
    }
    let n = step(i, e, cells.length, { dpad: "horizontal" });
    while (n !== null && gap(n)) n = step(n, e, cells.length, { dpad: "horizontal" });
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
  const me = place(i);
  /** Where cell k sits and how big it is: scroll so the selected row is in the middle, then
   *  shrink by distance from the selected cell (fisheye). */
  const geo = (k: number) => {
    const p = place(k), x = p.x, y = p.y - me.y + VIEW_H / 2;
    // Sideways distance counts for less, so a whole row stays readable.
    const d = Math.hypot((x - me.x) * 0.45, y - VIEW_H / 2) / REACH;
    // Fused cells are pulled toward their unit's centre so the circles overlap, like drops
    // that ran into each other.
    const ks = cells.flatMap((_, j) => group[j] === group[k] ? [j] : []);
    const cx = ks.reduce((s, j) => s + place(j).x, 0) / ks.length;
    const cy = ks.reduce((s, j) => s + place(j).y, 0) / ks.length - me.y + VIEW_H / 2;
    const fx = cx + (x - cx) * FUSE, fy = cy + (y - cy) * FUSE;
    return { x: fx, y: fy, scale: k === i ? 1 : Math.max(0.2, 0.86 - d * d * 0.55), fade: Math.max(0, Math.min(1, 1.6 - d)) };
  };
  const partners = units[group[i]].filter(c => c !== cur)
    .map(c => c.kind === "app" ? FN_LABEL[c.fn] : c.kind === "bot" ? c.agent.name : "");

  const name = cur.kind === "app" ? FN_LABEL[cur.fn] : cur.kind === "bot" ? cur.agent.name : "New bot";
  const about = cur.kind === "app" ? `${cur.about} · ${snap.appAgents[cur.fn].map(id => snap.agents.find(agent => agent.id === id)?.name ?? "Unavailable").join(", ")}`
    : cur.kind === "bot" ? (() => { const w = workOf(cur.agent.id); return w ? (w.status === "running" ? "Working: " : "Waiting: ") + w.title : cur.agent.role; })()
    : "Your main agent builds it from what you say";

  return <div className="scr home">
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
        return <div key={n} className={"goo" + (group[i] === n ? " lit" : "")} style={{ opacity: Math.min(...g.map(o => o.fade)) }}>
          {g.map((o, m) => <i key={m} className="blob" style={{ transform: `translate(${o.x - 42}px, ${o.y - 42}px) scale(${o.scale})` }} />)}
          {g.slice(1).map((b, m) => {
            const a = g[m], len = Math.hypot(b.x - a.x, b.y - a.y), ang = Math.atan2(b.y - a.y, b.x - a.x);
            const thick = 42 * Math.min(a.scale, b.scale);
            return <i key={"b" + m} className="bridge" style={{ transform: `translate(${a.x}px, ${a.y}px) rotate(${ang}rad) scale(${len}, ${thick})` }} />;
          })}
        </div>;
      })}
      {cells.map((c, k) => {
        if (c.kind === "gap") return null;
        const { x, y, scale, fade } = geo(k);
        const fused = units[group[k]].length > 1;
        const work = c.kind === "bot" ? workOf(c.agent.id) : undefined;
        const needs = (c.kind === "app" && c.fn === "todo" && waiting.length > 0) || (work && work.status !== "running");
        return <div key={keyOf(c)}
          className={"orb" + (k === i ? " sel" : "") + (c.kind === "new" ? " new" : "") + (c.kind === "app" ? " app" : "") + (fused ? " fused" : "") + (fused && group[k] === group[i] ? " lit" : "")}
          style={{ transform: `translate(${x - 42}px, ${y - 42}px) scale(${scale})`, opacity: fade, zIndex: k === i ? 2 : 1 }}>
          {c.kind === "app" ? <span className="orb-ico">{c.icon}</span>
            : c.kind === "bot" ? <AgentBot agent={c.agent} size={58} state={moodFor(work)} fps={k === i ? 30 : 10} />
            : <span className="orb-ico">{Ico.plus}</span>}
          {needs && <i className="badge" />}
        </div>;
      })}
    </div>

    <div className="home-cap" key={i}>
      <b>{name}</b>
      <span className="mute">{about}</span>
      {partners.length > 0 && <span className="home-link">Linked with {partners.join(" and ")}</span>}
    </div>

    {menuCell && <CellMenu key={menu} cell={menuCell.kind === "app" ? { kind: "app", fn: menuCell.fn, icon: menuCell.icon } : menuCell} onClose={() => setMenu(null)} />}
    <CommandCenter open={cc} onClose={() => setCc(false)} />
  </div>;
}
