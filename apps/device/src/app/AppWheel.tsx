// System wheel flywheel: turning the system wheel opens a flywheel of apps and Task agents in
// the top-left corner, in the same order as the Home comb. Five sit on an arc around the
// corner; the middle one is selected. The system wheel (or D-pad up/down) turns it and never
// ends. A or the push bar opens the selected one, B closes, and 2 seconds without a turn hides it. Behind it, a progressive blur is
// strongest in the corner and fades out toward the centre of the screen.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useControls, LAYER } from "../input/controls";
import { toneVars, type Tone } from "./tone";

export interface WheelItem {
  key: string;
  label: string;
  /** Shown under the label, e.g. "App" or the agent's role. */
  sub?: string;
  icon: ReactNode;
  app?: boolean;
  /** Paint the item in an app's tone (an app with linked bots, or one of those bots). */
  tone?: Tone;
  open(): void;
}

/* Arc geometry (screen px): a circle around the top-left corner. Slots at 5°, 25°, 45°, 65°
   and 85° below the top edge; the one at 45° is selected. */
const R = 206, STEP = (20 * Math.PI) / 180, MID = Math.PI / 4, VISIBLE = 2, SIZE = 56;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const at = (slot: number) => ({ x: R * Math.cos(MID + slot * STEP), y: R * Math.sin(MID + slot * STEP) });
const SEL = at(0);
const IDLE_MS = 2000;

export function AppWheel({ items, start, dir, onClose }: { items: WheelItem[]; start: number; dir: 1 | -1; onClose: () => void }) {
  const n = items.length;
  const [rot, setRot] = useState(start + dir);
  const [closing, setClosing] = useState(false);
  const pos = useRef(start);
  const els = useRef<(HTMLDivElement | null)[]>([]);
  const raf = useRef(0);
  const cur = items[mod(rot, n)];

  // Where item i sits now: its slot wraps to the nearer side so the wheel never ends.
  const place = () => items.forEach((_, i) => {
    const el = els.current[i];
    if (!el) return;
    const slot = mod(i - pos.current + n / 2, n) - n / 2, { x, y } = at(slot), d = Math.abs(slot);
    // Fade past the last visible slot, and (for short lists) before an item wraps round.
    const fade = Math.min(1, Math.max(0, VISIBLE + 0.6 - d) / 0.6, Math.max(0, n / 2 - d) / 0.5);
    el.style.transform = `translate(${x - SIZE / 2}px, ${y - SIZE / 2}px) scale(${1 - Math.min(d, 1) * 0.2})`;
    el.style.opacity = (fade * (1 - Math.min(d, VISIBLE) * 0.12)).toFixed(3);
    el.style.zIndex = String(10 - Math.round(d));
  });
  useLayoutEffect(place, [n]);

  const animate = (to: number) => {
    const from = pos.current, t0 = performance.now(), dur = 320;
    cancelAnimationFrame(raf.current);
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      pos.current = from + (to - from) * (1 - Math.pow(1 - t, 4));
      place();
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };
  // The notch that opened the wheel also moves it one step.
  useEffect(() => { animate(start + dir); return () => cancelAnimationFrame(raf.current); }, []);

  const turn = (d: 1 | -1) => { const to = rot + d; setRot(to); animate(to); };
  const close = (then?: () => void) => {
    if (closing) return;
    setClosing(true);
    setTimeout(() => { onClose(); then?.(); }, 160);
  };

  // Left alone for 2 seconds after the last turn, it hides by itself.
  useEffect(() => {
    const t = setTimeout(() => close(), IDLE_MS);
    return () => clearTimeout(t);
  }, [rot]);

  useControls(e => {
    if (e.c === "systemWheel") { turn(e.dir === -1 ? -1 : 1); return true; }
    if (e.c === "up" || e.c === "down") { turn(e.c === "up" ? -1 : 1); return true; }
    if (e.c === "a" || e.c === "pushBar") { close(cur.open); return true; }
    if (e.c === "b") { close(); return true; }
    // The mic still works: it closes the wheel and talks to whoever is on screen.
    if (e.c === "mic") { if (e.phase === "down") close(); return false; }
    return true;
  }, { a: "Open", push: "", b: "Close", c: "", d: "", wheel: "", dpad: "Browse" }, true, LAYER.sheet);

  return <div className={"aw" + (closing ? " out" : "")} aria-label="Apps and agents">
    <div className="aw-blur aw-b1" /><div className="aw-blur aw-b2" /><div className="aw-blur aw-b3" />
    <div className="aw-tint" />
    {items.map((it, i) => (
      <div key={it.key} ref={el => { els.current[i] = el; }}
        className={"aw-it" + (it.app ? " app" : "") + (it.tone ? " toned" : "") + (it === cur ? " sel" : "")} style={toneVars(it.tone)}>{it.icon}</div>
    ))}
    <div className="aw-cap" key={cur.key} style={{ left: SEL.x + SIZE / 2 + 14, top: SEL.y - 18 }}>
      <b>{cur.label}</b>
      {cur.sub && <span>{cur.sub}</span>}
    </div>
  </div>;
}
