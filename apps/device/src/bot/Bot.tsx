/*
 * The agent bots. Ported from the prototype (apps/device/prototype).
 * Rendering techniques (radial-profile morphing, eyes as mask holes, ease-outs from the frozen
 * pose, deterministic blinks and gaze drift, 3D orbit rings) are adapted from bloub by
 * Norbert Bodziony, MIT licence: https://github.com/NorbertBodziony/bloub
 * Shapes, expressions, colours and the budding animation are our own.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { AgentShape } from "@app/protocol";

/* ------------------------------ Math ------------------------------ */
const N = 64, TAU = Math.PI * 2;
const ANG = Array.from({ length: N }, (_, i) => (i / N) * TAU), COS = ANG.map(Math.cos), SIN = ANG.map(Math.sin);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const loopNoise = (t: number, p: number, s = 0) => { const x = (t / p) * TAU; return 0.55 * Math.sin(x + s) + 0.3 * Math.sin(2 * x + s * 1.7 + 1.1) + 0.15 * Math.sin(3 * x + s * 2.3 + 2.4); };

/* ------------------------------ Shapes ------------------------------ */
type Radii = number[];
type P = { x: number; y: number };
const norm = (r: Radii, max = 1) => { const p = Math.max(...r); return r.map(x => (x * max) / p); };
const smooth = (r: Radii, passes: number) => { let a = r; for (let k = 0; k < passes; k++) a = a.map((_, i) => (a[(i - 1 + N) % N] + 2 * a[i] + a[(i + 1) % N]) / 4); return a; };
function polyRadii(poly: P[]) {
  return ANG.map((_, k) => {
    const dx = COS[k], dy = SIN[k]; let best = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], ex = b.x - a.x, ey = b.y - a.y, den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (a.x * ey - a.y * ex) / den, u = (a.x * dy - a.y * dx) / den;
      if (t > best && u >= 0 && u <= 1) best = t;
    }
    return best;
  });
}
const regPoly = (k: number, rotDeg: number, round: number) => smooth(polyRadii(Array.from({ length: k }, (_, i) => { const a = (rotDeg * Math.PI) / 180 + (i / k) * TAU; return { x: Math.cos(a), y: Math.sin(a) }; })), round);
function unionCircles(cs: { x: number; y: number; r: number }[]) {
  return ANG.map((_, i) => {
    let best = 0;
    for (const c of cs) {
      const dc = COS[i] * c.x + SIN[i] * c.y, disc = dc * dc - (c.x * c.x + c.y * c.y) + c.r * c.r;
      if (disc >= 0) { const t = dc + Math.sqrt(disc); if (t > best) best = t; }
    }
    return best;
  });
}
const chain = (x1: number, y1: number, r1: number, x2: number, y2: number, r2: number, n = 24) => Array.from({ length: n + 1 }, (_, i) => ({ x: lerp(x1, x2, i / n), y: lerp(y1, y2, i / n), r: lerp(r1, r2, i / n) }));

export const SHAPES: Record<AgentShape, Radii> = {
  circle: Array(N).fill(1),
  squircle: norm(ANG.map(a => Math.pow(Math.pow(Math.abs(Math.cos(a)), 4) + Math.pow(Math.abs(Math.sin(a)), 4), -1 / 4)), 1.1),
  capsule: norm(unionCircles(chain(-0.42, 0, 0.6, 0.42, 0, 0.6)), 1.08),
  pebble: norm(ANG.map(a => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)), 1.02),
  cloud: norm(unionCircles([{ x: -0.46, y: 0.18, r: 0.52 }, { x: 0.46, y: 0.18, r: 0.52 }, { x: 0, y: 0.26, r: 0.6 }, { x: -0.22, y: -0.27, r: 0.5 }, { x: 0.3, y: -0.2, r: 0.45 }]), 1.06),
  drop: norm(unionCircles(chain(0, 0.26, 0.66, 0, -0.92, 0.08)), 1.06),
  hexagon: norm(regPoly(6, -90, 3), 1.06),
  triangle: norm(regPoly(3, -90, 6), 1.16),
  flower: norm(ANG.map(a => 1 + 0.09 * Math.cos(5 * a - Math.PI / 2)), 1.04),
};
export const SHAPE_KEYS = Object.keys(SHAPES) as AgentShape[];
const EYE_DY: Partial<Record<AgentShape, number>> = { triangle: 0.2, drop: 0.14, cloud: 0.04, flower: 0.02 };
function radiusAt(radii: Radii, ang: number) { const t = ((((ang / TAU) % 1) + 1) % 1) * N, i = Math.floor(t); return lerp(radii[i % N], radii[(i + 1) % N], t - i); }
function closedPath(p: P[]) {
  const n = p.length, f = (v: number) => v.toFixed(1);
  let d = `M${f(p[0].x)} ${f(p[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n], p1 = p[i], p2 = p[(i + 1) % n], p3 = p[(i + 2) % n];
    d += `C${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d + "Z";
}

/* ------------------------------ Expressions ------------------------------ */
export type BotState = "idle" | "listen" | "think" | "happy" | "wink" | "sad" | "sleep" | "focus" | "warn" | "wide";
type Eyes = { lx: number; ly: number; rx: number; ry: number; w: number; h: number; tL: number; tR: number; lidL: number; lidR: number; cL: number; cR: number };
type Pose = { radii: Radii; rot: number; sx: number; sy: number; cx: number; cy: number; ring: number; zz: number; wob: number; eyes: Eyes; t?: number };
const E0: Eyes = { lx: -0.2, ly: -0.12, rx: 0.2, ry: -0.12, w: 0.15, h: 0.34, tL: -8, tR: -8, lidL: 1, lidR: 1, cL: 0, cR: 0 };

function statePose(s: BotState, tl: number, radii: Radii, shapeKey: AgentShape): Pose {
  const p: Pose = { radii, rot: 0, sx: 1, sy: 1, cx: 0, cy: 0, ring: 0, zz: 0, wob: 0, eyes: { ...E0 } }, e = p.eyes;
  switch (s) {
    case "listen": e.h = 0.4; e.w = 0.16; p.wob = 1; break;
    case "think": e.lx -= 0.08; e.rx -= 0.08; e.ly -= 0.08; e.ry -= 0.08; e.h = 0.3; p.ring = 1; break;
    case "happy": e.cL = e.cR = 1; e.ly = e.ry = -0.16; p.cy = -0.1 * Math.sin(Math.PI * clamp(tl / 0.38)); break;
    case "wink": e.cR = 1; break;
    case "sad": e.ly = e.ry = -0.03; e.h = 0.26; e.tL = -20; e.tR = 20; e.lx = -0.22; e.rx = 0.22; p.sy = 0.95; p.sx = 1.03; p.cy = 0.03; break;
    case "sleep": e.lidL = e.lidR = 0.1; e.ly = e.ry = -0.04; p.zz = 1; break;
    case "focus": e.lidL = e.lidR = 0.1; e.ly = e.ry = -0.04; break;
    case "warn": e.h = 0.4; e.w = 0.17; e.lx += 0.06; e.rx += 0.06; e.ly += 0.05; e.ry += 0.05; break;
    case "wide": e.w = 0.2; e.h = 0.2; e.ly = e.ry = -0.14; break;
  }
  const dy = EYE_DY[shapeKey] || 0; e.ly += dy; e.ry += dy;
  return p;
}
function blendPose(a: Pose, b: Pose, k: number): Pose {
  const e = {} as Eyes;
  for (const key in b.eyes) (e as any)[key] = lerp((a.eyes as any)[key], (b.eyes as any)[key], k);
  return { radii: b.radii.map((r, i) => lerp(a.radii[i], r, k)), rot: lerp(a.rot, b.rot, k), sx: lerp(a.sx, b.sx, k), sy: lerp(a.sy, b.sy, k),
    cx: lerp(a.cx, b.cx, k), cy: lerp(a.cy, b.cy, k), ring: lerp(a.ring, b.ring, k), zz: lerp(a.zz, b.zz, k), wob: lerp(a.wob, b.wob, k), eyes: e };
}
function makeBlinks(seed: number) {
  const r = mulberry(seed * 7919 + 13), out: number[] = []; let t = 0.8 + r() * 2;
  while (t < 3600) { out.push(t); t += 2 + r() * 2.8; if (r() < 0.16) { out.push(t); t += 0.26; } }
  return out;
}
function blinkLid(sched: number[], t: number) {
  let lo = 0, hi = sched.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (sched[m] <= t) { idx = m; lo = m + 1; } else hi = m - 1; }
  if (idx < 0) return 1;
  const k = (t - sched[idx]) / 0.18;
  return k > 1 ? 1 : k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
}

/** State and shape changes blend from the pose on screen, with an ease-out. */
class Engine {
  since = 0; from: Pose | null = null; fromT = 0; target: Radii; rFrom: Radii | null = null; rT = 0;
  level = 0; lv = 0; lastT = 0; blinks: number[];
  constructor(public state: BotState, public shapeKey: AgentShape, public seed: number) {
    this.target = SHAPES[shapeKey] || SHAPES.circle;
    this.blinks = makeBlinks(seed);
  }
  setState(s: BotState, t: number) { if (s === this.state) return; this.from = this.raw(t); this.fromT = t; this.state = s; this.since = t; }
  setShape(key: AgentShape, t: number) { if (key === this.shapeKey) return; this.rFrom = this.radii(t); this.rT = t; this.shapeKey = key; this.target = SHAPES[key] || SHAPES.circle; }
  radii(t: number) {
    if (!this.rFrom) return this.target;
    const k = easeOutQuint(clamp((t - this.rT) / 0.65));
    if (k >= 1) { this.rFrom = null; return this.target; }
    const from = this.rFrom;
    return this.target.map((r, i) => lerp(from[i], r, k));
  }
  raw(t: number): Pose {
    let p = statePose(this.state, t - this.since, this.radii(t), this.shapeKey);
    if (this.from) { const k = easeOutQuint(clamp((t - this.fromT) / 0.45)); if (k < 1) p = blendPose(this.from, p, k); else this.from = null; }
    return p;
  }
  sample(t: number): Pose {
    const p = this.raw(t), dt = Math.max(0, t - this.lastT); this.lastT = t;
    this.lv += (this.level - this.lv) * Math.min(1, dt * 12);
    const e = { ...p.eyes };
    if (e.lidL > 0.3) {
      const dx = 0.03 * loopNoise(t, 6.5, this.seed), dy = 0.022 * loopNoise(t, 8.3, this.seed + 2), b = blinkLid(this.blinks, t);
      e.lx += dx; e.rx += dx; e.ly += dy; e.ry += dy; e.lidL *= b; e.lidR *= b;
    }
    let radii = p.radii, sy = p.sy;
    if (p.wob > 0.01 && this.lv > 0.01) {
      const a = p.wob * this.lv;
      radii = radii.map((r, i) => r * (1 + a * (0.028 * Math.sin(3 * ANG[i] + t * 9) + 0.018 * Math.sin(5 * ANG[i] - t * 7))));
      sy *= 1 + 0.03 * a;
    }
    if (e.lidL <= 0.3) sy *= 1 + 0.014 * Math.sin(t * 1.7);
    return { ...p, radii, sy, eyes: e, t };
  }
}

const pill = (w: number, h: number) => { const r = Math.min(w, h) / 2; return `M${(-w / 2).toFixed(1)} ${(-h / 2 + r).toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${(w / 2).toFixed(1)} ${(-h / 2 + r).toFixed(1)}V${(h / 2 - r).toFixed(1)}A${r.toFixed(1)} ${r.toFixed(1)} 0 0 1 ${(-w / 2).toFixed(1)} ${(h / 2 - r).toFixed(1)}Z`; };
function ringArc(u0: number, u1: number) {
  const RR = 142, fl = 0.27, rot = (-16 * Math.PI) / 180, c = Math.cos(rot), s = Math.sin(rot);
  let d = "";
  for (let k = 0; k <= 24; k++) { const u = u0 + ((u1 - u0) * k) / 24, x = Math.cos(u) * RR, y = Math.sin(u) * RR * fl; d += (k ? "L" : "M") + (x * c - y * s).toFixed(1) + " " + (x * s + y * c).toFixed(1); }
  return d;
}
const RING_F = ringArc(0, Math.PI), RING_B = ringArc(Math.PI, TAU);
function ringDot(t: number) {
  const u = (t * 2.2) % TAU, RR = 142, fl = 0.27, rot = (-16 * Math.PI) / 180, x = Math.cos(u) * RR, y = Math.sin(u) * RR * fl;
  return { x: x * Math.cos(rot) - y * Math.sin(rot), y: x * Math.sin(rot) + y * Math.cos(rot), front: Math.sin(u) > 0 };
}

type Refs = Record<string, SVGElement | null>;
const set = (el: SVGElement | null, k: string, v: string | number) => el && el.setAttribute(k, String(v));
function draw(r: Refs, p: Pose) {
  const R = 100, cr = Math.cos(p.rot), sr = Math.sin(p.rot);
  const pts = p.radii.map((rad, i) => { const x = rad * COS[i], y = rad * SIN[i]; return { x: ((x * cr - y * sr) * p.sx + p.cx) * R, y: ((x * sr + y * cr) * p.sy + p.cy) * R }; });
  set(r.body, "d", closedPath(pts));
  const e = p.eyes;
  for (const S of ["L", "R"] as const) {
    let x = S === "L" ? e.lx : e.rx, y = S === "L" ? e.ly : e.ry;
    const rs = radiusAt(p.radii, Math.atan2(y, x)) * Math.min(p.sx, p.sy), d = Math.hypot(x, y), lim = Math.max(0, rs - 0.22);
    if (d > lim && d > 0) { x *= lim / d; y *= lim / d; }
    const X = ((x * p.sx + p.cx) * R).toFixed(1), Y = ((y * p.sy + p.cy) * R).toFixed(1), w = e.w * R, h = e.h * R;
    const c = e[`c${S}`], lid = e[`lid${S}`], tilt = e[`t${S}`];
    set(r["p" + S], "d", pill(w, h));
    set(r["p" + S], "transform", `translate(${X} ${Y}) rotate(${tilt.toFixed(1)}) scale(1 ${Math.max(0.03, lid * (1 - c)).toFixed(3)})`);
    const aw = w * 2.3, rise = w * 1.1;
    set(r["a" + S], "d", `M${(-aw / 2).toFixed(1)} ${(rise * 0.5).toFixed(1)}Q0 ${(-rise).toFixed(1)} ${(aw / 2).toFixed(1)} ${(rise * 0.5).toFixed(1)}`);
    set(r["a" + S], "transform", `translate(${X} ${Y})`);
    set(r["a" + S], "stroke-width", (w * 0.72).toFixed(1));
    set(r["a" + S], "opacity", c.toFixed(2));
  }
  const ro = p.ring.toFixed(2);
  set(r.ringF, "opacity", ro); set(r.ringB, "opacity", (p.ring * 0.55).toFixed(2));
  if (p.ring > 0.01) {
    const dt = ringDot(p.t || 0);
    set(r.dotF, "cx", dt.x.toFixed(1)); set(r.dotF, "cy", dt.y.toFixed(1)); set(r.dotF, "opacity", dt.front ? ro : 0);
    set(r.dotB, "cx", dt.x.toFixed(1)); set(r.dotB, "cy", dt.y.toFixed(1)); set(r.dotB, "opacity", dt.front ? 0 : (p.ring * 0.55).toFixed(2));
  } else { set(r.dotF, "opacity", 0); set(r.dotB, "opacity", 0); }
  set(r.zz, "opacity", (p.zz * (0.55 + 0.45 * Math.sin((p.t || 0) * 2))).toFixed(2));
  set(r.zz, "transform", `translate(0 ${(-8 * Math.sin((p.t || 0) * 1.4)).toFixed(1)})`);
}

/* ------------------------------ <Bot> ------------------------------ */
let BOT_UID = 0;
const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export interface BotProps {
  state?: BotState;
  shape?: AgentShape;
  color?: string;
  size?: number;
  seed?: number;
  level?: number;
  morphFrom?: AgentShape;
  eyesOnly?: boolean;
  fps?: number;
  style?: CSSProperties;
}

export function Bot({ state = "idle", shape = "circle", color = "#f2f2f2", size = 120, seed = 1, level = 0, morphFrom, eyesOnly = false, fps = 60, style }: BotProps) {
  const uid = useRef("bot" + ++BOT_UID).current;
  const eng = useRef<Engine | null>(null);
  if (!eng.current) eng.current = new Engine(state, morphFrom || shape, seed);
  const refs = useRef<Refs>({}), svg = useRef<SVGSVGElement>(null), t0 = useRef(performance.now());
  const now = () => (performance.now() - t0.current) / 1000;
  useEffect(() => { eng.current!.setState(state, now()); }, [state]);
  useEffect(() => { eng.current!.setShape(shape, now()); }, [shape]);
  useEffect(() => { eng.current!.level = level; }, [level]);
  useEffect(() => {
    let raf = 0, visible = true, last = 0;
    const minDt = 1000 / (reduced ? 8 : fps);
    const loop = (ts: number) => {
      if (!visible) return;
      raf = requestAnimationFrame(loop);
      if (ts - last < minDt - 2) return;
      last = ts;
      draw(refs.current, eng.current!.sample(now()));
    };
    draw(refs.current, eng.current!.sample(now()));
    const io = new IntersectionObserver(([en]) => { visible = en.isIntersecting; cancelAnimationFrame(raf); if (visible) raf = requestAnimationFrame(loop); });
    io.observe(svg.current!);
    raf = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, []);
  const ref = (k: string) => (el: SVGElement | null) => { refs.current[k] = el; };
  return (
    <svg ref={svg} width={size} height={size} viewBox="-160 -160 320 320" style={{ display: "block", overflow: "visible", ...style }} aria-hidden="true">
      <defs>
        <g id={uid + "e"}>
          <path ref={ref("pL")} fill="#000" /><path ref={ref("pR")} fill="#000" />
          <path ref={ref("aL")} fill="none" stroke="#000" strokeLinecap="round" /><path ref={ref("aR")} fill="none" stroke="#000" strokeLinecap="round" />
        </g>
        <mask id={uid} maskUnits="userSpaceOnUse" x="-160" y="-160" width="320" height="320">
          <rect x="-160" y="-160" width="320" height="320" fill="#fff" /><use href={"#" + uid + "e"} />
        </mask>
      </defs>
      <g style={{ color, transition: "color 450ms ease" }}>
        <path ref={ref("ringB")} d={RING_B} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0" />
        <circle ref={ref("dotB")} r="7" fill="currentColor" opacity="0" />
        <path ref={ref("body")} fill="currentColor" mask={`url(#${uid})`} opacity={eyesOnly ? 0 : 1} />
        {eyesOnly && <use href={"#" + uid + "e"} />}
        <path ref={ref("ringF")} d={RING_F} fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" opacity="0" />
        <circle ref={ref("dotF")} r="7" fill="currentColor" opacity="0" />
        <text ref={ref("zz") as any} x="76" y="-96" fill="currentColor" fontSize="44" fontWeight="700" fontFamily="ui-rounded, system-ui" opacity="0">z</text>
      </g>
    </svg>
  );
}

/** Budding: the main agent grows a new one out of its side (gooey metaball filter). */
export function BudScene({ color, onDone }: { color: string; onDone: () => void }) {
  const [t, setT] = useState(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    const t0 = performance.now(); let raf = 0;
    const f = (now: number) => { const k = (now - t0) / 2000; setT(Math.min(1, k)); if (k < 1.2) raf = requestAnimationFrame(f); else done.current(); };
    raf = requestAnimationFrame(f);
    return () => cancelAnimationFrame(raf);
  }, []);
  const e = easeInOut(clamp(t / 0.85)), bx = lerp(318, 520, e), br = lerp(14, 74, easeOutQuint(clamp(t / 0.75)));
  const mainR = 96 - 9 * Math.sin(Math.PI * clamp(t / 0.8)), mainX = 318 - 26 * Math.sin(Math.PI * clamp(t / 0.9));
  const budOpen = clamp((t - 0.78) / 0.15), look = 10 * clamp(t / 0.3);
  return (
    <svg viewBox="0 0 712 504" width="712" height="504" style={{ position: "absolute", left: 36, top: 0 }} aria-hidden="true">
      <defs>
        <filter id="goo" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="14" result="b" />
          <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 28 -12" result="g" />
          <feComposite in="SourceGraphic" in2="g" operator="atop" />
        </filter>
      </defs>
      <g filter="url(#goo)">
        <circle cx={mainX} cy="250" r={mainR} fill="#f2f2f2" />
        <circle cx={bx} cy="250" r={br} fill={t > 0.6 ? color : "#f2f2f2"} style={{ transition: "fill 350ms ease" }} />
      </g>
      {[-18, 18].map(dx => <rect key={dx} x={mainX + dx - 7 + look} y={222} width="14" height="32" rx="7" fill="#000" transform={`rotate(-8 ${mainX + dx + look} 238)`} />)}
      {[-11, 11].map(dx => <rect key={dx} x={bx + dx - 5} y={240 - 11 * budOpen} width="10" height={Math.max(1, 22 * budOpen)} rx="5" fill="#000" />)}
    </svg>
  );
}
