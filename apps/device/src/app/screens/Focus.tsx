import { useState } from "react";
import { Bot } from "../../bot/Bot";
import { useControls } from "../../input/controls";
import { net } from "../../net/client";
import { useApp } from "../context";
import { mmss, useTick } from "../ui";

// device-controls.md, Focus mode: in-app wheel picks the length, push bar starts, second press ends.
export function Focus() {
  const { snap, online, toast } = useApp();
  useTick(500);
  const f = snap.focus;
  const [mins, setMins] = useState(Math.round(f.lengthMs / 60000) || 25);
  const left = f.running && f.endsAt ? Math.max(0, Date.parse(f.endsAt) - Date.now()) : mins * 60e3;
  const pct = f.running ? left / f.lengthMs : 1;
  const r = 128, L = 2 * Math.PI * r;

  useControls(e => {
    if (!f.running && (e.c === "appWheel" || e.c === "up" || e.c === "down")) {
      const d = e.c === "appWheel" ? e.dir || 0 : e.c === "up" ? 1 : -1;
      setMins(m => Math.max(5, Math.min(90, m + d * 5)));
      return true;
    }
    if (e.c === "pushBar") {
      if (!online) { toast("Offline. The timer lives on the server."); return true; }
      net.send(f.running ? { type: "focus.stop" } : { type: "focus.start", minutes: mins, kind: "focus" });
      return true;
    }
    if (e.c === "y" && !f.running) { net.send({ type: "focus.start", minutes: 5, kind: "break" }); return true; }
    return false;
  }, { push: f.running ? "End session" : "Start", wheel: f.running ? undefined : "Length", y: f.running ? undefined : "Break 5" });

  return <div className="scr">
    <svg width="290" height="290" style={{ position: "absolute", left: "50%", top: 40, marginLeft: -145, transform: "rotate(-90deg)" }}>
      <circle cx="145" cy="145" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="5" />
      <circle cx="145" cy="145" r={r} fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeDasharray={L} strokeDashoffset={L * (1 - pct)} style={{ transition: "stroke-dashoffset 500ms linear" }} />
      {!f.running && Array.from({ length: 18 }, (_, k) => {
        const on = (k + 1) * 5 <= mins, a = ((k + 1) / 18) * Math.PI * 2;
        return <circle key={k} cx={145 + Math.cos(a) * (r + 14)} cy={145 + Math.sin(a) * (r + 14)} r={on ? 2.6 : 1.6} fill={on ? "#fff" : "rgba(255,255,255,0.25)"} />;
      })}
    </svg>
    <div style={{ position: "absolute", left: "50%", top: 75, marginLeft: -110 }}><Bot size={220} seed={3} state={f.running ? "focus" : "idle"} /></div>
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 44, textAlign: "center" }}>
      <div className="tnum" style={{ font: "600 56px/1 var(--rounded)", letterSpacing: "-0.03em" }}>{mmss(left)}</div>
      <div className="mute" style={{ fontSize: 14, marginTop: 8 }}>
        {f.running ? (f.kind === "break" ? "Break. Look away from the screen." : `Round ${f.round} · I’ll hold everything that isn’t urgent`) : `Round ${f.round} · Turn the wheel to set ${mins} min, press the push bar to start`}
      </div>
    </div>
  </div>;
}
