import { useState } from "react";
import type { AgentPurpose, AgentShape, AppId } from "@app/protocol";
import { AGENT_NAME_MAX, APP_IDS, RISK_LABEL, minAppAgents } from "@app/protocol";
import { Bot, BudScene, SHAPE_KEYS } from "../../bot/Bot";
import { useControls, step, type ControlEvent } from "../../input/controls";
import { net } from "../../net/client";
import { FN_LABEL, useApp, useTalkTarget } from "../context";
import { ACTIVE, AgentBot, ago, Ico, moodFor, statusChip, useScrollSel } from "../ui";
import { TextEntry } from "../TextEntry";

// device-controls.md, Active Agents mode: the screen shows agent status by itself.
// D-pad or the in-app wheel picks an agent (A opens it), D makes a new one.
export function Agents() {
  const { snap, push } = useApp();
  useTalkTarget({ kind: "app", app: "agents" }, []);
  const items = snap.agents.length + 1;
  const [sel, setSel] = useState(0);
  const i = Math.min(sel, items - 1);
  useScrollSel(i);
  useControls(e => {
    const n = step(i, e, items, { dpad: "grid", cols: 4 });
    if (n !== null) { setSel(n); return true; }
    if (e.c === "a") { push(i < snap.agents.length ? { name: "agent", agentId: snap.agents[i].id } : { name: "create" }); return true; }
    if (e.c === "d") { push({ name: "create" }); return true; }
    return false;
  }, { wheel: "Pick", dpad: "Pick", a: i < snap.agents.length ? "Open" : "New agent", d: "New agent" });

  const busy = snap.tasks.filter(t => t.agentId && ACTIVE.includes(t.status)).length;
  return <div className="scr">
    <p className="h1 in">Agents</p>
    <div className="mute in" style={{ fontSize: 14 }}>{busy ? `${busy} working now` : "All quiet"} · {snap.services.llm === "openrouter" ? "OpenRouter" : snap.services.llm === "claude" ? "Claude" : "built-in planner"}</div>
    <div className="scroll in in-2" style={{ position: "absolute", left: 28, right: 28, top: 104, bottom: 40, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, alignContent: "start", padding: 2 }}>
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
  const ownedApp = APP_IDS.find(app => snap.appAgents[app].includes(id));
  useTalkTarget(a ? { kind: "agent", agentId: a.id } : null, [a?.id]);
  const work = snap.tasks.find(t => t.agentId === id && ACTIVE.includes(t.status));
  useControls(e => {
    if (!a) return false;
    if (e.c === "a" && work) { push({ name: "task", taskId: work.id }); return true; }
    if (e.c === "c" && (!a.builtin || a.purpose === "app") && !ownedApp) { net.send({ type: "agent.delete", agentId: a.id }); return true; }
    return false;
  }, { a: work ? "Open task" : undefined, c: a && (!a.builtin || a.purpose === "app") && !ownedApp ? "Delete agent" : undefined });
  if (!a) return <div className="scr"><p className="say">That agent is gone.</p></div>;
  const done = snap.tasks.filter(t => t.agentId === a.id && t.status === "done").length;
  const acts = snap.activity.filter(x => x.agentId === a.id).slice(0, 2);
  const messages = (snap.messages ?? []).filter(x => x.fromAgentId === a.id || x.toAgentId === a.id).slice(-40).reverse();
  const mode = snap.settings.permissionMode;
  const asks = mode === "manual" ? ["Every step"] : mode === "full" ? ["Nothing, Full mode is on"] : Object.values(RISK_LABEL);
  const fresh = Date.now() - Date.parse(snap.activity.find(x => x.text === `Made ${a.name}`)?.at || "0") < 4000;
  return <div className="scr">
    <div style={{ position: "absolute", left: 20, top: 92 }}><AgentBot agent={a} size={230} state={fresh ? "happy" : moodFor(work)} morphFrom={fresh ? "circle" : undefined} /></div>
    <div style={{ position: "absolute", left: 286, right: 28, top: 56, bottom: 40, display: "flex", flexDirection: "column" }}>
      <p className="say in" style={{ fontSize: 30 }}>{a.name}</p>
      <p className="mute in" style={{ margin: "6px 0 14px", fontSize: 15 }}>{a.role}</p>
      {a.personality && <p className="in" style={{ margin: "-6px 0 14px", fontSize: 14, color: "rgba(235,235,245,0.8)" }}>“{a.personality}”</p>}
      {ownedApp && <p className="mute in" style={{ margin: "0 0 12px", fontSize: 13 }}>Works in {FN_LABEL[ownedApp]}. Press blue D on the app on Home to manage its agents.</p>}
      <div className="in in-2"><div className="label" style={{ marginBottom: 6 }}>Asks you before</div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{asks.map(x => <span key={x} className="chip warn">{x}</span>)}</div></div>
      <div className="in in-3" style={{ marginTop: 16, minHeight: 0, display: "flex", flexDirection: "column", flex: 1 }}>
        <div className="label" style={{ marginBottom: 2 }}>{work ? "Working on" : `${done} task${done === 1 ? "" : "s"} done`}</div>
        {work && <div className="row sel"><span style={{ flex: 1 }}>{work.title}</span>{statusChip(work, snap)}</div>}
        {acts.map((x, k) => <div key={k} style={{ display: "flex", gap: 10, fontSize: 14, padding: "4px 0" }}><span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.text}</span><span className="mute">{ago(x.at)}</span></div>)}
        <div className="label" style={{ marginTop: 12 }}>Recent messages · hold the mic to talk</div>
        <div className="scroll" style={{ minHeight: 0, flex: 1, overflowY: "auto" }}>
          {messages.map(message => <div key={message.id} className="row" style={{ fontSize: 13, display: "block", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>
            <b>{message.fromAgentId === "user" ? "You" : snap.agents.find(agent => agent.id === message.fromAgentId)?.name ?? "Task agent"}: </b>{message.text}
          </div>)}
        </div>
      </div>
    </div>
  </div>;
}

/** `start` opens straight at one action (from the Home cell menu, ADR 0017); B at its first step goes back. */
export function AppAgentManager({ app, start }: { app: AppId; start?: "add" | "change" | "delete" }) {
  const { snap, push, back, online, toast } = useApp();
  const firstPhase = !start ? "menu" : start === "add" ? "candidate" : "member";
  const [phase, setPhase] = useState<"menu" | "member" | "candidate">(firstPhase);
  const [action, setAction] = useState<"add" | "change" | "delete">(start ?? "add");
  const [oldAgentId, setOldAgentId] = useState("");
  const [sel, setSel] = useState(0);
  const members = snap.appAgents[app].map(id => snap.agents.find(agent => agent.id === id)).filter((agent): agent is NonNullable<typeof agent> => !!agent);
  const free = snap.agents.filter(agent => agent.id !== "main" && !APP_IDS.some(other => snap.appAgents[other].includes(agent.id)));
  const count = phase === "menu" ? 3 : phase === "member" ? members.length : free.length + (action === "add" ? 1 : 0);
  const index = Math.min(sel, Math.max(0, count - 1));
  const choosePhase = (next: typeof phase) => { setSel(0); setPhase(next); };
  const finish = () => start ? back() : choosePhase("menu");
  useControls(e => {
    if (e.c === "b" && start && phase === firstPhase) { back(); return true; }
    if (e.c === "b" && phase !== "menu") { choosePhase(phase === "candidate" && action === "change" ? "member" : "menu"); return true; }
    const n = step(index, e, count);
    if (n !== null) { setSel(n); return true; }
    if (e.c !== "a") return false;
    if (phase === "menu") {
      const next = (["add", "change", "delete"] as const)[index];
      setAction(next);
      const min = minAppAgents(app);
      if (next !== "add" && !members.length) { toast("No agent here yet. Main agent does the work. Add one first."); return true; }
      if (next === "delete" && members.length <= min) { toast("Add or choose a replacement before deleting the last app agent."); return true; }
      choosePhase(next === "add" ? "candidate" : "member");
      return true;
    }
    if (phase === "member") {
      const member = members[index];
      if (!member) return true;
      if (action === "delete") {
        if (!online) { toast("Connect to the server to delete an agent."); return true; }
        net.send({ type: "agent.delete", agentId: member.id });
        finish();
      } else { setOldAgentId(member.id); choosePhase("candidate"); }
      return true;
    }
    if (action === "add" && index === free.length) { push({ name: "create", app }); return true; }
    const candidate = free[index];
    if (!candidate) return true;
    if (!online) { toast("Connect to the server to assign an agent."); return true; }
    if (action === "add") net.send({ type: "app.agent.add", app, agentId: candidate.id });
    else net.send({ type: "app.agent.replace", app, oldAgentId, newAgentId: candidate.id });
    finish();
    return true;
  }, { wheel: "Pick", a: "Choose", b: "Back" });

  const title = phase === "menu" ? `${FN_LABEL[app]} agents` : phase === "member" ? `${action === "delete" ? "Delete" : "Change"} which agent?` : action === "add" ? "Add which agent?" : "Choose a replacement";
  return <div className="scr">
    <p className="h1 in">{title}</p>
    <div className="mute in">{members.length ? `${members.map(agent => agent.name).join(", ")} · ${members.length} assigned` : "None assigned · Main agent does the work"}</div>
    <div className="scroll in in-2" style={{ position: "absolute", left: 28, right: 28, top: 104, bottom: 40 }}>
      {phase === "menu" ? [
        ["Add agent", "Assign a free agent or make a new one."],
        ["Change agent", "Replace one agent. Keep the old agent in your list."],
        ["Delete agent", !members.length ? "No agent to delete." : members.length <= minAppAgents(app) ? "Add or choose a replacement first." : members.length === 1 ? "Delete it after your approval. Main agent takes over." : "Delete one agent after your approval."],
      ].map(([label, detail], k) => <div key={label} className={"row" + (k === index ? " sel" : "")} style={{ display: "block", opacity: (k === 1 && !members.length) || (k === 2 && members.length <= minAppAgents(app)) ? 0.55 : 1 }}><b>{label}</b><div className="mute">{detail}</div></div>)
        : phase === "member" ? members.map((agent, k) => <div key={agent.id} className={"row" + (k === index ? " sel" : "")}><AgentBot agent={agent} size={38} state="idle" /><span><b>{agent.name}</b><br /><span className="mute">{agent.role}</span></span></div>)
          : <>{free.map((agent, k) => <div key={agent.id} className={"row" + (k === index ? " sel" : "")}><AgentBot agent={agent} size={38} state="idle" /><span><b>{agent.name}</b><br /><span className="mute">{agent.role}</span></span></div>)}
            {action === "add" && <div className={"row" + (index === free.length ? " sel" : "")}><span>{Ico.plus}</span><b>Make a new agent</b></div>}
            {action === "change" && !free.length && <div className="mute">No free agent. Add a new agent first.</div>}</>}
    </div>
  </div>;
}

/* ------------------------------ Create ------------------------------ */
export const COLORS = ["#4a9dff", "#a78bfa", "#ff6eb4", "#ffd60a", "#64d2ff", "#34d17a", "#ff9f0a", "#8e8e93"];
const PURPOSES: { k: AgentPurpose; label: string; name: string; shape: AgentShape; color: string; role: string }[] = [
  { k: "research", label: "Research the web", name: "Research agent", shape: "cloud", color: "#ff6eb4", role: "Searches the web and writes you a short summary." },
  { k: "writer", label: "Write things for me", name: "Writer", shape: "drop", color: "#64d2ff", role: "Writes docs and drafts into files on your machine." },
  { k: "files", label: "Keep my folders tidy", name: "Tidy agent", shape: "hexagon", color: "#ffd60a", role: "Keeps your folders tidy. Asks before it deletes." },
  { k: "custom", label: "Something else", name: "New agent", shape: "pebble", color: "#34d17a", role: "Does what you tell it. Asks before anything risky." },
];
const NAME_IDEAS = ["Scout", "Juniper", "Echo", "Pixel", "Maple"];

/** Body and colour picker, shared by Create and Look. D-pad picks the body, the in-app wheel the colour. */
function LookPicker({ shape, color, colors }: { shape: AgentShape; color: string; colors: string[] }) {
  return <>
    <div className="in in-2" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
      {SHAPE_KEYS.map(k => <div key={k} className={"shape-pick" + (shape === k ? " on" : "")}><Bot size={54} shape={k} color={color} seed={k.length * 7} state="idle" fps={20} /></div>)}
    </div>
    <div className="in in-3" style={{ display: "flex", gap: 10, marginTop: 16, alignItems: "center" }}>{colors.map(c => <span key={c} className={"swatch" + (color === c ? " on" : "")} style={{ background: c }} />)}</div>
  </>;
}
/** Handle a control for LookPicker. Returns the new look, or null when the control isn't for it. */
function lookStep(e: ControlEvent, shape: AgentShape, color: string, colors: string[]): { shape: AgentShape; color: string } | null {
  const n = step(SHAPE_KEYS.indexOf(shape), e, SHAPE_KEYS.length, { wheel: false, dpad: "grid", cols: 5 });
  if (n !== null) return { shape: SHAPE_KEYS[n], color };
  if (e.c === "appWheel") { const c = colors.indexOf(color); return { shape, color: colors[(c + (e.dir || 1) + colors.length) % colors.length] }; }
  return null;
}

const Q = ({ children }: { children: string }) => <div className="in" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 14 }}><Bot size={42} seed={3} state="idle" fps={30} /><p className="say" style={{ fontSize: 24 }}>{children}</p></div>;

/** Look (ADR 0017): change a Task agent's body and colour from the Home cell menu. */
export function AgentLook({ id }: { id: string }) {
  const { snap, back, online, toast } = useApp();
  const a = snap.agents.find(x => x.id === id);
  const [shape, setShape] = useState<AgentShape>(a?.shape ?? "pebble");
  const [color, setColor] = useState(a?.color ?? COLORS[0]);
  const colors = !a || COLORS.includes(a.color) ? COLORS : [a.color, ...COLORS];
  useControls(e => {
    if (!a) return false;
    const next = lookStep(e, shape, color, colors);
    if (next) { setShape(next.shape); setColor(next.color); return true; }
    if (e.c === "a") {
      if (!online) { toast("Connect to the server to change an agent."); return true; }
      if (shape !== a.shape || color !== a.color) net.send({ type: "agent.update", agentId: a.id, patch: { shape, color } });
      back();
      return true;
    }
    return false;
  }, a ? { dpad: "Body", wheel: "Colour", a: "Save", b: "Cancel" } : null);
  if (!a) return <div className="scr"><p className="say">That agent is gone.</p></div>;
  return <div className="scr">
    <div style={{ position: "absolute", left: 18, top: 90, width: 250, display: "grid", placeItems: "center" }}>
      <Bot size={220} shape={shape} color={color} seed={a.seed} state="happy" morphFrom={a.shape} />
    </div>
    <div style={{ position: "absolute", left: 290, right: 28, top: 52 }}>
      <Q>{`A new look for ${a.name}.`}</Q>
      <LookPicker shape={shape} color={color} colors={colors} />
    </div>
  </div>;
}

export function Create({ app }: { app?: AppId }) {
  const { back, snap } = useApp();
  const [stage, setStage] = useState(0);
  const [p, setP] = useState(0);
  const [shape, setShape] = useState<AgentShape>("pebble");
  const [color, setColor] = useState(COLORS[5]);
  const [names, setNames] = useState<string[]>([]);
  const [ni, setNi] = useState(0);
  const purpose = PURPOSES[p];
  const name = names[ni] || purpose.name;
  const [typing, setTyping] = useState(false);
  const addName = (t: string) => { if (t) { setNames(n => [t, ...n.filter(x => x !== t)]); setNi(0); } };
  useTalkTarget(stage === 2 ? { kind: "text", purpose: "name", label: "Say a name", onText: addName } : null, [stage]);

  const made = () => net.send({ type: "agent.create", agent: { name, purpose: purpose.k, shape, color }, app });

  useControls(e => {
    if (stage === 3) return true;
    if (stage === 2 && e.c === "c") { setTyping(true); return true; }
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
      const next = lookStep(e, shape, color, COLORS);
      if (next) { setShape(next.shape); setColor(next.color); return true; }
      if (e.c === "a") { setStage(2); return true; }
    } else if (stage === 2) {
      const n = step(ni, e, names.length);
      if (n !== null) { setNi(n); return true; }
      if (e.c === "a") { setStage(3); return true; }
    }
    return false;
  }, stage === 0 ? { wheel: "Choose", a: "Next", b: "Cancel" }
    : stage === 1 ? { dpad: "Body", wheel: "Colour", a: "Next", b: "Back" }
    : stage === 2 ? { mic: "Say a name", wheel: "Pick a name", cue: ["mic"], a: "Make it", b: "Back", c: "Keyboard" } : {}, !typing);

  if (stage === 3) return <div className="fill">
    <BudScene color={color} onDone={made} />
    <p className="say in" style={{ position: "absolute", left: 0, right: 0, bottom: 50, textAlign: "center", fontSize: 24 }}>Making {name}…</p>
  </div>;

  return <div className="scr">
    <div style={{ position: "absolute", left: 18, top: 90, width: 250, display: "grid", placeItems: "center" }}>
      {stage === 0 ? <Bot size={210} seed={3} state="wide" /> : <Bot size={220} shape={shape} color={color} seed={77} state={stage === 2 ? "happy" : "idle"} />}
    </div>
    <div style={{ position: "absolute", left: 290, right: 28, top: 52 }}>
      {stage === 0 && <><Q>What should your new agent do?</Q>
        <div className="in in-2" style={{ display: "grid", gap: 8 }}>{PURPOSES.map((x, k) => <div key={x.k} className={"card" + (k === p ? " sel" : "")} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px" }}>
          <span style={{ flex: 1 }}><b>{x.label}</b><br /><span className="mute" style={{ fontSize: 13 }}>{x.role}</span></span>{k === p && Ico.arrow}</div>)}</div></>}
      {stage === 1 && <><Q>Pick a body and a colour.</Q><LookPicker shape={shape} color={color} colors={COLORS} /></>}
      {stage === 2 && <><Q>What should I call it?</Q>
        <div className="in in-2" style={{ display: "grid", gap: 6 }}>{names.slice(0, 5).map((x, k) => <div key={x} className={"row" + (k === ni ? " sel" : "")} style={{ fontSize: 18, fontWeight: 600 }}>{x}</div>)}</div>
        <p className="mute in in-3" style={{ fontSize: 14, margin: "12px 0 0" }}>Or hold the mic and say a name, or press C to type one. {purpose.role}</p></>}
    </div>
    {typing && <TextEntry title="Name your agent" initial="" max={AGENT_NAME_MAX} purpose="name" placeholder="Type a name" keyboard
      onSave={t => { addName(t); setTyping(false); }} onCancel={() => setTyping(false)} />}
  </div>;
}
