// The hardware twin: the flip device drawn open, with every control from device-controls.md.
// Software-first, hardware-ready (ADR 0002): this is a web app, the renders show the real thing.
import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from "react";
import { emit, onPress, setTrayOpen, wheelHandler, type Control, type ControlEvent } from "../input/controls";
import { useNet, net } from "../net/client";
import { DeviceApp } from "../app/App";
import type { DebugLink } from "../app/screens/Debug";
import { defaultSource, type VoiceSource } from "../voice/capture";
import { RemoteScreen, remoteUrl } from "./RemoteScreen";
import { BoardMonitor } from "./BoardMonitor";
import { ArrowUpRightIcon, MicrophoneIcon, PlayIcon } from "@heroicons/react/20/solid";

const W = 904, H = 968;

// The 3D twin (Three.js + the Blender model) loads on its own, so the kiosk and dock stay light.
const Device3D = lazy(() => import("./Device3D"));
/** `/?flat=1` keeps the drawn twin, for machines without WebGL. */
const wantFlat = new URLSearchParams(location.search).has("flat");

function usePressed() {
  const [down, setDown] = useState<Partial<Record<Control, number>>>({});
  useEffect(() => onPress((e: ControlEvent) => {
    const k = e.c === "systemWheel" || e.c === "appWheel" ? (`${e.c}` as Control) : e.c;
    if (e.c === "mic") return setDown(d => ({ ...d, mic: e.phase === "down" ? Date.now() : 0 }));
    const t = Date.now();
    setDown(d => ({ ...d, [k]: t }));
    setTimeout(() => setDown(d => (d[k] === t ? { ...d, [k]: 0 } : d)), 140);
  }), []);
  return down;
}

function useWheelSpin() {
  const [spin, setSpin] = useState({ systemWheel: 0, appWheel: 0 });
  useEffect(() => onPress(e => {
    if (e.c === "systemWheel" || e.c === "appWheel") setSpin(s => ({ ...s, [e.c]: s[e.c as "systemWheel"] + (e.dir || 1) * 30 }));
  }), []);
  return spin;
}

function Wheel({ kind, label, spin, press }: { kind: "systemWheel" | "appWheel"; label: string; spin: number; press?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const onWheel = useRef(wheelHandler(kind)).current;
  // React's onWheel is passive; attach a real listener so the page doesn't scroll.
  useEffect(() => {
    const el = ref.current!;
    const h = (e: WheelEvent) => onWheel(e as unknown as React.WheelEvent);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, []);
  const down = usePressed();
  return <div ref={ref} className={"wheel " + (kind === "systemWheel" ? "sys" : "app")} title={`${label}: scroll, or click the left/right half`}>
    <div className="knurl" style={{ transform: `rotate(${spin}deg)` }}><i className="tick" /></div>
    <button className="half l" aria-label={`${label} up`} onClick={() => emit({ c: kind, dir: -1 })} />
    <button className="half r" aria-label={`${label} down`} onClick={() => emit({ c: kind, dir: 1 })} />
    <button className={"cap" + (press ? " press" : "") + (press && down.appWheelPress ? " down" : "")} aria-label={press ? "Press in-app wheel" : label} onClick={() => press && emit({ c: "appWheelPress" })} style={{ cursor: press ? "pointer" : "default" }} />
  </div>;
}

export function Simulator() {
  const n = useNet();
  const wrap = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [want, setWant] = useState(false);
  const [labels, setLabels] = useState(true);
  const [voice, setVoice] = useState<VoiceSource>(defaultSource());
  const [debug, setDebug] = useState<DebugLink | null>(null);
  const [flat, setFlat] = useState(wantFlat);
  const [open, setOpen] = useState(true);
  const [view, setView] = useState(0);
  const down = usePressed();
  const spin = useWheelSpin();
  const screenWheel = useRef(wheelHandler("appWheel")).current;
  const screenRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fit = () => {
      const w = wrap.current?.clientWidth || W;
      setScale(Math.max(0.42, Math.min(1, w / W, (window.innerHeight - 170) / H)));
    };
    fit();
    if (!wrap.current) return;
    const ro = new ResizeObserver(fit);
    ro.observe(wrap.current);
    window.addEventListener("resize", fit);
    return () => { ro.disconnect(); window.removeEventListener("resize", fit); };
  }, [flat]);
  useEffect(() => {
    const el = screenRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => screenWheel(e as unknown as React.WheelEvent);
    el.addEventListener("wheel", h, { passive: false });
    return () => el.removeEventListener("wheel", h);
  }, [flat]);
  useEffect(() => { try { localStorage.setItem("flip-voice", voice); } catch { /* ignore */ } }, [voice]);
  // The screen's prompts follow the tray: closed, the D-pad and A–D are covered. The drawn twin is always open.
  // In the Dock the tray is always closed.
  const docked = n.mode === "dock";
  useEffect(() => { setTrayOpen(flat || (open && !docked)); }, [flat, open, docked]);

  const btn = (c: Control, cls: string, content: ReactNode, label: string) =>
    <button className={cls + (down[c] ? " down" : "")} aria-label={label} onPointerDown={e => { e.preventDefault(); emit({ c }); }}>{content}</button>;
  const L = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => labels ? <span className="hw-label" style={{ left: x, top: y }}>{children}</span> : null;

  const micDown = (e: React.PointerEvent) => { e.preventDefault(); (e.target as HTMLElement).setPointerCapture?.(e.pointerId); emit({ c: "mic", phase: "down" }); };
  const micUp = () => { if (down.mic) emit({ c: "mic", phase: "up" }); };
  const app = remoteUrl ? <RemoteScreen url={remoteUrl} />
    : <DeviceApp voice={voice} onWantPush={setWant} debug={debug} onEndDebug={() => setDebug(null)} />;
  const tri = (r: number) => <PlayIcon width={16} height={16} aria-hidden="true" style={{ transform: `rotate(${r - 90}deg)` }} />;

  return <div className="sim">
    <header className="sim-head">
      <div>
        <h1>Flip · device twin</h1>
        <p>The Device as a web app, driven only by its buttons. Hold the red mic, turn the wheels, press the push bar. Agents run on the server and act on your machines through the PC agent.</p>
      </div>
      <nav className="sim-links">
        {!flat && <a href="/?studio=1">Studio</a>}
        <a href="/dock" target="_blank" rel="noreferrer">Dock screen <ArrowUpRightIcon width={12} height={12} aria-hidden="true" style={{ verticalAlign: "-1px" }} /></a>
        <a href="/?kiosk=1" target="_blank" rel="noreferrer">Kiosk <ArrowUpRightIcon width={12} height={12} aria-hidden="true" style={{ verticalAlign: "-1px" }} /></a>
        <a href="/setup" target="_blank" rel="noreferrer">Setup <ArrowUpRightIcon width={12} height={12} aria-hidden="true" style={{ verticalAlign: "-1px" }} /></a>
      </nav>
    </header>

    {!flat && <Suspense fallback={<div className="stage3d"><div className="stage3d-note">Loading the Device model…</div></div>}>
      <Device3D open={open} want={want} docked={docked} resetView={view} onToggleOpen={() => setOpen(o => !o)} onFail={() => setFlat(true)}>{app}</Device3D>
    </Suspense>}
    {!flat && <div className="panel reach">
      <span className="pstat">Out of sight from the front</span>
      <button className={"pbtn" + (want ? " want" : "")} onPointerDown={e => { e.preventDefault(); emit({ c: "pushBar" }); }}>Push bar</button>
      <button className="pbtn" aria-pressed={!!down.mic} onPointerDown={micDown} onPointerUp={micUp} onPointerCancel={micUp} onLostPointerCapture={micUp}>Mic · hold</button>
      <span className="pgroup">System wheel
        <button className="pbtn" aria-label="System wheel back" onClick={() => emit({ c: "systemWheel", dir: -1 })}>‹</button>
        <button className="pbtn" aria-label="System wheel forward" onClick={() => emit({ c: "systemWheel", dir: 1 })}>›</button>
      </span>
      <span className="pgroup">In-app wheel
        <button className="pbtn" aria-label="In-app wheel up" onClick={() => emit({ c: "appWheel", dir: -1 })}>‹</button>
        <button className="pbtn" aria-label="In-app wheel down" onClick={() => emit({ c: "appWheel", dir: 1 })}>›</button>
        <button className="pbtn" onClick={() => emit({ c: "appWheelPress" })}>Press</button>
      </span>
    </div>}

    {flat && <div className="fit" ref={wrap} style={{ height: H * scale }}>
      <div className="device" style={{ transform: `scale(${scale})`, marginLeft: `max(0px, calc((100% - ${W * scale}px) / 2 / ${scale}))` }}>
        <div className="lid">
          <div className="glass"><div className="screen" ref={screenRef}>{app}</div></div>
          <button className="mic" aria-label="Microphone (hold)" onPointerDown={micDown} onPointerUp={micUp} onPointerCancel={micUp} onLostPointerCapture={micUp} style={down.mic ? { transform: "translateY(1px) scale(0.95)", boxShadow: "0 0 0 4px rgba(255,69,58,0.25)" } : undefined}>
            <MicrophoneIcon width={14} height={14} aria-hidden="true" />
          </button>
          <L x={680} y={576}>Mic · hold</L>
          <button className={"push" + (down.pushBar ? " down" : "") + (want ? " want" : "")} aria-label="Push bar (approve)" onPointerDown={e => { e.preventDefault(); emit({ c: "pushBar" }); }} />
          {labels && <span className="hw-label" style={{ left: 922, top: 490, transform: "rotate(90deg) translateX(-50%)", transformOrigin: "0 0" }}>Push bar</span>}
        </div>
        <div className="hinge" />
        <div className="base">
          <div className="dpad">
            {btn("up", "u", tri(0), "D-pad up")}{btn("down", "d", tri(180), "D-pad down")}{btn("left", "l", tri(-90), "D-pad left")}{btn("right", "r", tri(90), "D-pad right")}
            <div className="c" />
          </div>
          <L x={179} y={262}>D-pad</L>
          <Wheel kind="systemWheel" label="System wheel" spin={spin.systemWheel} />
          <L x={370} y={222}>System wheel</L>
          <Wheel kind="appWheel" label="In-app wheel" spin={spin.appWheel} press />
          <L x={530} y={222}>In-app wheel · press</L>
          <div className="abcd">
            {btn("c", "c", "C", "C button")}{btn("d", "d", "D", "D button")}{btn("b", "b", "B", "B button")}{btn("a", "a", "A", "A button")}
          </div>
          <L x={720} y={262}>A confirm · B back</L>
          <div className="speaker" />
        </div>
      </div>
    </div>}

    <div className="panel">
      <span className="pstat"><i className="dot" style={{ background: n.conn === "online" ? "#34c759" : n.conn === "connecting" ? "#ffd60a" : "#ff453a" }} />
        {n.conn === "online" ? `Server online${n.snap ? ` · ${n.snap.services.llm === "openrouter" ? "OpenRouter agents" : n.snap.services.llm === "claude" ? "Claude agents" : "planner agents"} · ${n.snap.machines.filter(m => m.online).length}/${n.snap.machines.length} machines` : ""}` : n.conn === "connecting" ? "Connecting…" : "Offline"}
      </span>
      <span style={{ flex: 1 }} />
      <button className="pbtn" aria-pressed={docked} onClick={() => net.setMode(docked ? "handheld" : "dock")}>{docked ? "Take off dock" : "Put on dock"}</button>
      <button className="pbtn" aria-pressed={n.forcedOffline} onClick={() => net.setForcedOffline(!n.forcedOffline)}>{n.forcedOffline ? "Go online" : "Go offline"}</button>
      <button className="pbtn" aria-pressed={voice === "script"} onClick={() => setVoice(voice === "mic" ? "script" : "mic")}>Voice: {voice === "mic" ? "microphone" : "scripted"}</button>
      <button className="pbtn" aria-pressed={!!debug} onClick={() => setDebug(debug === null ? "usb" : debug === "usb" ? "wifi" : null)}>Debug: {debug === "usb" ? "USB-C" : debug === "wifi" ? "Wi-Fi" : "off"}</button>
      {flat
        ? <button className="pbtn" aria-pressed={!labels} onClick={() => setLabels(!labels)}>{labels ? "Hide labels" : "Show labels"}</button>
        : <>
          <button className="pbtn" aria-pressed={!open || docked} disabled={docked} onClick={() => setOpen(!open)}>{open && !docked ? "Slide closed" : "Slide open"}</button>
          <button className="pbtn" onClick={() => setView(v => v + 1)}>Front view</button>
        </>}
    </div>
    {remoteUrl && <BoardMonitor url={remoteUrl} />}
    <div className="keys">
      <kbd>Space</kbd> hold mic · <kbd>Enter</kbd> push bar · <kbd>K</kbd> A · <kbd>L</kbd>/<kbd>Esc</kbd> B · <kbd>I</kbd> C · <kbd>J</kbd> D · <kbd>←↑↓→</kbd> D-pad · <kbd>Q</kbd>/<kbd>E</kbd> system wheel · <kbd>W</kbd>/<kbd>S</kbd> or scroll on the screen: in-app wheel · <kbd>D</kbd> wheel press{!flat && <> · drag to turn the Device, click its buttons, click the shell to slide it · scroll or drag a wheel to turn it · scroll or pinch to zoom, right-drag to move</>} · An Xbox controller works too (LB/RB system wheel, LT/RT in-app wheel, Start push bar, hold View for mic).
    </div>
  </div>;
}
