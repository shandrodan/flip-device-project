// Command center: a shade that drops from the top when C is pressed on Home (and only there).
// Top: a flywheel of switches. The in-app wheel or D-pad left/right turns it; the switch in the
// centre is the one A flips. Five sit on the front arc; between slots a switch rides up behind
// the screen edge and comes round the other side, so it never ends (in-app wheel rule).
// Below: notifications (recent agent activity). D-pad down goes into them, A opens the agent.
// C or B closes. Design: apps/device/command-center/index.html.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Battery50Icon, MoonIcon, ShareIcon, SignalIcon, WifiIcon } from "@heroicons/react/20/solid";
import { useControls, LAYER } from "../input/controls";
import { useApp } from "./context";
import { AgentBot, ago } from "./ui";

// Heroicons has no Bluetooth or Tailscale glyph: Signal stands in for Bluetooth, Share (a node mesh) for Tailscale.
const ICON = {
  wifi: <WifiIcon aria-hidden="true" />,
  bt: <SignalIcon aria-hidden="true" />,
  ts: <ShareIcon aria-hidden="true" />,
  saver: <Battery50Icon aria-hidden="true" />,
  dnd: <MoonIcon aria-hidden="true" />,
};

type Key = keyof typeof ICON;
const ITEMS: { k: Key; name: string }[] = [
  { k: "wifi", name: "Wi-Fi" },
  { k: "bt", name: "Bluetooth" },
  { k: "ts", name: "Tailscale" },
  { k: "saver", name: "Battery saver" },
  { k: "dnd", name: "Do Not Disturb" },
];

/* Switch state lives outside the component so it survives closing the shade and leaving Home. */
type On = Record<Key, boolean>;
let on: On = { wifi: true, bt: true, ts: true, saver: false, dnd: false };
const subs = new Set<() => void>();
const flip = (k: Key) => { on = { ...on, [k]: !on[k] }; subs.forEach(f => f()); };
const useOn = () => useSyncExternalStore(f => { subs.add(f); return () => { subs.delete(f); }; }, () => on);
let lastRot = 0;
const seen = new Set<string>();

function sub(k: Key, s: On) {
  if (k === "wifi") return s.wifi ? "On · Studio 5G" : "Off";
  if (k === "bt") return s.bt ? "On · AirPods Pro" : "Off";
  if (k === "saver") return s.saver ? "On · dimmer screen, slower sync" : "Off";
  if (k === "dnd") return s.dnd ? "On · notifications stay quiet" : "Off";
  if (!s.ts) return "Off · agents can’t reach your machines";
  return s.wifi ? "On · laptop and VM reachable" : "On · waiting for Wi-Fi";
}

/* Ring geometry (screen px). Slots at -60, -30, 0, 30, 60 degrees; the centre one is selected. */
const N = ITEMS.length, HALF = N / 2;
const CX = 392, YC = -6, RX = 383, RY = 124, STEP = (30 * Math.PI) / 180;
const mod = (a: number, n: number) => ((a % n) + n) % n;
const slotOf = (rel: number) => mod(rel + HALF, N) - HALF;
const at = (slot: number) => ({ x: CX + RX * Math.sin(slot * STEP), y: YC + RY * Math.cos(slot * STEP) });
const END_L = at(-HALF), END_R = at(HALF), SEL = at(0);
const NOTES_MAX = 3;

export function CommandCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { snap, push } = useApp();
  const s = useOn();
  const [rot, setRot] = useState(lastRot);
  const [zone, setZone] = useState<"wheel" | "list">("wheel");
  const [n, setN] = useState(0);
  const pos = useRef(rot);
  const els = useRef<(HTMLDivElement | null)[]>([]);
  const raf = useRef(0);

  const notes = snap.activity.slice(0, NOTES_MAX).map(a => ({ ...a, agent: snap.agents.find(g => g.id === a.agentId), key: a.at + a.agentId }));
  const unread = notes.filter(x => !seen.has(x.key)).length;
  const front = ITEMS[mod(rot, N)];

  // Opening starts on the wheel; closing counts as having seen what was listed.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open) { setZone("wheel"); setN(0); }
    else if (wasOpen.current) notes.forEach(x => seen.add(x.key));
    wasOpen.current = open;
  }, [open]);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  // Positions are written straight to the DOM each frame: no React render per frame.
  const place = () => ITEMS.forEach((_, i) => {
    const el = els.current[i];
    if (!el) return;
    const slot = slotOf(i - pos.current), { x, y } = at(slot), c = Math.cos(slot * STEP);
    el.style.transform = `translate(${x - 32}px, ${y - 32}px) scale(${0.7 + 0.3 * c})`;
    el.style.opacity = Math.max(0, Math.min(1, (HALF - Math.abs(slot)) / 0.5)).toFixed(3);
    el.style.zIndex = String(Math.round(c * 10));
  });
  useLayoutEffect(place, []);

  // dir +1 brings the right-hand neighbour to the centre (everything slides one slot left).
  const turn = (dir: 1 | -1) => {
    const to = rot + dir, from = pos.current, t0 = performance.now(), dur = 420;
    setRot(to);
    lastRot = to;
    cancelAnimationFrame(raf.current);
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / dur);
      pos.current = from + (to - from) * (1 - Math.pow(1 - t, 4));
      place();
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
  };

  useControls(e => {
    if (e.c === "c" || e.c === "b") { onClose(); return true; }
    if (e.c === "appWheel") { setZone("wheel"); turn(e.dir === -1 ? -1 : 1); return true; }
    if (zone === "wheel") {
      if (e.c === "left" || e.c === "right") turn(e.c === "right" ? 1 : -1);
      else if (e.c === "down" && notes.length) { setZone("list"); setN(0); }
      else if (e.c === "a") flip(front.k);
    } else {
      if (e.c === "up") { if (n === 0) setZone("wheel"); else setN(n - 1); }
      else if (e.c === "down") setN(Math.min(notes.length - 1, n + 1));
      else if (e.c === "a" && notes[n]) {
        seen.add(notes[n].key);
        onClose();
        if (notes[n].agent) push({ name: "agent", agentId: notes[n].agentId });
      }
    }
    // Everything except the mic and the system wheel stays inside the shade.
    return e.c !== "mic" && e.c !== "systemWheel";
  }, {
    c: "Close",
    a: zone === "list" ? (notes[n]?.agent ? "Open" : "") : s[front.k] ? "Turn off" : "Turn on",
    wheel: "Spin",
    dpad: zone === "list" ? "Choose" : "Spin",
    b: "", d: "", push: "", cue: ["wheel"],
  }, open, LAYER.sheet);

  const warn = front.k === "ts" && (!s.ts || !s.wifi);
  return <>
    <div className={"cc-scrim" + (open ? " open" : "")} />
    <div className={"cc-shade" + (open ? " open" : "")} aria-hidden={!open}>
      <div className={"cc-fly" + (zone === "list" ? " dim" : "")}>
        <svg className="cc-track" viewBox="0 0 784 232"><path d={`M${END_L.x} ${END_L.y} A ${RX} ${RY} 0 0 0 ${END_R.x} ${END_R.y}`} /></svg>
        {ITEMS.map((it, i) => (
          <div key={it.k} ref={el => { els.current[i] = el; }}
            className={`cc-it cc-${it.k}` + (s[it.k] ? " on" : "") + (it === front ? " sel" : "")}>{ICON[it.k]}</div>
        ))}
        <div className="cc-cap" key={front.k} style={{ left: SEL.x - 150, top: SEL.y + 40 }}>
          <b>{front.name}</b>
          <span className={warn ? "warn" : ""}>{sub(front.k, s)}</span>
        </div>
      </div>
      <div className="cc-rule" />
      <div className="cc-list">
        <div className="cc-head"><span>Notifications</span><span>{s.dnd ? "Silenced" : unread ? `${unread} new` : ""}</span></div>
        {notes.length ? notes.map((x, i) => (
          <div key={x.key} className={"cc-n" + (zone === "list" && i === n ? " sel" : "") + (seen.has(x.key) ? " read" : "")}>
            <div className="cc-av">{x.agent ? <AgentBot agent={x.agent} size={30} fps={10} /> : null}</div>
            <div className="cc-t"><b>{x.agent?.name ?? "Agent"}</b><span>{x.text}</span></div>
            <time>{ago(x.at)}</time><i className="cc-unread" />
          </div>
        )) : <div className="cc-empty">You’re all caught up.</div>}
      </div>
      <div className="cc-handle" />
    </div>
  </>;
}
