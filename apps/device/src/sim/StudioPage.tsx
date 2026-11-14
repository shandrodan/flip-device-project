// Studio mode (/?studio=1): the 3D twin on a clean stage, for stills and video of the Device
// with its live screen. People use the panel; agents use the same buttons, the model itself,
// or `window.studio`. Software-first, hardware-ready (ADR 0002): a render of a web app, never
// shown as real hardware.
import { useEffect, useRef, useState } from "react";
import { emit, onPress, type Control } from "../input/controls";
import { useNet } from "../net/client";
import { DeviceApp } from "../app/App";
import { defaultSource, type VoiceSource } from "../voice/capture";
import Device3D from "./Device3D";
import { ASPECTS, BACKDROPS, SHOTS, backdropCss, bind, castsShadow, onCaption, set, studio, useStudio, type Aspect } from "./studio";

(window as unknown as { studio: typeof studio }).studio = studio;

/** The last press, named in a corner of the frame. */
function Caption() {
  const [cap, setCap] = useState<{ text: string; k: number } | null>(null);
  useEffect(() => onCaption(text => setCap(c => ({ text, k: (c?.k ?? 0) + 1 }))), []);
  useEffect(() => {
    if (!cap) return;
    const id = setTimeout(() => setCap(null), 1400);
    return () => clearTimeout(id);
  }, [cap]);
  return cap ? <div className="studio-cap" key={cap.k}>{cap.text}</div> : null;
}

/** Which controls are down, to light their panel buttons. */
function useDown() {
  const [down, setDown] = useState<Partial<Record<Control, number>>>({});
  useEffect(() => onPress(e => {
    if (e.c === "mic") return setDown(d => ({ ...d, mic: e.phase === "down" ? 1 : 0 }));
    const t = performance.now();
    setDown(d => ({ ...d, [e.c]: t }));
    setTimeout(() => setDown(d => (d[e.c] === t ? { ...d, [e.c]: 0 } : d)), 190);
  }), []);
  return down;
}

function Clock({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => { const id = setInterval(() => tick(n => n + 1), 500); return () => clearInterval(id); }, []);
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  return <>{String(Math.floor(s / 60)).padStart(2, "0")}:{String(s % 60).padStart(2, "0")}</>;
}

export default function Studio() {
  const st = useStudio();
  const n = useNet();
  const [want, setWant] = useState(false);
  const [voice, setVoice] = useState<VoiceSource>(defaultSource());
  const [note, setNote] = useState("");
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const area = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const down = useDown();

  // The stage: as big as fits, in the chosen shape. With the panel off it is the whole window.
  useEffect(() => {
    const el = area.current!;
    const fit = () => {
      if (!st.panel) return setBox({ w: el.clientWidth, h: el.clientHeight });
      const pad = 40, w = el.clientWidth - pad, h = el.clientHeight - pad;
      const r = ASPECTS[st.aspect], k = Math.min(w / r, h);
      setBox({ w: Math.floor(k * r), h: Math.floor(k) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [st.aspect, st.panel]);

  const run = (job: () => Promise<unknown>) => {
    setNote("");
    job().catch(e => setNote(e instanceof Error ? e.message : String(e)));
  };
  const press = (c: Control, label: string, text: string = label, cls = "") =>
    <button className={"pbtn " + cls} aria-label={label} data-control={c} aria-pressed={!!down[c]} onPointerDown={e => { e.preventDefault(); emit({ c }); }}
      onClick={e => { if (e.detail === 0) emit({ c }); /* keyboard, or a script calling .click() */ }}>{text}</button>;
  const turn = (c: "systemWheel" | "appWheel", dir: 1 | -1, label: string) =>
    <button className="pbtn" aria-label={label} data-control={c} data-dir={dir} onClick={() => emit({ c, dir })}>{dir === 1 ? "›" : "‹"}</button>;
  const micUp = () => { if (down.mic) emit({ c: "mic", phase: "up" }); };

  return <div className={"studio" + (st.panel ? "" : " bare")}>
    <div className="studio-area" ref={area}>
      <div className="studio-frame" ref={frame} data-studio-stage style={{ width: box?.w, height: box?.h, background: backdropCss(st.backdrop) }}>
        {box && <Device3D studio open={st.open} want={want} resetView={0} rings={st.rings} shadow={castsShadow(st)}
          onToggleOpen={() => set({ open: !st.open })} onReady={t => bind(t, frame.current!)}>
          <DeviceApp voice={voice} onWantPush={setWant} />
        </Device3D>}
        {st.captions && <Caption />}
      </div>
    </div>

    {st.panel && <aside className="studio-panel">
      <header>
        <h1>Studio</h1>
        <a className="pbtn" href="/">Exit</a>
      </header>

      <section>
        <h2>Capture</h2>
        <div className="srow">
          <button className="pbtn strong" onClick={() => run(studio.frame)}>Save frame</button>
          {st.recording
            ? <button className="pbtn rec" onClick={() => run(studio.record.stop)}><i /> Stop · <Clock since={st.recording} /></button>
            : <button className="pbtn strong" onClick={() => run(studio.record.start)}>Record video</button>}
        </div>
        <p>{note || "The first capture asks to share this tab. Frames and takes are cut to the stage and land in Downloads."}</p>
      </section>

      <section>
        <h2>Shot</h2>
        <div className="srow">
          {Object.keys(SHOTS).map(k => <button key={k} className="pbtn" onClick={() => studio.shot(k, { duration: 900 })}>{k}</button>)}
        </div>
        <div className="srow">
          <button className="pbtn" onClick={() => studio.orbit(1)}>Turn around</button>
          <button className="pbtn" onClick={() => studio.camera({ zoom: studio.view().zoom * 1.5 }, { duration: 2500 })}>Push in</button>
          <button className="pbtn" onClick={() => studio.camera({ zoom: studio.view().zoom / 1.5 }, { duration: 2500 })}>Pull back</button>
        </div>
        <div className="srow">
          <button className="pbtn" aria-pressed={st.open} onClick={() => studio.tray()}>Tray out</button>
          <button className="pbtn" onClick={() => studio.kickstand()}>Kickstand</button>
          <button className="pbtn" onClick={() => studio.power()}>Power</button>
          <button className="pbtn" aria-pressed={n.mode === "dock"} onClick={() => studio.dock()}>On dock</button>
        </div>
      </section>

      <section>
        <h2>Set</h2>
        <div className="srow">
          {(Object.keys(BACKDROPS) as (keyof typeof BACKDROPS)[]).map(k => <button key={k} className="pbtn" aria-pressed={st.backdrop === k} onClick={() => set({ backdrop: k })}>{k}</button>)}
        </div>
        <div className="srow">
          {(Object.keys(ASPECTS) as Aspect[]).map(k => <button key={k} className="pbtn" aria-pressed={st.aspect === k} onClick={() => set({ aspect: k })}>{k}</button>)}
        </div>
        <div className="srow">
          <button className="pbtn" aria-pressed={st.rings} onClick={() => set({ rings: !st.rings })}>Press rings</button>
          <button className="pbtn" aria-pressed={st.captions} onClick={() => set({ captions: !st.captions })}>Press captions</button>
          <button className="pbtn" aria-pressed={st.shadow} onClick={() => set({ shadow: !st.shadow })}>Shadow</button>
        </div>
      </section>

      <section>
        <h2>Controls</h2>
        <div className="studio-pad">
          <div className="dpad4">
            {press("up", "D-pad up", "↑", "u")}{press("left", "D-pad left", "←", "l")}{press("right", "D-pad right", "→", "r")}{press("down", "D-pad down", "↓", "d")}
          </div>
          <div className="abcd4">
            {press("c", "C button", "C", "c")}{press("d", "D button", "D", "d")}{press("b", "B button", "B", "b")}{press("a", "A button", "A", "a")}
          </div>
        </div>
        <div className="srow">
          {press("pushBar", "Push bar", "Push bar", want ? "want" : "")}
          <button className="pbtn" aria-label="Microphone, hold" data-control="mic" aria-pressed={!!down.mic}
            onPointerDown={e => { e.preventDefault(); e.currentTarget.setPointerCapture?.(e.pointerId); emit({ c: "mic", phase: "down" }); }}
            onPointerUp={micUp} onPointerCancel={micUp} onLostPointerCapture={micUp}>Mic · hold</button>
          <button className="pbtn" aria-pressed={voice === "script"} onClick={() => setVoice(voice === "mic" ? "script" : "mic")}>Voice: {voice === "mic" ? "microphone" : "scripted"}</button>
        </div>
        <div className="srow">
          <span className="pgroup">System wheel{turn("systemWheel", -1, "System wheel back")}{turn("systemWheel", 1, "System wheel forward")}</span>
          <span className="pgroup">In-app wheel{turn("appWheel", -1, "In-app wheel back")}{turn("appWheel", 1, "In-app wheel forward")}{press("appWheelPress", "In-app wheel press", "Press")}</span>
        </div>
        <p>Or press them on the model: click a button, scroll or drag a wheel, hold the mic. Keyboard and gamepad work as on the twin. Agents: <code>window.studio</code>, see docs/STUDIO.md.</p>
      </section>
    </aside>}
  </div>;
}
