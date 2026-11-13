// Home: the main agent (the white bot) on the left, and one honeycomb on the right that holds
// the apps and the user's bots side by side, laid out like the Apple Watch app grid: round
// icons in rows of 3 and 4 by turns, the selected one centred and full size, the rest
// shrinking toward the edges. The in-app wheel walks every cell left to right, row by row.
// The D-pad moves left/right in that order and up/down to the nearest cell. A opens it.
import { useState, type ReactNode } from "react";
import type { Agent, AppId } from "@app/protocol";
import { Bot } from "../../bot/Bot";
import { useControls, step } from "../../input/controls";
import { useApp, useTalkTarget, FN_LABEL } from "../context";
import { ACTIVE, AgentBot, Ico, moodFor } from "../ui";
import { CommandCenter } from "../CommandCenter";

const APPS: { fn: AppId; icon: ReactNode; about: string }[] = [
  { fn: "notes", icon: Ico.notes, about: "Talk, and the agent files it in the right note" },
  { fn: "todo", icon: Ico.tasks, about: "Today’s tasks" },
  { fn: "agents", icon: Ico.agents, about: "What every bot is doing" },
  { fn: "focus", icon: Ico.focus, about: "Focus timer" },
  { fn: "settings", icon: Ico.settings, about: "Keys, machines, modes" },
];

type Cell =
  | { kind: "app"; fn: AppId; icon: ReactNode; about: string }
  | { kind: "bot"; agent: Agent }
  | { kind: "new" };

// Survives leaving Home, so B brings you back to the cell you opened.
let lastSel = 0;
// Grid pitch and the visible area of the comb (px).
const DX = 92, DY = 80, VIEW_W = 496, VIEW_H = 428, REACH = 250;

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
/** D-pad up/down: the nearest cell in the row above or below (left one on a tie). */
function vertical(i: number, dir: 1 | -1, count: number) {
  const me = place(i);
  let best = -1, bestDx = Infinity;
  for (let k = 0; k < count; k++) {
    const p = place(k);
    if (p.row !== me.row + dir) continue;
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

  // Apps first, then bots, then the cell that makes a new bot.
  const cells: Cell[] = [
    ...APPS.map(a => ({ kind: "app" as const, ...a })),
    ...snap.agents.map(agent => ({ kind: "bot" as const, agent })),
    { kind: "new" },
  ];
  const [cc, setCc] = useState(false);
  const [sel, setSelState] = useState(lastSel);
  const setSel = (n: number) => { lastSel = n; setSelState(n); };
  const i = Math.min(sel, cells.length - 1);
  const cur = cells[i];

  const workOf = (id: string) => active.find(t => t.agentId === id);

  useControls(e => {
    if (e.c === "up" || e.c === "down") {
      const v = vertical(i, e.c === "up" ? -1 : 1, cells.length);
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
    if (e.c === "d" && cur.kind === "app") { push({ name: "appAgents", app: cur.fn }); return true; }
    if (e.c === "d" && pending) { push({ name: "suggest", noteId: pending.id }); return true; }
    // C opens the command center. Only Home does this; apps leave C to themselves.
    if (e.c === "c") { setCc(true); return true; }
    return false;
  }, {
    a: cur.kind === "new" ? "New bot" : "Open",
    d: cur.kind === "app" ? "Manage agents" : pending ? "Suggestions" : undefined,
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

    <div className="comb-view in in-2">
      {cells.map((c, k) => {
        // Scroll so the selected row is in the middle, then shrink by distance from the
        // selected cell (fisheye).
        const p = place(k), x = p.x, y = p.y - me.y + VIEW_H / 2;
        // Sideways distance counts for less, so a whole row stays readable.
        const d = Math.hypot((x - me.x) * 0.45, y - VIEW_H / 2) / REACH;
        const scale = k === i ? 1 : Math.max(0.2, 0.86 - d * d * 0.55);
        const fade = Math.max(0, Math.min(1, 1.6 - d));
        const work = c.kind === "bot" ? workOf(c.agent.id) : undefined;
        const needs = (c.kind === "app" && c.fn === "todo" && waiting.length > 0) || (work && work.status !== "running");
        return <div key={c.kind === "bot" ? c.agent.id : c.kind === "app" ? c.fn : "new"}
          className={"orb" + (k === i ? " sel" : "") + (c.kind === "new" ? " new" : "") + (c.kind === "app" ? " app" : "")}
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
    </div>

    <CommandCenter open={cc} onClose={() => setCc(false)} />
  </div>;
}
