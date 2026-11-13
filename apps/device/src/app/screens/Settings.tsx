import { useState, type ReactNode } from "react";
import type { Hosting, PermissionMode } from "@app/protocol";
import { RISK_LABEL } from "@app/protocol";
import { useControls, step } from "../../input/controls";
import { net } from "../../net/client";
import { useApp } from "../context";
import { useScrollSel } from "../ui";

const MODES: [PermissionMode, string, string][] = [
  ["manual", "Manual", "Every action waits for your press."],
  ["auto", "Auto", "I decide when to ask. The risky ones always ask."],
  ["full", "Full", "Runs without asking. Your own VM or sandbox only."],
];
const HOSTS: [Hosting, string][] = [["cloud", "Our cloud"], ["vm", "Own VM"], ["self", "Self-hosted"]];

interface Row { key: string; label: string; value: ReactNode; hint?: string; act?: (dir: number) => void; a?: string }

export function Settings() {
  const { snap, toast, online } = useApp();
  const st = snap.settings;
  const [sel, setSel] = useState(0);
  const [armed, setArmed] = useState(0);
  const cycle = <T,>(list: T[], cur: T, dir: number) => list[(list.indexOf(cur) + dir + list.length) % list.length];

  const rows: Row[] = [
    {
      key: "mode", label: "Permission mode", a: "Change",
      value: <div className="seg" style={{ width: 260 }}>{MODES.map(([k, n]) => <span key={k} className={(st.permissionMode === k ? "on" : "") + (k === "full" && st.hosting === "cloud" ? " no" : "")}>{n}</span>)}</div>,
      hint: MODES.find(m => m[0] === st.permissionMode)![2] + (st.permissionMode !== "full" ? ` Always asks: ${Object.values(RISK_LABEL).join(", ").toLowerCase()}.` : ""),
      act: dir => {
        let next = cycle(MODES.map(m => m[0]), st.permissionMode, dir);
        if (next === "full" && st.hosting === "cloud") { toast("Full mode needs your own VM or self-hosting"); next = cycle(MODES.map(m => m[0]), next, dir); }
        net.send({ type: "settings.update", patch: { permissionMode: next } });
      },
    },
    {
      key: "host", label: "Where the server runs", a: "Change",
      value: <div className="seg" style={{ width: 260 }}>{HOSTS.map(([k, n]) => <span key={k} className={st.hosting === k ? "on" : ""}>{n}</span>)}</div>,
      hint: `${st.serverUrl} · ${st.hosting === "cloud" ? "the default, switch any time" : "your agents and keys stay on a machine you control"}`,
      act: dir => net.send({ type: "settings.update", patch: { hosting: cycle(HOSTS.map(h => h[0]), st.hosting, dir) } }),
    },
    {
      key: "key", label: "AI provider · your own key", a: "Show setup page",
      value: st.keySet ? <span className="chip ok">Anthropic · …{st.keyHint}</span> : <span className="chip warn">No key, using the planner</span>,
      hint: `Set keys at ${st.setupUrl}`,
      act: () => toast(`Open ${st.setupUrl} on your laptop`),
    },
    {
      key: "stt", label: "Speech to text",
      value: <span className={"chip" + (snap.services.stt === "cloud" ? " ok" : "")}>{snap.services.stt === "cloud" ? "Cloud" : snap.services.stt === "local" ? "Local model" : "On this Device"}</span>,
      hint: snap.services.stt === "device" ? "Add a speech-to-text key on the setup page for cloud transcripts." : "Offline dumps are re-checked with the cloud later.",
    },
    ...snap.machines.map<Row>(m => ({
      key: "m" + m.id, label: m.name, a: m.online ? undefined : "Try now",
      value: <span className={"chip" + (m.online ? " ok" : "")}><i className="dot" />{m.online ? "Online · Tailscale" : "Offline"}</span>,
      hint: m.online ? `PC agent · ${m.roots?.join(", ") ?? ""}` : m.url,
      act: () => { net.send({ type: "machine.check", machineId: m.id }); toast(`Trying ${m.name}…`); },
    })),
    {
      key: "limits", label: "Claude limits", a: snap.limits.source === "claude-code" ? undefined : "Start a 5 h window now",
      value: <span className="chip">{snap.limits.source === "claude-code" ? `From Claude Code on ${snap.limits.machine}` : snap.limits.source === "manual" ? "Window started by you" : "No window"}</span>,
      hint: snap.limits.resetAt ? `Resets at ${new Date(snap.limits.resetAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "The PC agent reads Claude Code’s logs to find your window.",
      act: () => net.send({ type: "limits.start-window" }),
    },
    {
      key: "reset", label: "Demo data", a: armed && Date.now() - armed < 3000 ? "Press again to reset" : "Reset",
      value: <span className="chip">{snap.notes.length} notes · {snap.tasks.length} tasks</span>,
      act: () => {
        if (armed && Date.now() - armed < 3000) { net.send({ type: "demo.reset" }); setArmed(0); }
        else { setArmed(Date.now()); toast("Press A again to wipe notes and tasks"); }
      },
    },
  ];
  const i = Math.min(sel, rows.length - 1);
  const cur = rows[i];
  useScrollSel(i);

  useControls(e => {
    const n = step(i, e, rows.length);
    if (n !== null) { setSel(n); return true; }
    if (!online && (e.c === "a" || e.c === "left" || e.c === "right")) { toast("Offline. Settings live on the server."); return true; }
    if ((e.c === "left" || e.c === "right") && cur.act && (cur.key === "mode" || cur.key === "host")) { cur.act(e.c === "left" ? -1 : 1); return true; }
    if (e.c === "a" && cur.act) { cur.act(1); return true; }
    return false;
  }, { wheel: "Move", a: cur.a, dpad: cur.key === "mode" || cur.key === "host" ? "Change" : "Move" });

  return <div className="scr">
    <p className="h1 in">Settings</p>
    <div className="mute in" style={{ fontSize: 14 }}>Keys and machines are set from your laptop. This Device has no keyboard.</div>
    <div className="scroll in in-2" style={{ position: "absolute", left: 28, right: 28, top: 104, bottom: 40 }}>
      {rows.map((r, k) => <div key={r.key} className={"set-row" + (k === i ? " sel" : "")} style={{ display: "block" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}><span style={{ fontWeight: 500 }}>{r.label}</span>{r.value}</div>
        {r.hint && <div className="mute" style={{ fontSize: 12.5, marginTop: 4, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.hint}</div>}
      </div>)}
      <div className="mute" style={{ fontSize: 12, padding: "12px 12px 0" }}>Device {net.deviceId} · {online ? `connected to ${net.url}` : "offline"} · protocol v{snap.version}</div>
    </div>
  </div>;
}
