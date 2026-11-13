import { useState } from "react";
import type { AgentPurpose, AgentShape } from "@app/protocol";
import { RISK_LABEL } from "@app/protocol";
import { Bot, BudScene, SHAPE_KEYS } from "../../bot/Bot";
import { useControls, step } from "../../input/controls";
import { net } from "../../net/client";
import { useApp, useTalkTarget } from "../context";
import { ACTIVE, AgentBot, ago, Ico, moodFor, statusChip, useScrollSel } from "../ui";

// device-controls.md, Active Agents mode: the screen shows agent status by itself.
// D-pad picks an agent (A opens it), X makes a new one. The in-app wheel does nothing here.
export function Agents() {
  const { snap, push } = useApp();
  const items = snap.agents.length + 1;
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, items - 1);
  useScrollSel(i);
  useControls(e => {
    if (e.c === "appWheel") return true;
    const n = step(i, e, items, { wheel: false, dpad: "grid", cols: 4 });
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a") { push(i < snap.agents.length ? { name: "agent", agentId: snap.agents[i].id } : { name: "create" }); return true; }
    if (e.c === "x") { push({ name: "create" }); return true; }
    return false;
  }, { dpad: "Pick", a: i < snap.agents.length ? "Open" : "New agent", x: "New agent" });

  const busy = snap.tasks.filter(t => t.agentId && ACTIVE.includes(t.status)).length;
  return <div className="scr">
    <p className="h1 in">Agents</p>
    <div className="mute in" style={{ fontSize: 14 }}>{busy ? `${busy} working now` : "All quiet"} · {snap.services.llm === "claude" ? "Claude" : "built-in planner"}</div>
    <div className="scroll in in-2" style={{ position: "absolute", left: 14, right: 28, top: 104, bottom: 40, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, alignContent: "start", padding: 2 }}>
      {snap.agents.map((a, k) => {
        const work = snap.tasks.find(t => t.agentId === a.id && ACTIVE.includes(t.status));
        return <div key={a.id} className={"agent-card" + (k === i ? " sel" : "")}>
          <div style={{ alignSelf: "center", margin: "2px 0 6px" }}><AgentBot agent={a} size={84} state={moodFor(work)} /></div>
          <b style={{ fontSize: 15, letterSpacing: "-0.01em" }}>{a.name}</b>
          <span className="mute" style={{ fontSize: 12.5, lineHeight: 1.35, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {work ? (work.status === "running" ? "Working: " : "Waiting: ") + work.title : a.role}
          </span>
        </div>;
      })}
      <div className={"agent-card new" + (i === snap.agents.length ? " sel" : "")} style={{ minHeight: 170 }}>
        <span style={{ color: "rgba(255,255,255,0.7)" }}>{Ico.plus}</span><b style={{ fontSize: 15 }}>New agent</b><span className="mute" style={{ fontSize: 12.5 }}>Made by your main agent</span>
      </div>
    </div>
  </div>;
}

export function AgentView({ id }: { id: string }) {
  const { snap, push } = useApp();
  const a = snap.agents.find(x => x.id === id);
  const work = snap.tasks.find(t => t.agentId === id && ACTIVE.includes(t.status));
  useControls(e => {
    if (!a) return false;
    if (e.c === "a" && work) { push({ name: "task", taskId: work.id }); return true; }
    if (e.c === "y" && !a.builtin) { net.send({ type: "agent.delete", agentId: a.id }); return true; }
    return false;
  }, { a: work ? "Open task" : undefined, y: a && !a.builtin ? "Delete agent" : undefined });
  if (!a) return <div className="scr"><p className="say">That agent is gone.</p></div>;
  const done = snap.tasks.filter(t => t.agentId === a.id && t.status === "done").length;
  const acts = snap.activity.filter(x => x.agentId === a.id).slice(0, 4);
  const mode = snap.settings.permissionMode;
  const asks = mode === "manual" ? ["Every step"] : mode === "full" ? ["Nothing, Full mode is on"] : Object.values(RISK_LABEL);
  const fresh = Date.now() - Date.parse(snap.activity.find(x => x.text === `Made ${a.name}`)?.at || "0") < 4000;
  return <div className="scr">
    <div style={{ position: "absolute", left: 20, top: 92 }}><AgentBot agent={a} size={230} state={fresh ? "happy" : moodFor(work)} morphFrom={fresh ? "circle" : undefined} /></div>
    <div style={{ position: "absolute", left: 286, right: 28, top: 56 }}>
      <p className="say in" style={{ fontSize: 30 }}>{a.name}</p>
      <p className="mute in" style={{ margin: "6px 0 14px", fontSize: 15 }}>{a.role}</p>
      <div className="in in-2"><div className="label" style={{ marginBottom: 6 }}>Asks you before</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{asks.map(x => <span key={x} className="chip warn">{x}</span>)}</div></div>
      <div className="in in-3" style={{ marginTop: 16 }}>
        <div className="label" style={{ marginBottom: 2 }}>{work ? "Working on" : `${done} task${done === 1 ? "" : "s"} done`}</div>
        {work && <div className="row sel"><span style={{ flex: 1 }}>{work.title}</span>{statusChip(work, snap)}</div>}
        {acts.map((x, k) => <div key={k} style={{ display: "flex", gap: 10, fontSize: 14, padding: "4px 0" }}><span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.text}</span><span className="mute">{ago(x.at)}</span></div>)}
      </div>
    </div>
  </div>;
}

/* ------------------------------ Create ------------------------------ */
const COLORS = ["#4a9dff", "#a78bfa", "#ff6eb4", "#ffd60a", "#64d2ff", "#34d17a", "#ff9f0a", "#8e8e93"];
const PURPOSES: { k: AgentPurpose; label: string; name: string; shape: AgentShape; color: string; role: string }[] = [
  { k: "research", label: "Research the web", name: "Research agent", shape: "cloud", color: "#ff6eb4", role: "Searches the web and writes you a short summary." },
  { k: "writer", label: "Write things for me", name: "Writer", shape: "drop", color: "#64d2ff", role: "Writes docs and drafts into files on your machine." },
  { k: "files", label: "Keep my folders tidy", name: "Tidy agent", shape: "hexagon", color: "#ffd60a", role: "Keeps your folders tidy. Asks before it deletes." },
  { k: "custom", label: "Something else", name: "New agent", shape: "pebble", color: "#34d17a", role: "Does what you tell it. Asks before anything risky." },
];
const NAME_IDEAS = ["Scout", "Juniper", "Echo", "Pixel", "Maple"];

export function Create() {
  const { back, snap } = useApp();
  const [stage, setStage] = useState(0);
  const [p, setP] = useState(0);
  const [shape, setShape] = useState<AgentShape>("pebble");
  const [color, setColor] = useState(COLORS[5]);
  const [names, setNames] = useState<string[]>([]);
  const [ni, setNi] = useState(0);
  const purpose = PURPOSES[p];
  const name = names[ni] || purpose.name;
  useTalkTarget(stage === 2 ? { kind: "name", onText: t => { if (t) { setNames(n => [t, ...n.filter(x => x !== t)]); setNi(0); } } } : null, [stage]);

  const made = () => net.send({ type: "agent.create", agent: { name, purpose: purpose.k, shape, color } });

  useControls(e => {
    if (stage === 3) return true;
    if (e.c === "b") { if (stage) setStage(stage - 1); else back(); return true; }
    if (stage === 0) {
      const n = step(p, e, PURPOSES.length);
      if (n !== null) { setP(n); return true; }
      if (e.c === "a") {
        setShape(purpose.shape); setColor(purpose.color);
        setNames([purpose.name, ...NAME_IDEAS.filter(x => !snap.agents.some(a => a.name === x))]); setNi(0);
        setStage(1);
        return true;
      }
    } else if (stage === 1) {
      const si = SHAPE_KEYS.indexOf(shape);
      const n = step(si, e, SHAPE_KEYS.length, { wheel: false, dpad: "grid", cols: 5 });
      if (n !== null) { setShape(SHAPE_KEYS[n]); return true; }
      if (e.c === "appWheel") { const c = COLORS.indexOf(color); setColor(COLORS[(c + (e.dir || 1) + COLORS.length) % COLORS.length]); return true; }
      if (e.c === "a") { setStage(2); return true; }
    } else if (stage === 2) {
      const n = step(ni, e, names.length);
      if (n !== null) { setNi(n); return true; }
      if (e.c === "a") { setStage(3); return true; }
    }
    return false;
  }, stage === 0 ? { wheel: "Choose", a: "Next", b: "Cancel" }
    : stage === 1 ? { dpad: "Body", wheel: "Colour", a: "Next", b: "Back" }
    : stage === 2 ? { mic: "Say a name", wheel: "Pick a name", a: "Make it", b: "Back" } : {});

  if (stage === 3) return <div className="fill">
    <BudScene color={color} onDone={made} />
    <p className="say in" style={{ position: "absolute", left: 0, right: 0, bottom: 50, textAlign: "center", fontSize: 24 }}>Making {name}…</p>
  </div>;

  const Q = ({ children }: { children: string }) => <div className="in" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}><Bot size={42} seed={3} state="idle" fps={30} /><p className="say" style={{ fontSize: 24 }}>{children}</p></div>;
  return <div className="scr">
    <div style={{ position: "absolute", left: 18, top: 90, width: 250, display: "grid", placeItems: "center" }}>
      {stage === 0 ? <Bot size={210} seed={3} state="wide" /> : <Bot size={220} shape={shape} color={color} seed={77} state={stage === 2 ? "happy" : "idle"} />}
    </div>
    <div style={{ position: "absolute", left: 290, right: 28, top: 52 }}>
      {stage === 0 && <><Q>What should your new agent do?</Q>
        <div className="in in-2" style={{ display: "grid", gap: 8 }}>{PURPOSES.map((x, k) => <div key={x.k} className={"card" + (k === p ? " sel" : "")} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
          <span style={{ flex: 1 }}><b>{x.label}</b><br /><span className="mute" style={{ fontSize: 13 }}>{x.role}</span></span>{k === p && Ico.arrow}</div>)}</div></>}
      {stage === 1 && <><Q>Pick a body and a colour.</Q>
        <div className="in in-2" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
          {SHAPE_KEYS.map(k => <div key={k} className={"shape-pick" + (shape === k ? " on" : "")}><Bot size={54} shape={k} color={color} seed={k.length * 7} state="idle" fps={20} /></div>)}
        </div>
        <div className="in in-3" style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>{COLORS.map(c => <span key={c} className={"swatch" + (color === c ? " on" : "")} style={{ background: c }} />)}</div></>}
      {stage === 2 && <><Q>What should I call it?</Q>
        <div className="in in-2" style={{ display: "grid", gap: 6 }}>{names.slice(0, 5).map((x, k) => <div key={x} className={"row" + (k === ni ? " sel" : "")} style={{ fontSize: 18, fontWeight: 600 }}>{x}</div>)}</div>
        <p className="mute in in-3" style={{ fontSize: 14, margin: "12px 0 0" }}>Or hold the mic and say a name. {purpose.role}</p></>}
    </div>
  </div>;
}
