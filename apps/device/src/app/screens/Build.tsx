// Build (ADR 0021): build a web app by talking. A black sidebar on the left holds the agent that
// does the work, centred, with one line under it. The rest of the screen is the live preview of the
// project's dev server, wrapped in a caution-tape stroke that sits on the screen edge and marches
// while the agent works. Holding the mic widens the sidebar (the preview slides right) and shows
// what you say. The agent is Build's own Task agent, or the main agent while Build has none.
import { useEffect, useRef, useState } from "react";
import type { Agent, Task } from "@app/protocol";
import { Bot, type BotState } from "../../bot/Bot";
import { useControls } from "../../input/controls";
import { net } from "../../net/client";
import { startCapture, blobToBase64, nextBuildSample, type Capture, type VoiceSource } from "../../voice/capture";
import { useApp } from "../context";
import { appOfBot, botColor } from "../tone";
import { moodFor, useTick } from "../ui";
import "./build.css";

type Phase = "listen" | "think" | "miss";
interface Dict { phase: Phase; heard: string }

const ACTIVE: Task["status"][] = ["queued", "running", "waiting", "awaiting-approval", "held"];
/** How long a finished task's answer stays under the bot. */
const SHOW_DONE_MS = 8000;
const IDLE_LINE = "What should we build?";

/** Who does Build's work: the agent on the task in hand, else Build's first agent, else main. */
function servingAgent(agents: Agent[], members: string[], task?: Task): Agent | undefined {
  const id = task && task.agentId && (members.includes(task.agentId) || (!members.length && task.agentId === "main")) ? task.agentId : members[0] ?? "main";
  return agents.find(a => a.id === id) ?? agents.find(a => a.id === "main");
}

export function Build() {
  const { snap, online, voice, toast } = useApp();
  const build = snap.build;
  useTick(2000); // lets a finished answer fade back to the idle line

  /* ---------- The task in hand: the one this screen sent, else the newest Build task ---------- */
  const [taskId, setTaskId] = useState<string | null>(null);
  const task = (taskId && snap.tasks.find(t => t.id === taskId)) || snap.tasks.find(t => t.app === "build");
  const active = !!task && ACTIVE.includes(task.status);
  const recent = !!task && !active && Date.now() - Date.parse(task.completedAt ?? task.updatedAt) < SHOW_DONE_MS;
  const agent = servingAgent(snap.agents, snap.appAgents.build, task);

  /* ---------- Dictation ---------- */
  const [dict, setDict] = useState<Dict | null>(null);
  const [level, setLevel] = useState(0);
  const cap = useRef<Capture | null>(null);
  const streamId = useRef("");
  const streaming = useRef(false);
  const released = useRef(false);
  const alive = useRef(true);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };

  const close = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (cap.current) {
      cap.current.cancel();
      cap.current = null;
      if (streaming.current) net.send({ type: "voice.cancel", streamId: streamId.current });
    }
    setDict(null);
    setLevel(0);
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; close(); }; }, []);
  useEffect(() => {
    if (dict?.phase !== "listen") return;
    const id = setInterval(() => cap.current && setLevel(cap.current.level()), 90);
    return () => clearInterval(id);
  }, [dict?.phase]);

  // The server answers a request with the task it made, or says why it can't.
  useEffect(() => net.on(m => {
    if (m.type === "voice.accepted" && m.streamId === streamId.current) { setTaskId(m.taskId); close(); }
    if (m.type === "voice.rejected" && m.streamId === streamId.current) close();
  }), []);

  const miss = () => { setDict({ phase: "miss", heard: "" }); later(close, 1800); };

  const start = () => {
    close();
    if (!online) { toast("Connect to the server to build."); return; }
    released.current = false;
    streaming.current = false;
    streamId.current = "vs_" + Math.random().toString(36).slice(2, 10);
    setDict({ phase: "listen", heard: "" });
    const sid = streamId.current;
    const begin = async (source: VoiceSource) => {
      try {
        const c = await startCapture(source, {
          purpose: "note",
          line: source === "script" ? nextBuildSample() : undefined,
          onPartial: t => alive.current && sid === streamId.current && setDict(d => (d && d.phase === "listen" ? { ...d, heard: t } : d)),
          onChunk: async b => {
            if (streaming.current && sid === streamId.current) net.send({ type: "voice.chunk", streamId: sid, audio: await blobToBase64(b) });
          },
        });
        if (!alive.current || sid !== streamId.current) return c.cancel();
        cap.current = c;
        if (c.source === "mic") streaming.current = net.send({ type: "voice.start", streamId: sid, mime: c.mime, target: { kind: "app", app: "build" } });
        if (released.current) void finish();
      } catch {
        if (source === "mic") { toast("No microphone access. Using the scripted voice."); return begin("script"); }
        close();
      }
    };
    void begin(voice);
  };

  const finish = async () => {
    released.current = true;
    const c = cap.current;
    if (!c) return; // still starting; begin() calls finish once ready
    cap.current = null;
    setLevel(0);
    const r = await c.stop();
    const heard = r.hint.trim().replace(/…$/, "");
    if (r.durationMs < 600 || (!heard && c.source === "script")) {
      if (streaming.current) net.send({ type: "voice.cancel", streamId: streamId.current });
      return miss();
    }
    setDict({ phase: "think", heard });
    if (c.source === "mic" && streaming.current) net.send({ type: "voice.end", streamId: streamId.current, durationMs: r.durationMs, hint: heard || undefined });
    else if (heard) net.send({ type: "voice.scripted", streamId: streamId.current, text: heard, cloudText: r.cloudText, durationMs: r.durationMs, target: { kind: "app", app: "build" } });
    else return miss();
    later(close, 9000); // the server is slow: let go of the screen, the task still shows up
  };

  /* ---------- Controls ---------- */
  const [reload, setReload] = useState(0);
  const listening = dict?.phase === "listen";
  useControls(e => {
    if (e.c === "mic") {
      if (e.phase === "down" && !dict) start();
      if (e.phase === "up" && listening) void finish();
      return true;
    }
    if (e.c === "a" && !dict && build?.previewUrl) { setReload(n => n + 1); return true; }
    if (e.c === "b" && dict?.phase === "miss") { close(); return true; }
    return false; // B goes back Home, the system wheel switches apps
  }, { cue: listening ? ["mic"] : [], mic: listening ? "Release to send" : "Hold to talk", a: build?.previewUrl && !dict ? "Reload" : undefined });

  /* ---------- What the sidebar says ---------- */
  let mood: BotState = "idle", line: JSX.Element | string = IDLE_LINE;
  if (dict?.phase === "listen") {
    mood = "listen";
    line = dict.heard ? <span className="bd-said">“{dict.heard}”</span> : <><i className="bd-live" />Listening</>;
  } else if (dict?.phase === "think") {
    mood = "think";
    line = <span className="bd-said dim">“{dict.heard}”</span>;
  } else if (dict?.phase === "miss") {
    mood = "sad";
    line = <span className="bd-wait">Didn’t catch that</span>;
  } else if (task && active) {
    mood = moodFor(task);
    const step = task.steps[task.steps.length - 1];
    line = task.status === "awaiting-approval" || task.status === "held" ? <><span className="bd-ask">{step?.text ?? task.title}</span><i className="bd-bar" />Waiting for your press</>
      : task.status === "queued" ? "Waiting for a free slot…"
      : task.status === "waiting" ? "Waiting for another agent…"
      : step ? `${step.text}…` : "Starting…";
  } else if (task && recent) {
    mood = task.status === "done" ? "happy" : "sad";
    line = task.detail ?? (task.status === "done" ? "Done" : "That didn’t work");
  } else if (!build?.previewUrl) {
    line = "Say what to build. It shows up on the right.";
  }

  const color = agent ? botColor(agent, appOfBot(snap, agent.id)) : "#f2f2f2";
  return <div className={"bd" + (listening ? " listening" : "") + (active && task?.status !== "awaiting-approval" && task?.status !== "held" ? " working" : "")}>
    <aside className="bd-side">
      <div className="bd-stage">
        <div className="bd-bot">{agent && <Bot key={agent.id} shape={agent.shape} color={color} seed={agent.seed} size={120} state={mood} level={listening ? level : 0} />}</div>
        <div className="bd-line" aria-live="polite">{line}</div>
      </div>
      <div className="bd-hint"><i className="bd-mic" /><span><b>Hold mic</b> to talk</span></div>
    </aside>

    <section className="bd-preview">
      <div className="bd-page">
        {build?.previewUrl
          ? <iframe key={`${build.previewUrl}#${build.rev}#${reload}`} src={build.previewUrl} title={`${build.name} preview`} tabIndex={-1} sandbox="allow-scripts allow-forms" />
          : <div className="bd-empty"><b>No preview yet</b><span>{build ? `${build.name} · ${build.dir}` : "Update the server to use Build."}</span></div>}
      </div>
      <Tape />
    </section>
  </div>;
}

/** The caution-tape stroke: rounded on the left, following the screen's corners on the right.
 *  It is centred on the edge of the page, so all 5px of it show and no page shows past it. */
function Tape() {
  const w = 784 - 216, h = 504, o = 2.5, rl = 22 - o, rr = 16 - o;
  const d = `M${o + rl} ${o}H${w - o - rr}A${rr} ${rr} 0 0 1 ${w - o} ${o + rr}V${h - o - rr}A${rr} ${rr} 0 0 1 ${w - o - rr} ${h - o}`
    + `H${o + rl}A${rl} ${rl} 0 0 1 ${o} ${h - o - rl}V${o + rl}A${rl} ${rl} 0 0 1 ${o + rl} ${o}Z`;
  return <svg className="bd-tape" viewBox={`0 0 ${w} ${h}`} aria-hidden="true"><path className="y" d={d} /><path className="k" d={d} /></svg>;
}
