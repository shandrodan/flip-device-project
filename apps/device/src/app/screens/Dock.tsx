import type { Snapshot } from "@app/protocol";
import { Bot } from "../../bot/Bot";
import { useControls } from "../../input/controls";
import { net } from "../../net/client";
import { useApp } from "../context";
import { AgentBot, ago, mmss, moodFor, useTick } from "../ui";

// Dock mode: the companion screen beside the desktop (SHAPE.md, APPS.md).
export function Dock() {
  const { snap } = useApp();
  useControls(e => {
    if (e.c === "a" && snap.limits.back) { net.send({ type: "limits.ack" }); return true; }
    return false;
  }, { a: snap.limits.back ? "Got it" : undefined, wheel: undefined });
  return <DockGrid snap={snap} />;
}

/** Shared by the docked Device and the /dock page. */
export function DockGrid({ snap }: { snap: Snapshot }) {
  useTick(1000);
  const f = snap.focus;
  const left = f.running && f.endsAt ? Math.max(0, Date.parse(f.endsAt) - Date.now()) : f.lengthMs;
  const l = snap.limits;
  const resetIn = l.resetAt ? Math.max(0, Date.parse(l.resetAt) - Date.now()) : 0;
  const open = snap.tasks.filter(t => t.status !== "done");
  const busy = open.filter(t => t.agentId && t.status === "running").length;
  return <div className="fill" style={{ padding: "44px 18px 40px", display: "grid", gridTemplateColumns: "1.15fr 1fr", gridTemplateRows: "1fr 1fr", gap: 12 }}>
    <div className="card in" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", position: "relative" }}>
      <div className="label">{f.running ? (f.kind === "break" ? "Break" : `Focus · round ${f.round}`) : `Focus · ready for round ${f.round}`}</div>
      <div style={{ position: "absolute", right: 10, top: 6 }}><Bot size={70} seed={3} state={f.running ? "sleep" : "idle"} fps={30} /></div>
      <div className="tnum" style={{ font: "600 84px/0.9 var(--rounded)", letterSpacing: "-0.04em" }}>{mmss(left)}</div>
    </div>
    <div className="card in in-2" style={{ overflow: "hidden" }}>
      <div className="label">Today · {open.length} open</div>
      {open.slice(0, 5).map(t => {
        const ag = snap.agents.find(a => a.id === t.agentId);
        return <div key={t.id} style={{ fontSize: 14.5, padding: "5px 0", display: "flex", gap: 8, alignItems: "center" }}>
          {ag ? <AgentBot agent={ag} size={20} state={moodFor(t)} /> : <span className="check" style={{ width: 16, height: 16 }} />}
          <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.title}</span>
        </div>;
      })}
      {!open.length && <div className="mute" style={{ fontSize: 14, paddingTop: 6 }}>Nothing left. Nice.</div>}
    </div>
    <div className="card in in-2" style={{ display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div className="label">{l.back ? "Claude limits" : l.resetAt ? "Claude limits reset in" : "Claude limits"}</div>
      {l.back ? <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Bot size={56} seed={5} state="happy" fps={30} /><b style={{ fontSize: 26, letterSpacing: "-0.02em" }}>They’re back.</b></div>
        : l.resetAt ? <div className="tnum" style={{ font: "600 46px/1.1 var(--rounded)" }}>{resetIn > 3600e3 ? `${Math.floor(resetIn / 3600e3)}h ${Math.ceil((resetIn % 3600e3) / 6e4)}m` : `${Math.ceil(resetIn / 6e4)} min`}</div>
        : <div className="mute" style={{ fontSize: 15, lineHeight: 1.4 }}>No window running. Run the PC agent where you use Claude Code, or start one in Settings.</div>}
      {l.source === "claude-code" && !l.back && <div className="mute" style={{ fontSize: 12 }}>From Claude Code on {l.machine}</div>}
    </div>
    <div className="card in in-3" style={{ overflow: "hidden" }}>
      <div className="label" style={{ marginBottom: 2 }}>Agents{busy ? ` · ${busy} working` : ""}</div>
      {snap.activity.slice(0, 5).map((x, i) => {
        const ag = snap.agents.find(a => a.id === x.agentId);
        return <div key={i} style={{ display: "flex", gap: 8, fontSize: 13.5, padding: "4px 0", alignItems: "center" }}>
          {ag && <AgentBot agent={ag} size={18} />}<span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{x.text}</span><span className="mute">{ago(x.at)}</span>
        </div>;
      })}
    </div>
  </div>;
}
