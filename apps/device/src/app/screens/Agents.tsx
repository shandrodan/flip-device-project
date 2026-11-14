import { useEffect, useRef, useState } from "react";
import type { AgentPurpose, AgentShape, AppId, Task } from "@app/protocol";
import { AGENT_NAME_MAX, APP_IDS, minAppAgents } from "@app/protocol";
import { Bot, BudScene, SHAPE_KEYS } from "../../bot/Bot";
import { useControls, step, type ControlEvent } from "../../input/controls";
import { net } from "../../net/client";
import { FN_LABEL, useApp, useTalkTarget } from "../context";
import { ACTIVE, AgentBot, Ico, moodFor, useScrollSel } from "../ui";
import { TextEntry } from "../TextEntry";
import { useTalkLive } from "../talkLevel";

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
    <div className="mute in" style={{ fontSize: 14 }}>{busy ? `${busy} working now` : "All quiet"} · {snap.services.llm === "openrouter" ? "OpenRouter" : snap.services.llm === "claude" ? "Claude" : snap.services.llm === "planner" ? "Demo planner" : "AI key required"}</div>
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
  const live = useTalkLive();
  const talking = live?.agentId === id ? live : null;
  const work = snap.tasks.find(t => t.agentId === id && ACTIVE.includes(t.status));
  // The thread under the bot: the newest request this agent got, newest first in the list.
  const task = work ?? snap.tasks.find(t => t.agentId === id && t.target === "agent");
  const thread = useRef<HTMLDivElement>(null);
  useEffect(() => { thread.current?.scrollTo({ top: 0 }); }, [task?.id]);
  useControls(e => {
    if (!a) return false;
    if ((e.c === "up" || e.c === "down") && thread.current) { thread.current.scrollBy({ top: e.c === "up" ? -70 : 70, behavior: "smooth" }); return true; }
    if (e.c === "a" && work) { push({ name: "task", taskId: work.id }); return true; }
    if (e.c === "c" && (!a.builtin || a.purpose === "app") && !ownedApp) { net.send({ type: "agent.delete", agentId: a.id }); return true; }
    return false;
  }, { mic: "Hold to talk", dpad: task ? "Scroll" : undefined, a: work ? "Open task" : undefined, c: a && (!a.builtin || a.purpose === "app") && !ownedApp ? "Delete agent" : undefined });
  if (!a) return <div className="scr"><p className="say">That agent is gone.</p></div>;
  const fresh = Date.now() - Date.parse(snap.activity.find(x => x.text === `Made ${a.name}`)?.at || "0") < 4000;
  const state = talking ? (talking.phase === "listen" ? "listen" : "think") : fresh ? "happy" : moodFor(work);
  const pulse = talking?.phase === "listen" ? 1 + Math.min(1, talking.level) * 0.14 : 1;
  const big = !task || !!talking;
  return <div className="scr agent-view">
    <p className="label in agent-view-name">{a.name}{ownedApp ? ` · ${FN_LABEL[ownedApp]}` : ""}</p>
    <div className={"agent-view-bot" + (big ? " big" : "")} style={{ transform: `scale(${pulse.toFixed(3)})` }}>
      <AgentBot agent={a} size={big ? 200 : 132} state={state} morphFrom={fresh ? "circle" : undefined} />
    </div>
    {!task && !talking && <p className="mute in agent-view-hint">Hold the mic and talk to {a.name}.</p>}
    {task && !talking && <div ref={thread} className="scroll agent-thread in in-2"><Thread task={task} /></div>}
  </div>;
}

/** What a finished task said, for the screen. An app request's raw data (JSON, IDs) is for the
 *  agent that asked; the screen shows only its short summary. */
function answerOf(t: Task) {
  if (!t.appRequest) return t.result || t.detail;
  return t.detail && !/^\s*[[{]/.test(t.detail) ? t.detail : undefined;
}

/** One request, what the agent did for it, and its answer. */
function Thread({ task }: { task: Task }) {
  const { snap } = useApp();
  const request = snap.messages?.find(m => m.id === task.requestMessageId);
  const from = request && request.fromAgentId !== "user" ? snap.agents.find(x => x.id === request.fromAgentId) : undefined;
  const asked = snap.tasks.filter(t => t.sourceTaskId === task.id).reverse();
  const output = task.status === "done" ? answerOf(task) : undefined;
  const failed = task.status === "failed" || task.status === "paused" ? task.detail : undefined;
  return <>
    <div className="thread-row ask">
      {from ? <AgentBot agent={from} size={22} state="idle" fps={20} /> : <span className="thread-you">You</span>}
      <span>{from ? <><b>{from.name}</b> asked: </> : null}{request?.text ?? task.title}</span>
    </div>
    {task.steps.map(s => <div key={s.id} className={"thread-row step " + s.state}>
      <span className="thread-dot">{s.state === "done" ? Ico.check(11) : s.state === "failed" || s.state === "declined" ? "×" : ""}</span>
      <span>{s.text}</span>
    </div>)}
    {asked.map(t => {
      const who = snap.agents.find(x => x.id === t.agentId);
      return <div key={t.id} className={"thread-row step " + (t.status === "done" ? "done" : t.status === "failed" ? "failed" : "running")}>
        {who ? <AgentBot agent={who} size={22} state={moodFor(t)} fps={20} /> : <span className="thread-dot" />}
        <span>Asked <b>{who?.name ?? "Task agent"}</b>{t.status === "done" && answerOf(t) ? <span className="mute"> · {answerOf(t)}</span> : null}</span>
      </div>;
    })}
    {ACTIVE.includes(task.status) && !task.steps.some(s => s.state === "running") && <div className="thread-row step running"><span className="thread-dot" /><span className="mute">{task.status === "queued" ? "Waiting for a slot…" : "Thinking…"}</span></div>}
    {output && <p className="thread-out">{output}</p>}
    {failed && <p className="thread-out failed">{failed}</p>}
    {!output && !failed && task.status === "done" && <p className="thread-out mute">Done.</p>}
  </>;
}

/** `start` opens straight at one action (from the Home cell menu, ADR 0017); B at its first step goes back. */
export function AppAgentManager({ app, start }: { app: AppId; start?: "add" | "change" | "remove" | "delete" }) {
  const { snap, push, back, online, toast } = useApp();
  const firstPhase = !start ? "menu" : start === "add" ? "candidate" : "member";
  const [phase, setPhase] = useState<"menu" | "member" | "candidate">(firstPhase);
  const [action, setAction] = useState<"add" | "change" | "remove" | "delete">(start ?? "add");
  const [oldAgentId, setOldAgentId] = useState("");
  const [sel, setSel] = useState(0);
  const members = snap.appAgents[app].map(id => snap.agents.find(agent => agent.id === id)).filter((agent): agent is NonNullable<typeof agent> => !!agent);
  const free = snap.agents.filter(agent => agent.id !== "main" && !APP_IDS.some(other => snap.appAgents[other].includes(agent.id)));
  const count = phase === "menu" ? 4 : phase === "member" ? members.length : free.length + (action === "add" ? 1 : 0);
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
      const next = (["add", "change", "remove", "delete"] as const)[index];
      setAction(next);
      const min = minAppAgents(app);
      if (next !== "add" && !members.length) { toast("No agent here yet. Omni does the work. Add one first."); return true; }
      if (next === "delete" && members.length <= min) { toast("Add or choose a replacement before deleting the last app agent."); return true; }
      if (next === "remove" && members.length <= min) { toast("Add another agent before disconnecting the last one."); return true; }
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
      } else if (action === "remove") {
        if (!online) { toast("Connect to the server to disconnect an agent."); return true; }
        net.send({ type: "app.agent.remove", app, agentId: member.id });
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

  const title = phase === "menu" ? `${FN_LABEL[app]} agents` : phase === "member" ? `${action === "delete" ? "Delete" : action === "remove" ? "Disconnect" : "Change"} which agent?` : action === "add" ? "Add which agent?" : "Choose a replacement";
  return <div className="scr">
    <p className="h1 in">{title}</p>
    <div className="mute in">{members.length ? `${members.map(agent => agent.name).join(", ")} · ${members.length} assigned` : "None assigned · Omni does the work"}</div>
    <div className="scroll in in-2" style={{ position: "absolute", left: 28, right: 28, top: 104, bottom: 40 }}>
      {phase === "menu" ? [
        ["Add agent", "Assign a free agent or make a new one."],
        ["Change agent", "Replace one agent. Keep the old agent in your list."],
        ["Disconnect agent", !members.length ? "No agent to disconnect." : members.length <= minAppAgents(app) ? "Add another agent first." : members.length === 1 ? "Keep it in your list. Omni takes over." : "Keep it in your list, free for another app."],
        ["Delete agent", !members.length ? "No agent to delete." : members.length <= minAppAgents(app) ? "Add or choose a replacement first." : members.length === 1 ? "Delete it after your approval. Omni takes over." : "Delete one agent after your approval."],
      ].map(([label, detail], k) => <div key={label} className={"row" + (k === index ? " sel" : "")} style={{ display: "block", opacity: (k === 1 && !members.length) || (k >= 2 && members.length <= minAppAgents(app)) ? 0.55 : 1 }}><b>{label}</b><div className="mute">{detail}</div></div>)
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
