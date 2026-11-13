// The Device screen (784 × 504). Non-touch: the system wheel switches functions, the rest of
// the controls act inside the function on screen (device-controls.md, ADR 0007).
import { useEffect, useMemo, useRef, useState } from "react";
import { Bot } from "../bot/Bot";
import { useControls, LAYER } from "../input/controls";
import { useNet, net } from "../net/client";
import { defaultSource, nextSample, type VoiceSource } from "../voice/capture";
import { Ctx, DOCK_FNS, HANDHELD_FNS, type AppCtx, type Fn, type Route, type TalkTarget } from "./context";
import { FireOverlay, Hud, SoftApproval, TalkOverlay } from "./overlays";
import { HintBar, Ico, useTick } from "./ui";
import { Home } from "./screens/Home";
import { Suggest } from "./screens/Suggest";
import { TaskView } from "./screens/TaskView";
import { Notes } from "./screens/Notes";
import { NoteView } from "./screens/NoteView";
import { Todo } from "./screens/Todo";
import { Agents, AgentLook, AgentView, AppAgentManager, Create } from "./screens/Agents";
import { Focus } from "./screens/Focus";
import { Settings } from "./screens/Settings";
import { Dock } from "./screens/Dock";
import { Onboarding } from "./screens/Onboarding";

const ONBOARDING_KEY = "flip-device-onboarding-v1";

function needsOnboarding() {
  try { return localStorage.getItem(ONBOARDING_KEY) !== "done"; }
  catch { return true; }
}

export function DeviceApp({ voice = defaultSource(), onWantPush }: { voice?: VoiceSource; onWantPush?: (w: boolean) => void }) {
  const n = useNet();
  const snap = n.snap;
  const docked = n.mode === "dock";
  const fns = docked ? DOCK_FNS : HANDHELD_FNS;
  const [fn, setFn] = useState<Fn>(docked ? "dock" : "home");
  const [stack, setStack] = useState<Route[]>([]);
  const [toastMsg, setToast] = useState<{ text: string; k: number } | null>(null);
  const [hud, setHud] = useState(0);
  const [talk, setTalk] = useState<{ target: TalkTarget; sample: number } | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(needsOnboarding);
  // Who the mic talks to: the newest registered target wins (see useTalkTarget).
  const talkTargets = useRef<{ t: TalkTarget | null }[]>([]);
  useTick(15000);

  // Docking switches the function set.
  useEffect(() => { setFn(docked ? "dock" : "home"); setStack([]); }, [docked]);

  const toast = (text: string) => setToast({ text, k: Date.now() });
  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toastMsg?.k]);

  // Server events: notices become toasts; a synced offline note takes over its local route.
  useEffect(() => net.on(m => {
    if (m.type === "notice") toast(m.text);
    if (m.type === "error") toast(m.message);
    if (m.type === "voice.rejected") toast(m.reason);
    if (m.type === "note.saved" && m.localId) setStack(s => s.map(r => (r.name === "suggest" && r.noteId === "local:" + m.localId ? { name: "suggest", noteId: m.note.id } : r)));
    if (m.type === "agent.created") setStack(s => [...s.filter(r => r.name !== "create"), { name: "agent", agentId: m.agentId }]);
  }), []);

  const route = stack[stack.length - 1] || null;
  const finishOnboarding = () => {
    try { localStorage.setItem(ONBOARDING_KEY, "done"); } catch { /* Storage can be unavailable. */ }
    setShowOnboarding(false);
  };
  const ctx: AppCtx | null = snap ? {
    snap,
    online: n.online,
    docked,
    fn,
    route,
    go: f => { setFn(f); setStack([]); },
    push: r => setStack(s => [...s, r]),
    replace: r => setStack(s => [...s.slice(0, -1), r]),
    back: () => setStack(s => s.slice(0, -1)),
    toast,
    voice,
    addTalkTarget: t => {
      const entry = { t };
      talkTargets.current.push(entry);
      return () => { talkTargets.current = talkTargets.current.filter(x => x !== entry); };
    },
  } : null;

  // Bottom of the control stack: what works everywhere.
  useControls(e => {
    if (e.c === "systemWheel") {
      const i = fns.indexOf(fn);
      const next = fns[(((i < 0 ? 0 : i) + (e.dir || 1)) % fns.length + fns.length) % fns.length];
      setFn(next);
      setStack([]);
      setHud(Date.now());
      return true;
    }
    if (e.c === "mic" && e.phase === "down") {
      if (!snap) return true;
      if (!talk) setTalk({ target: talkTargets.current[talkTargets.current.length - 1]?.t || { kind: "note" }, sample: nextSample() });
      return true;
    }
    if (e.c === "b") {
      if (stack.length) setStack(s => s.slice(0, -1));
      else if (fn !== fns[0]) setFn(fns[0]);
      return true;
    }
    return false;
  }, { mic: "Hold to talk", b: stack.length || fn !== fns[0] ? "Back" : undefined }, true, LAYER.global);

  useEffect(() => {
    if (!hud) return;
    const t = setTimeout(() => setHud(0), 900);
    return () => clearTimeout(t);
  }, [hud]);

  const fire = snap?.approvals.find(a => !a.held && a.kind === "risky") || null;
  const soft = snap?.approvals.find(a => !a.held && a.kind === "step") || null;
  useEffect(() => { onWantPush?.(!!fire || !!soft); }, [!!fire, !!soft]);

  const needs = !!snap?.tasks.some(t => t.status === "held" || t.status === "paused" || t.status === "failed");
  const icons = useMemo<Record<Fn, JSX.Element>>(() => ({
    home: <Bot size={30} seed={3} state={needs ? "wide" : "idle"} fps={20} />,
    notes: Ico.notes, todo: Ico.tasks, agents: Ico.agents, focus: Ico.focus, settings: Ico.settings, dock: Ico.dock,
  }), [needs]);

  if (!snap || !ctx) return <Connecting />;

  let screen: JSX.Element;
  if (showOnboarding && !docked) screen = <Onboarding onDone={finishOnboarding} />;
  else if (route?.name === "suggest") screen = <Suggest key={route.noteId} id={route.noteId} />;
  else if (route?.name === "task") screen = <TaskView key={route.taskId} id={route.taskId} />;
  else if (route?.name === "note") screen = <NoteView key={route.noteId} id={route.noteId} />;
  else if (route?.name === "agent") screen = <AgentView key={route.agentId} id={route.agentId} />;
  else if (route?.name === "appAgents") screen = <AppAgentManager key={route.app + (route.start ?? "")} app={route.app} start={route.start} />;
  else if (route?.name === "agentLook") screen = <AgentLook key={route.agentId} id={route.agentId} />;
  else if (route?.name === "create") screen = <Create app={route.app} />;
  else if (fn === "home") screen = <Home />;
  else if (fn === "notes") screen = <Notes />;
  else if (fn === "todo") screen = <Todo />;
  else if (fn === "agents") screen = <Agents />;
  else if (fn === "focus") screen = <Focus />;
  else if (fn === "settings") screen = <Settings onOpenOnboarding={() => setShowOnboarding(true)} />;
  else screen = <Dock />;

  const fullBleed = fn === "dock" && !route;
  // Notes and To-Do are light apps with their own status bar inside their header (ADR 0011, 0016).
  const light = (fn === "notes" || fn === "todo") && !route;
  const focusLeft = snap.focus.running && snap.focus.endsAt ? Math.max(0, Date.parse(snap.focus.endsAt) - Date.now()) : 0;
  return <Ctx.Provider value={ctx}>
    <div className="fill" style={{ ["--ink" as string]: fire ? "#000" : "#fff" }}>
      {!light && <div className="status">
        <span><Clock /></span>
        <span>
          {!n.online && <><i className="off-dot" />Offline</>}
          {snap.focus.running && <span className="tnum">{snap.focus.kind === "break" ? "Break" : "Focus"} {Math.ceil(focusLeft / 60000)}m</span>}
          {docked && "Docked"}
          <span className={"batt" + (docked ? " charge" : "")}><i /></span>
        </span>
      </div>}
      <div className={"main" + (fullBleed ? " full" : "")} data-fn={fn} data-route={route?.name ?? ""}>{screen}</div>
      <HintBar ink={!!fire || light} />
      {hud > 0 && <Hud fns={fns} fn={fn} icons={icons} />}
      {soft && !fire && <SoftApproval req={soft} />}
      <FireOverlay req={fire} onWant={() => {}} />
      {talk && <TalkOverlay target={talk.target} sample={talk.sample} onDone={() => setTalk(null)} />}
      {toastMsg && <div className="toast" key={toastMsg.k}>{toastMsg.text}</div>}
    </div>
  </Ctx.Provider>;
}

function Clock() {
  useTick(10000);
  return <span className="tnum">{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>;
}

function Connecting() {
  const n = useNet();
  return <div className="fill" style={{ display: "grid", placeItems: "center", textAlign: "center" }}>
    <div>
      <div style={{ display: "grid", placeItems: "center" }}><Bot size={160} seed={3} state={n.conn === "offline" ? "sad" : "think"} /></div>
      <p className="say" style={{ fontSize: 24, marginTop: 18 }}>{n.conn === "offline" ? "Can’t reach the server" : "Connecting…"}</p>
      <p className="mute" style={{ fontSize: 13.5, marginTop: 6 }}>{net.url}</p>
      {n.conn === "offline" && <p className="mute" style={{ fontSize: 13.5 }}>Start it with <b>pnpm dev</b>. Notes you dump now are kept on the Device.</p>}
    </div>
  </div>;
}
