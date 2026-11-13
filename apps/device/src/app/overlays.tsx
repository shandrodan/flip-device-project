import { useEffect, useRef, useState } from "react";
import type { ApprovalRequest } from "@app/protocol";
import { Bot } from "../bot/Bot";
import { useControls, LAYER, type ControlEvent } from "../input/controls";
import { net } from "../net/client";
import { startCapture, blobToBase64, type Capture } from "../voice/capture";
import { useApp, FN_LABEL, type Fn, type TalkTarget } from "./context";
import { Ico, AgentBot } from "./ui";

/* ================================ Talk ================================ */
// Mounted while the mic button is held. Streams audio to the server; on release the dump is
// saved as a note at once (ADR 0005), online or not.

export function TalkOverlay({ target, sample, onDone }: { target: TalkTarget; sample: number; onDone: () => void }) {
  const app = useApp();
  const [text, setText] = useState("");
  const [level, setLevel] = useState(0.5);
  const [phase, setPhase] = useState<"listen" | "saving">("listen");
  const cap = useRef<Capture | null>(null);
  const released = useRef(false);
  const streamId = useRef("vs_" + Math.random().toString(36).slice(2, 10));
  const streaming = useRef(false);
  const online = app.online;

  useEffect(() => {
    let alive = true;
    const start = async (source: typeof app.voice) => {
      try {
        const c = await startCapture(source, {
          sample,
          purpose: target.kind === "name" ? "name" : "note",
          onPartial: t => alive && setText(t),
          onChunk: async b => {
            if (!streaming.current) return;
            net.send({ type: "voice.chunk", streamId: streamId.current, audio: await blobToBase64(b) });
          },
        });
        if (!alive) return c.cancel();
        cap.current = c;
        if (c.source === "mic" && online && target.kind !== "name") {
          streaming.current = net.send({ type: "voice.start", streamId: streamId.current, mime: c.mime, target: target.kind === "append" ? { kind: "append", noteId: target.noteId } : { kind: "note" } });
        }
        if (released.current) finish();
      } catch {
        if (source === "mic") {
          app.toast("No microphone access. Using the scripted voice.");
          return start("script");
        }
        onDone();
      }
    };
    void start(app.voice);
    const id = setInterval(() => cap.current && setLevel(cap.current.level()), 90);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const finish = async () => {
    const c = cap.current;
    if (!c) return; // still starting; start() calls finish once ready
    cap.current = null;
    setPhase("saving");
    const r = await c.stop();
    const heard = r.hint.trim();
    if (r.durationMs < 600 || (c.source === "script" && !heard)) {
      if (streaming.current) net.send({ type: "voice.cancel", streamId: streamId.current });
      app.toast("Didn’t catch that. Hold the mic while you speak.");
      return onDone();
    }
    if (target.kind === "name") {
      target.onText(heard.replace(/[.!?]+$/, "").split(/\s+/).slice(0, 3).join(" "));
      return onDone();
    }
    if (net.online) {
      if (c.source === "script") {
        net.send({ type: "voice.scripted", text: heard, cloudText: r.cloudText, durationMs: r.durationMs, target: target.kind === "append" ? { kind: "append", noteId: target.noteId } : { kind: "note" } });
      } else if (streaming.current) {
        net.send({ type: "voice.end", streamId: streamId.current, durationMs: r.durationMs, hint: heard || undefined });
      } else {
        // Connection came back mid-dump: send it as a synced note.
        const audio = r.audio && r.audio.size < 8e6 ? await blobToBase64(r.audio) : undefined;
        net.send({ type: "note.sync", note: { localId: streamId.current, text: heard || "Voice note", createdAt: new Date().toISOString(), durationMs: r.durationMs, editedByUser: false, audio, mime: r.mime } });
      }
      if (target.kind === "append") return onDone();
      // Wait for the server's note.saved (usually well under a second).
      const stop = net.on(m => {
        if (m.type === "note.saved" && (m.streamId === streamId.current || m.localId === streamId.current || c.source === "script")) {
          stop();
          clearTimeout(t);
          app.push({ name: "suggest", noteId: m.note.id });
          onDone();
        }
      });
      const t = setTimeout(() => { stop(); app.toast("Saved. The server is slow to answer."); onDone(); }, 5000);
      return;
    }
    // Offline: keep it on the Device, re-check with the cloud later.
    if (target.kind === "append") {
      if (target.noteId.startsWith("local:")) net.appendOffline(target.noteId.slice(6), heard);
      else app.toast("Offline. I can add to this note once we’re back.");
      return onDone();
    }
    const audio = r.audio && r.audio.size < 1.5e6 ? await blobToBase64(r.audio) : undefined;
    const localId = streamId.current;
    net.saveOffline({ localId, text: heard || `Voice note (${Math.round(r.durationMs / 1000)}s)`, createdAt: new Date().toISOString(), durationMs: r.durationMs, editedByUser: false, audio, mime: r.mime, cloudText: r.cloudText });
    app.push({ name: "suggest", noteId: "local:" + localId });
    onDone();
  };

  useControls((e: ControlEvent) => {
    if (e.c === "mic" && e.phase === "up") {
      released.current = true;
      void finish();
    }
    return true; // nothing else while talking
  }, { mic: phase === "listen" ? "Let go to save" : "Saving…" }, true, LAYER.talk);

  const label = target.kind === "name" ? "Say a name" : target.kind === "append" ? "Adding to the note" : online ? "Listening" : "Listening · on device";
  return <div className="fill" style={{ background: "#000", zIndex: 20 }}>
    <div style={{ position: "absolute", left: 60, top: 92 }}><Bot state={phase === "saving" ? "think" : "listen"} level={level} size={300} seed={3} /></div>
    <div style={{ position: "absolute", left: 410, top: 110, right: 40 }}>
      <div className="label" style={{ fontSize: 14 }}>{phase === "saving" ? "Saving…" : label}</div>
      <p style={{ margin: "10px 0 0", font: "500 25px/1.32 var(--sys-display)", letterSpacing: "-0.02em", maxHeight: 230, overflow: "hidden" }}>
        {text || <span className="mute">{app.voice === "mic" ? "Go ahead, I’m listening…" : "…"}</span>}
      </p>
      {!online && target.kind !== "name" && <p className="mute" style={{ fontSize: 14, marginTop: 18 }}>No connection. I’ll save this on the Device and re-check it with the cloud once you’re back.</p>}
    </div>
  </div>;
}

/* ================================ Approvals ================================ */

/** Risky action: the bot grows into fire, only the eyes stay. The push bar approves. */
export function FireOverlay({ req, onWant }: { req: ApprovalRequest | null; onWant: (w: boolean) => void }) {
  const { snap, toast } = useApp();
  const [shown, setShown] = useState<ApprovalRequest | null>(null);
  const [phase, setPhase] = useState<"off" | "pre" | "fire" | "done">("off");
  const [nudge, setNudge] = useState(0);
  useEffect(() => {
    if (req) {
      setShown(req);
      setPhase("pre");
      const r = requestAnimationFrame(() => requestAnimationFrame(() => setPhase("fire")));
      return () => cancelAnimationFrame(r);
    }
    if (shown) {
      setPhase("done");
      const t = setTimeout(() => { setShown(null); setPhase("off"); }, 720);
      return () => clearTimeout(t);
    }
  }, [req?.requestId]);
  useEffect(() => { onWant(phase === "fire"); }, [phase]);

  const live = phase === "fire" && !!shown;
  useControls(e => {
    if (!shown) return false;
    if (e.c === "pushBar") net.send({ type: "approval.press", requestId: shown.requestId, approved: true, via: "push-bar" });
    else if (e.c === "b") net.send({ type: "approval.press", requestId: shown.requestId, approved: false, via: "b-button" });
    else if (e.c === "a") { setNudge(n => n + 1); toast("Risky ones need the push bar"); }
    return true;
  }, { push: "Approve", b: "Not now" }, live, LAYER.approval);

  if (!shown) return null;
  const fire = phase === "fire";
  const clip = fire ? "circle(900px at 610px 250px)" : "circle(80px at 392px 220px)";
  const ag = snap.agents.find(a => a.id === shown.agentId);
  return <div className="fire-layer">
    <div className={"fire" + (fire ? " on" : "")} style={{ clipPath: clip, WebkitClipPath: clip }}>
      {([["-40px", "#ffcf33", "0s"], ["180px", "#ff2d00", "0.8s"], ["400px", "#ffb000", "1.6s"], ["600px", "#ff3d00", "0.4s"]] as const).map(([l, b, dl], i) => <i key={i} style={{ left: l, background: b, animationDelay: dl }} />)}
    </div>
    {fire && <>
      <div style={{ position: "absolute", left: 480, top: 96 }}>{ag ? <AgentBot agent={ag} size={290} state="warn" eyesOnly /> : <Bot size={290} state="warn" eyesOnly />}</div>
      <div className={"fire-copy in" + (nudge ? " nudge" : "")} key={nudge} style={{ animationDelay: nudge ? "0ms" : "160ms" }}>
        <div className="label" style={{ color: "rgba(0,0,0,0.6)", marginBottom: 8 }}>{ag ? ag.name : "Main agent"} needs your press</div>
        <p className="say" style={{ fontSize: shown.title.length > 26 ? 36 : 42 }}>{shown.title}</p>
        {shown.preview && (shown.preview.subject || shown.preview.body) ? <div style={{ margin: "14px 0 6px", padding: "12px 14px", borderRadius: 16, background: "rgba(0,0,0,0.12)", fontSize: 14, lineHeight: 1.5 }}>
          {shown.preview.to && <div><span style={{ opacity: 0.6 }}>To </span><b>{shown.preview.to}</b></div>}
          {shown.preview.subject && <div><span style={{ opacity: 0.6 }}>Subject </span><b>{shown.preview.subject}</b></div>}
          {shown.preview.body && <div style={{ opacity: 0.75, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden", whiteSpace: "pre-line" }}>{shown.preview.body}</div>}
          {shown.preview.attach && <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontWeight: 600 }}>{Ico.clip} {shown.preview.attach}</div>}
        </div> : <p className="mute" style={{ margin: "12px 0 6px", fontSize: 16, lineHeight: 1.45 }}>{shown.body}</p>}
        {shown.preview?.files && !shown.preview.subject && <div style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.5 }}>{shown.preview.files.slice(0, 3).map(f => <div key={f} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f}</div>)}</div>}
        <b style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16 }}>Press the push bar {Ico.arrow}</b>
      </div>
      <div className="press-bar" />
    </>}
  </div>;
}

/** Manual mode, or Auto asking in the grey zone: a soft card. A or the push bar approves. */
export function SoftApproval({ req }: { req: ApprovalRequest }) {
  const { snap } = useApp();
  const ag = snap.agents.find(a => a.id === req.agentId);
  useControls(e => {
    if (e.c === "a" || e.c === "pushBar") net.send({ type: "approval.press", requestId: req.requestId, approved: true, via: e.c === "a" ? "a-button" : "push-bar" });
    else if (e.c === "b") net.send({ type: "approval.press", requestId: req.requestId, approved: false, via: "b-button" });
    else if (e.c === "systemWheel" || e.c === "mic") return false;
    return true;
  }, { mic: "Hold to talk", a: "Go ahead", push: "Go ahead", b: "Not now" }, true, LAYER.approval);
  return <div className="soft" key={req.requestId}>
    {ag && <AgentBot agent={ag} size={44} state="wide" />}
    <div style={{ flex: 1, minWidth: 0 }}>
      <div className="label">{snap.settings.permissionMode === "manual" ? "Manual mode" : "Asking first"} · {ag ? ag.name : "Agent"}</div>
      <b style={{ display: "block", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{req.title}</b>
      {req.body && <div className="mute" style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{req.body}</div>}
    </div>
  </div>;
}

/* ================================ Switcher HUD ================================ */

export function Hud({ fns, fn, icons }: { fns: Fn[]; fn: Fn; icons: Record<Fn, JSX.Element> }) {
  return <div className="hud">
    {fns.map(f => <div key={f} className={"fn" + (f === fn ? " on" : "")}>{icons[f]}<span>{FN_LABEL[f]}</span></div>)}
  </div>;
}
