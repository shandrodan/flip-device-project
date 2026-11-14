// The hardware twin in 3D: the Blender model (web-render/device-handoff) rendered with Three.js,
// with the live Device screen mounted on its `screen` mesh and every control clickable.
// Software-first, hardware-ready (ADR 0002): still a web app, now wearing the real shell.
//
// How the screen works: the UI stays real DOM (crisp text, no texture copies). A CSS3DRenderer
// places it in the same 3D space behind the WebGL canvas, and the `screen` mesh punches a
// transparent hole in the canvas so the DOM shows through. The shell still occludes it correctly.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CSS3DObject, CSS3DRenderer } from "three/addons/renderers/CSS3DRenderer.js";
import { emit, onPress, wheelHandler, type Control } from "../input/controls";
import glbUrl from "../../../../web-render/device-handoff/white-slider-device.glb?url";
import dockUrl from "../../../../web-render/device-handoff/dock-station.glb?url";

const SCREEN_W = 784, SCREEN_H = 504;
const FOV = 26;
/** Half extents to keep in frame, in mm: the Device with its tray out, plus breathing room. */
const FRAME_W = 86, FRAME_H = 78;
/** How far the Device's centre drops when the tray is out (tray travels 32 mm). */
const OPEN_SHIFT = 16;
/** Docking, one step at a time, in ms. Undocking plays the same steps backwards.
 *  Before these the tray slides closed; after undocking it slides back open. */
const DOCK_FADE = 750, DOCK_TRAVEL = 1100, DOCK_LAND = 800;
const DOCK_MS = DOCK_FADE + DOCK_TRAVEL + DOCK_LAND;
/** How high above the seat the Device hovers before it lowers in, in mm. */
const DOCK_HOVER = 34;
/** Breathing room around the Dock with the Device seated, in mm. */
const DOCK_PAD = 26;

type Part = "a" | "b" | "c" | "d" | "dpad" | "pushBar" | "mic" | "systemWheel" | "appWheel" | "power" | "kickstand";
/** Node names in the model → the control they are. Checked on the hit mesh and its parents. */
const PARTS: [RegExp, Part][] = [
  [/^button_a(_|$)/, "a"], [/^button_b(_|$)/, "b"], [/^button_c(_|$)/, "c"], [/^button_d(_|$)/, "d"],
  [/^(button_dpad|d_pad_outline)/, "dpad"],
  [/^(button_push_bar|top_control_start_pause_gasket)/, "pushBar"],
  [/^button_microphone/, "mic"],
  [/^wheel_system/, "systemWheel"],
  [/^(wheel_in_app|top_control_wheel_socket)/, "appWheel"],
  [/^(button_power|power_slider_track)/, "power"],
  [/^kickstand(_mesh)?$/, "kickstand"],
];
/** What the pointer is over, shown beside it. */
const LABEL: Record<Part, string> = {
  a: "A", b: "B", c: "C", d: "D", dpad: "D-pad", pushBar: "Push bar", mic: "Mic · hold",
  systemWheel: "System wheel · scroll or drag", appWheel: "In-app wheel · scroll, drag or press",
  power: "Power · screen on/off", kickstand: "Kickstand",
};
/** The plain shell: a click on it (not a drag) slides the tray. */
const SHELL = /^(slider_tray|slider_rails|screen_housing)$/;
const MAX_ZOOM = 8;
/** How long a press stays in, in ms. Long enough to read in a video. */
const PRESS_MS = 190;
const partOf = (name: string) => PARTS.find(([re]) => re.test(name))?.[1];

/** Where the camera is. Angles in radians, zoom 1 = the whole Device in frame, x and y in mm. */
export interface View { yaw: number; pitch: number; zoom: number; x: number; y: number }
export type Ease = "linear" | "in" | "out" | "inOut";
/** Anything a pointer or a press ring can aim at: a part, or one arm of the D-pad. */
export type Target = Part | "up" | "down" | "left" | "right" | "appWheelPress";
/** The twin's remote control, for studio mode and for agents (see docs/STUDIO.md). */
export interface Twin {
  view(): View;
  /** Move the camera. With no duration it cuts; with one it travels for that many ms. */
  setView(v: Partial<View>, opts?: { duration?: number; ease?: Ease }): void;
  /** True while the camera is travelling. */
  moving(): boolean;
  /** Where a control is on the page, and whether the camera can see it. */
  locate(t: Target): { x: number; y: number; visible: boolean } | null;
  power(on?: boolean): boolean;
  kickstand(out?: boolean): boolean;
}
const EASE: Record<Ease, (t: number) => number> = {
  linear: t => t,
  in: t => t * t * t,
  out: t => 1 - (1 - t) ** 3,
  inOut: t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
};

/** The mark a press leaves on the model: a soft disc with a ring. */
function ringTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.fillStyle = "rgba(255,255,255,0.3)";
  g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.fill();
  g.lineWidth = 7;
  g.strokeStyle = "rgba(255,255,255,1)";
  g.beginPath(); g.arc(64, 64, 56, 0, Math.PI * 2); g.stroke();
  return new THREE.CanvasTexture(c);
}

/** Soft blob behind the Device, standing in for the studio backdrop shadow. */
function shadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(64, 64, 8, 64, 64, 64);
  grad.addColorStop(0, "rgba(40,46,56,0.7)");
  grad.addColorStop(0.6, "rgba(40,46,56,0.3)");
  grad.addColorStop(1, "rgba(40,46,56,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export default function Device3D({ open, want, docked = false, resetView, onToggleOpen, onFail, studio = false, rings = false, shadow = true, onReady, children }: {
  /** Tray slid out (controls showing) or closed. */
  open: boolean;
  /** An approval press is wanted: the push bar glows. */
  want: boolean;
  /** Dock mode: the Device travels into the Dock and seats in `device_seat`, tray closed. */
  docked?: boolean;
  /** Bump to bring the camera back to the front. */
  resetView: number;
  /** The shell was clicked: slide the tray the other way. */
  onToggleOpen?: () => void;
  /** WebGL or the model is not available. */
  onFail?: () => void;
  /** Studio mode: the camera only goes where it is told, and nothing but the Device is drawn. */
  studio?: boolean;
  /** Mark every press on the model with a ring, so it reads in a video. */
  rings?: boolean;
  /** The soft shadow behind the Device. */
  shadow?: boolean;
  /** The model is loaded: here is its remote control. */
  onReady?: (twin: Twin) => void;
  /** The Device screen. */
  children: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  // The screen's DOM home. CSS3DRenderer moves it into its own layer; React only owns the inside.
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = "screen";
    el.style.borderRadius = "0";
    el.style.backfaceVisibility = "hidden";
    el.style.transition = "filter 260ms ease-out";
    return el;
  });
  const [loaded, setLoaded] = useState(false);
  const label = useRef<HTMLDivElement>(null);
  const live = useRef({ open, want, docked, resetView, onToggleOpen, onReady, rings, shadow, poke: () => { }, zoomBy: (_f: number) => { } });
  live.current.onToggleOpen = onToggleOpen;
  live.current.onReady = onReady;
  live.current.rings = rings;
  live.current.shadow = shadow;
  live.current.open = open;
  live.current.want = want;
  live.current.docked = docked;
  live.current.resetView = resetView;
  useEffect(() => { live.current.poke(); }, [open, want, docked, resetView, rings, shadow]);

  useEffect(() => {
    const el = stage.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      onFail?.();
      return;
    }
    // Supersample a little past the screen's own density: the shell's grain and the small
    // controls stay crisp instead of shimmering. We only draw while something moves, so it's cheap.
    renderer.setPixelRatio(Math.min(3, Math.min(window.devicePixelRatio, 2) * 1.25));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const css = new CSS3DRenderer();
    css.domElement.className = "stage3d-css";
    renderer.domElement.className = "stage3d-gl";
    el.append(css.domElement, renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.42;
    // A raking key light, so the grain in the shell's normal and roughness maps reads. A cool rim for the edges.
    const keyLight = new THREE.DirectionalLight(0xfff6ea, 2.1);
    keyLight.position.set(-260, 300, 190);
    // Real shadows from the key light: the screen housing over the tray, the Device in the Dock.
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.radius = 3;
    keyLight.shadow.bias = -0.0003;
    keyLight.shadow.normalBias = 0.35;
    Object.assign(keyLight.shadow.camera, { left: -130, right: 130, top: 130, bottom: -130, near: 150, far: 750 });
    keyLight.shadow.camera.updateProjectionMatrix();
    const rimLight = new THREE.DirectionalLight(0xdfe8ff, 0.9);
    rimLight.position.set(300, 80, -260);
    scene.add(keyLight, rimLight);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 20, 6000);
    /** The studio may pull back for a wide shot. */
    const MIN_ZOOM = studio ? 0.35 : 1;

    const shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(300, 250),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, toneMapped: false }),
    );
    shadow.position.set(6, -14, -40);
    scene.add(shadow);

    /** The orbit pivot. The model sits inside it, in millimetres. */
    const rig = new THREE.Group();
    rig.rotation.order = "YXZ";
    scene.add(rig);

    let dirty = true;
    live.current.poke = () => { dirty = true; };
    let fitDist = 400;
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
    /** Half extents to keep in frame: the Device alone, or the Dock with the Device seated. */
    const frameHand = { w: FRAME_W, h: FRAME_H }, frameDock = { w: FRAME_W, h: FRAME_H }, frameNow = { w: FRAME_W, h: FRAME_H };
    const fitFor = (f: { w: number; h: number }) => Math.max(f.h / tanHalf, f.w / (tanHalf * camera.aspect));
    const fit = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      css.setSize(w, h);
      camera.aspect = w / h;
      fitDist = fitFor(frameNow);
      camera.updateProjectionMatrix();
      dirty = true;
    };
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    fit();

    // ---- Model ----
    let model: THREE.Object3D | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    let slideClip: THREE.AnimationAction | null = null;
    let pushGlow: THREE.MeshStandardMaterial | null = null;
    let micGlow: THREE.MeshStandardMaterial | null = null;
    const node: Partial<Record<Part, THREE.Object3D>> = {};
    const rest: Partial<Record<Part, THREE.Vector3>> = {};
    const bounds: Partial<Record<Part, THREE.Box3>> = {};
    let dead = false;

    new GLTFLoader().load(glbUrl, gltf => {
      if (dead) return;
      model = gltf.scene;
      model.scale.setScalar(1000); // metres → mm
      rig.add(model);

      const names: Record<Part, string> = {
        a: "button_a", b: "button_b", c: "button_c", d: "button_d", dpad: "button_dpad",
        pushBar: "button_push_bar", mic: "button_microphone", systemWheel: "wheel_system", appWheel: "wheel_in_app",
        power: "button_power", kickstand: "kickstand",
      };
      for (const k of Object.keys(names) as Part[]) {
        const o = model.getObjectByName(names[k]);
        if (o) { node[k] = o; rest[k] = o.position.clone(); }
      }

      // Where each control sits in its own space, for press rings and locate().
      rig.updateMatrixWorld(true);
      for (const k of Object.keys(node) as Part[]) {
        const o = node[k]!, inv = o.matrixWorld.clone().invert(), box = new THREE.Box3();
        o.traverse(m => {
          const geo = (m as THREE.Mesh).geometry;
          if (!geo) return;
          if (!geo.boundingBox) geo.computeBoundingBox();
          box.union(geo.boundingBox!.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld)));
        });
        if (!box.isEmpty()) bounds[k] = box;
      }

      // Keep the surface textures sharp at grazing angles and up close.
      const aniso = renderer.capabilities.getMaxAnisotropy();
      model.traverse(o => {
        if ((o as THREE.Mesh).isMesh) o.castShadow = o.receiveShadow = true;
        const mats = (o as THREE.Mesh).material;
        for (const m of (Array.isArray(mats) ? mats : mats ? [mats] : []) as THREE.MeshPhysicalMaterial[]) {
          for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) if (t) { t.anisotropy = aniso; t.needsUpdate = true; }
        }
      });
      const mic = node.mic as THREE.Mesh | undefined;
      if (mic && !Array.isArray(mic.material)) {
        micGlow = mic.material as THREE.MeshStandardMaterial;
        micGlow.emissive = new THREE.Color(1, 0.08, 0.06);
        micGlow.emissiveIntensity = 0;
      }

      // The push bar shares the shell material; give it its own so it can glow.
      const bar = node.pushBar as THREE.Mesh | undefined;
      if (bar && !Array.isArray(bar.material)) {
        pushGlow = (bar.material as THREE.MeshStandardMaterial).clone();
        pushGlow.emissive = new THREE.Color(1, 0.33, 0.08);
        pushGlow.emissiveIntensity = 0;
        bar.material = pushGlow;
      }

      // The screen: a hole in the canvas with the live DOM behind it, and a glass sheet on top
      // that only adds reflections (it never darkens or hides the UI).
      const screen = model.getObjectByName("screen") as THREE.Mesh | undefined;
      if (screen?.geometry) {
        screen.geometry.computeBoundingBox();
        const box = screen.geometry.boundingBox!;
        const size = box.getSize(new THREE.Vector3()), mid = box.getCenter(new THREE.Vector3());
        screen.material = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0, blending: THREE.NoBlending });
        screen.castShadow = screen.receiveShadow = false;
        const ui = new CSS3DObject(host);
        ui.position.set(mid.x, mid.y, box.max.z);
        ui.scale.set(size.x / SCREEN_W, size.y / SCREEN_H, 1);
        screen.add(ui);
        const glass = new THREE.Mesh(screen.geometry, new THREE.MeshPhysicalMaterial({
          color: 0x000000, roughness: 0.06, metalness: 0, envMapIntensity: 0.6, transparent: true, depthWrite: false,
          blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
          blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        }));
        glass.position.z = 0.00005;
        glass.raycast = () => { };
        screen.add(glass);
      }

      const clip = THREE.AnimationClip.findByName(gltf.animations, "slide_open");
      if (clip) {
        mixer = new THREE.AnimationMixer(model);
        slideClip = mixer.clipAction(clip);
        slideClip.play();
        slideClip.paused = true; // scrubbed by hand below, so it can be damped and reversed
      }
      // Arrive with a small turn and the tray sliding out. The studio starts on its own shot.
      if (!studio) { view.yaw = -0.7; view.pitch = 0.28; slide = 0; zoom = 0.86; }
      dirty = true;
      setLoaded(true);
      live.current.onReady?.(twin);
      // The Dock comes second, so the Device shows up first.
      if (!studio || live.current.docked) loadDock();
    }, undefined, () => { if (!dead) onFail?.(); });

    // ---- Dock: dock-station.glb, with the closed Device seated in `device_seat` ----
    let dock: THREE.Object3D | null = null, dockLoading = false;
    let indicator: THREE.MeshStandardMaterial | null = null;
    const indicatorOn = { color: new THREE.Color(), glow: 1 }, indicatorOff = new THREE.Color(0x2a2e33);
    const dockMats: THREE.Material[] = [];
    /** Where the Dock rests, and the Device's pose in the seat, both in rig space. */
    const dockAt = new THREE.Vector3(), seatPos = new THREE.Vector3(), seatQuat = new THREE.Quaternion();
    /** Where on the docking timeline we are, in ms: 0 = in the hand, DOCK_MS = seated. */
    let dockT = 0, dockFade = -1;
    const loadDock = () => {
      if (dockLoading) return;
      dockLoading = true;
      new GLTFLoader().load(dockUrl, gltf => {
        if (dead || !model) return;
        dock = gltf.scene;
        dock.scale.setScalar(1000);
        dock.visible = false;
        rig.add(dock);
        const aniso = renderer.capabilities.getMaxAnisotropy();
        dock.traverse(o => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          m.castShadow = m.receiveShadow = true;
          m.raycast = () => { }; // the Dock is scenery; clicks go to the Device
          for (const mat of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshPhysicalMaterial[]) {
            if (!dockMats.includes(mat)) dockMats.push(mat);
            for (const t of [mat.map, mat.normalMap, mat.roughnessMap]) if (t) { t.anisotropy = aniso; t.needsUpdate = true; }
          }
        });
        const led = dock.getObjectByName("dock_indicator") as THREE.Mesh | undefined;
        if (led && !Array.isArray(led.material)) {
          indicator = led.material as THREE.MeshStandardMaterial;
          indicatorOn.color.copy(indicator.color);
          indicatorOn.glow = indicator.emissiveIntensity || 1;
          indicator.emissiveIntensity = 0;
          indicator.color.copy(indicatorOff);
        }

        // Seat the closed Device (identity local transform under device_seat) and centre the pair on the pivot.
        const seat = dock.getObjectByName("device_seat");
        const saved = { rot: rig.rotation.clone(), pos: model.position.clone(), quat: model.quaternion.clone(), t: slideClip?.time ?? 0 };
        rig.rotation.set(0, 0, 0);
        if (slideClip && mixer) { slideClip.time = 0; mixer.update(0); }
        rig.updateMatrixWorld(true);
        const seatM = seat ? seat.matrixWorld.clone() : new THREE.Matrix4();
        seatM.decompose(seatPos, seatQuat, new THREE.Vector3());
        model.position.copy(seatPos);
        model.quaternion.copy(seatQuat);
        rig.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model).union(new THREE.Box3().setFromObject(dock));
        const mid = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
        dockAt.copy(mid).negate();
        seatPos.add(dockAt);
        frameDock.w = size.x / 2 + DOCK_PAD;
        frameDock.h = size.y / 2 + DOCK_PAD;
        rig.rotation.copy(saved.rot);
        model.position.copy(saved.pos);
        model.quaternion.copy(saved.quat);
        if (slideClip && mixer) { slideClip.time = saved.t; mixer.update(0); }
        dock.position.copy(dockAt);
        dirty = true;
      }, undefined, () => { dockLoading = false; });
    };
    /** Fade the Dock's materials. Transparent only while fading, so the solid Dock sorts and shadows normally. */
    const setDockFade = (a: number) => {
      if (a === dockFade) return;
      const solid = a >= 1;
      for (const m of dockMats) {
        if (m === indicator) continue;
        if (m.transparent === solid) { m.transparent = !solid; m.needsUpdate = true; }
        m.opacity = a;
        m.depthWrite = solid;
      }
      dockFade = a;
    };
    const handPos = new THREE.Vector3(), hoverPos = new THREE.Vector3(), identity = new THREE.Quaternion();

    let slide = live.current.open ? 1 : 0;

    // ---- Control feedback: every press moves its part, wherever the press came from ----
    const held: Partial<Record<Part, number>> = {}; // part → time the press visibly ends
    const depth: Partial<Record<Part, number>> = {}; // 0 = at rest, 1 = fully in
    const dpadTilt = new THREE.Vector2(), dpadTarget = new THREE.Vector2();
    const spin = { systemWheel: 0, appWheel: 0 }, spinTarget = { systemWheel: 0, appWheel: 0 };
    let micHeld = false;

    /** A control's centre in the world, as the model stands right now. */
    const spot = (t: Target) => {
      const arm = t === "up" || t === "down" || t === "left" || t === "right";
      const part: Part = arm ? "dpad" : t === "appWheelPress" ? "appWheel" : t;
      const o = node[part], box = bounds[part];
      if (!o || !box) return null;
      const p = box.getCenter(new THREE.Vector3());
      if (arm) {
        const size = box.getSize(new THREE.Vector3());
        if (t === "left" || t === "right") p.x += (t === "right" ? 0.33 : -0.33) * size.x;
        else p.y += (t === "up" ? 0.33 : -0.33) * size.y;
      }
      rig.updateMatrixWorld(true);
      return { part, world: o.localToWorld(p), radius: Math.max(4.5, Math.min(9, 0.5 * 1000 * (arm ? 0.34 : 1) * Math.max(...box.getSize(new THREE.Vector3()).toArray().sort((a, b) => a - b).slice(1)))) };
    };

    // ---- Press rings: a mark on the model where a control was pressed, so a video shows it ----
    const ringMap = ringTexture();
    interface Ring { sprite: THREE.Sprite; target: Target; t0: number; size: number; hold: boolean }
    const ringList: Ring[] = [];
    const ring = (target: Target, hold = false) => {
      if (!live.current.rings) return;
      const s = spot(target);
      if (!s) return;
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringMap, color: 0x14161a, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      sprite.renderOrder = 10;
      scene.add(sprite);
      ringList.push({ sprite, target, t0: performance.now(), size: s.radius, hold });
    };

    const offPress = onPress(e => {
      dirty = true;
      if (e.c === "mic") {
        micHeld = e.phase === "down";
        if (micHeld) ring("mic", true);
        return;
      }
      ring(e.c);
      if (e.c === "systemWheel" || e.c === "appWheel") { spinTarget[e.c] += (e.dir || 1) * (Math.PI / 6); return; }
      const now = performance.now();
      if (e.c === "up" || e.c === "down" || e.c === "left" || e.c === "right") {
        dpadTarget.set(e.c === "up" ? -1 : e.c === "down" ? 1 : 0, e.c === "right" ? 1 : e.c === "left" ? -1 : 0);
        held.dpad = now + PRESS_MS;
        return;
      }
      held[e.c === "appWheelPress" ? "appWheel" : e.c] = now + PRESS_MS;
    });

    // ---- Pointer: press a control, drag a wheel, or drag anywhere to orbit. Scroll and pinch zoom. ----
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const toNdc = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    };
    const pick = (ev: { clientX: number; clientY: number }) => {
      if (!model) return null;
      ray.setFromCamera(toNdc(ev), camera);
      const hit = ray.intersectObject(model, true)[0];
      if (!hit) return null;
      for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
        const part = partOf(o.name);
        if (part) return { part, point: hit.point, name: hit.object.name };
      }
      return { part: null, point: hit.point, name: hit.object.name };
    };

    const view = { yaw: 0, pitch: 0, toYaw: 0, toPitch: 0, tiltX: 0, tiltY: 0, toTiltX: 0, toTiltY: 0 };
    let zoom = 1, toZoom = 1;
    const pan = new THREE.Vector2(), toPan = new THREE.Vector2();
    /** Zoom by `factor`, keeping what is under the pointer (x, y in -1..1) where it is. */
    const zoomAt = (x: number, y: number, factor: number) => {
      const next = THREE.MathUtils.clamp(toZoom * factor, MIN_ZOOM, MAX_ZOOM);
      const before = (tanHalf * fitDist) / toZoom, after = (tanHalf * fitDist) / next;
      toPan.x += x * camera.aspect * (before - after);
      toPan.y += y * (before - after);
      toZoom = next;
      clampPan();
      dirty = true;
    };
    const clampPan = () => {
      const reach = Math.max(studio ? 0.6 : 0, 1 - 1 / toZoom); // nothing to pan to when the whole Device is in frame
      toPan.set(THREE.MathUtils.clamp(toPan.x, -FRAME_W * reach, FRAME_W * reach), THREE.MathUtils.clamp(toPan.y, -FRAME_H * reach, FRAME_H * reach));
    };
    live.current.zoomBy = f => zoomAt(0, 0, f);

    // ---- The remote control: camera moves on a timeline, and where each control is on the page ----
    let tween: { t0: number; dur: number; from: View; to: View; ease: (t: number) => number } | null = null;
    const twin: Twin = {
      view: () => ({ yaw: view.yaw, pitch: view.pitch, zoom, x: pan.x, y: pan.y }),
      setView(v, opts = {}) {
        const from = twin.view(), to = { ...(tween ? tween.to : from), ...v };
        tween = { t0: performance.now(), dur: Math.max(0, opts.duration || 0), from, to, ease: EASE[opts.ease || "inOut"] };
        dirty = true;
      },
      moving: () => !!tween,
      locate(t) {
        const s = spot(t);
        if (!s || !model) return null;
        camera.updateMatrixWorld();
        const n = s.world.clone().project(camera), r = el.getBoundingClientRect();
        ray.setFromCamera(new THREE.Vector2(n.x, n.y), camera);
        let seen = false;
        for (let o: THREE.Object3D | null = ray.intersectObject(model, true)[0]?.object ?? null; o && !seen; o = o.parent) seen = partOf(o.name) === s.part;
        return { x: r.left + ((n.x + 1) / 2) * r.width, y: r.top + ((1 - n.y) / 2) * r.height, visible: seen && Math.abs(n.x) <= 1 && Math.abs(n.y) <= 1 };
      },
      power(on = !powered) { powered = on; host.style.filter = powered ? "" : "brightness(0)"; dirty = true; return powered; },
      kickstand(out = !standOut) { standOut = out; dirty = true; return standOut; },
    };

    let powered = true, standOut = false;
    type Mode = null | "orbit" | "pan" | "pinch" | { wheel: "systemWheel" | "appWheel"; acc: number; turned: boolean; back: boolean };
    let mode: Mode = null;
    let moved = 0, onShell = false, pinch = 0;
    const touches = new Map<number, { x: number; y: number }>();
    let seenReset = live.current.resetView;
    let seenDock = live.current.docked;
    const canvas = renderer.domElement;
    const tip = (text: string | null, ev?: PointerEvent) => {
      const t = label.current;
      if (!t) return;
      t.style.opacity = text ? "1" : "0";
      if (!text || !ev) return;
      const r = el.getBoundingClientRect();
      t.textContent = text;
      t.style.transform = `translate(${ev.clientX - r.left + 14}px, ${ev.clientY - r.top + 16}px)`;
    };

    const down = (ev: PointerEvent) => {
      ev.preventDefault();
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* a scripted pointer has nothing to capture */ }
      touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      tip(null);
      if (touches.size === 2) {
        if (micHeld) emit({ c: "mic", phase: "up" });
        const [p1, p2] = [...touches.values()];
        pinch = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        mode = "pinch";
        return;
      }
      if (ev.button === 2 || ev.shiftKey) { mode = "pan"; canvas.style.cursor = "move"; return; }
      if (ev.button !== 0) return;
      const p = pick(ev);
      const part = p?.part;
      if (!part) {
        mode = "orbit"; moved = 0; onShell = !!p && SHELL.test(p.name);
        tween = null;
        canvas.style.cursor = "grabbing";
        return;
      }
      if (part === "mic") emit({ c: "mic", phase: "down" });
      else if (part === "dpad") {
        const l = node.dpad!.worldToLocal(p!.point.clone());
        emit({ c: Math.abs(l.x) > Math.abs(l.y) ? (l.x > 0 ? "right" : "left") : (l.y > 0 ? "up" : "down") });
      } else if (part === "systemWheel" || part === "appWheel") {
        // Dragging turns it one click at a time. A plain click turns the system wheel one step, or presses the in-app wheel.
        mode = { wheel: part, acc: 0, turned: false, back: part === "systemWheel" && node.systemWheel!.worldToLocal(p!.point.clone()).y > 0 };
        canvas.style.cursor = part === "systemWheel" ? "ns-resize" : "ew-resize";
      } else if (part === "power") twin.power();
      else if (part === "kickstand") twin.kickstand();
      else emit({ c: part as Control });
    };
    const move = (ev: PointerEvent) => {
      const prev = touches.get(ev.pointerId);
      const dx = prev ? ev.clientX - prev.x : 0, dy = prev ? ev.clientY - prev.y : 0;
      if (prev) touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (mode === "pinch") {
        if (touches.size < 2) return;
        const [p1, p2] = [...touches.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        const mid = toNdc({ clientX: (p1.x + p2.x) / 2, clientY: (p1.y + p2.y) / 2 });
        if (pinch > 0) zoomAt(mid.x, mid.y, d / pinch);
        pinch = d;
      } else if (mode === "orbit") {
        moved += Math.abs(dx) + Math.abs(dy);
        view.toYaw += dx * 0.008;
        view.toPitch = THREE.MathUtils.clamp(view.toPitch + dy * 0.008, -1.35, 1.35);
        dirty = true;
      } else if (mode === "pan") {
        const mm = (2 * tanHalf * camera.position.z) / el.clientHeight;
        toPan.x -= dx * mm;
        toPan.y += dy * mm;
        clampPan();
        dirty = true;
      } else if (mode) {
        mode.acc += mode.wheel === "systemWheel" ? dy : dx;
        while (Math.abs(mode.acc) >= 12) {
          emit({ c: mode.wheel, dir: mode.acc > 0 ? 1 : -1 });
          mode.acc -= Math.sign(mode.acc) * 12;
          mode.turned = true;
        }
      } else if (ev.pointerType === "mouse" && !ev.buttons) {
        const n = toNdc(ev);
        // Outside the studio the Device leans a little towards the pointer.
        if (!studio) { view.toTiltY = n.x * 0.07; view.toTiltX = -n.y * 0.05; }
        const part = pick(ev)?.part;
        canvas.style.cursor = part ? "pointer" : "grab";
        if (!studio) tip(part ? LABEL[part] : null, ev);
        dirty = true;
      }
    };
    const up = (ev: PointerEvent) => {
      if (!touches.delete(ev.pointerId)) return;
      if (micHeld) emit({ c: "mic", phase: "up" });
      if (mode === "orbit" && moved < 5 && onShell && !live.current.docked) live.current.onToggleOpen?.();
      else if (mode && typeof mode === "object" && !mode.turned) {
        emit(mode.wheel === "systemWheel" ? { c: "systemWheel", dir: mode.back ? -1 : 1 } : { c: "appWheelPress" });
      }
      mode = touches.size ? mode : null;
      if (!mode) canvas.style.cursor = "grab";
    };
    const leave = () => { view.toTiltX = view.toTiltY = 0; tip(null); dirty = true; };
    // Scroll on a wheel turns that wheel, on the screen it turns the in-app wheel, anywhere else it zooms.
    // Pinch on a trackpad (ctrl + scroll) always zooms.
    const sysWheel = wheelHandler("systemWheel"), appWheel = wheelHandler("appWheel");
    const wheel = (ev: WheelEvent) => {
      const p = ev.ctrlKey ? null : pick(ev);
      if (p?.part === "systemWheel") return sysWheel(ev);
      if (p?.part === "appWheel" || p?.name === "screen") return appWheel(ev);
      ev.preventDefault();
      const n = toNdc(ev);
      zoomAt(n.x, n.y, Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.012 : 0.0016)));
    };
    const noMenu = (ev: Event) => ev.preventDefault();
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("lostpointercapture", up);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("contextmenu", noMenu);
    canvas.style.cursor = "grab";

    // ---- Frame loop: only draws while something is moving ----
    let raf = 0, last = performance.now();
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      let moving = dirty;
      dirty = false;
      const damp = (cur: number, to: number, rate: number) => {
        const d = to - cur;
        if (Math.abs(d) < 1e-4) return to;
        moving = true;
        return cur + d * (1 - Math.exp(-rate * dt));
      };

      if (seenReset !== live.current.resetView) {
        seenReset = live.current.resetView;
        // Unwind whole turns first so the Device takes the short way back to the front.
        view.yaw -= Math.round(view.yaw / (Math.PI * 2)) * Math.PI * 2;
        view.toYaw = view.toPitch = 0;
        toZoom = 1;
        toPan.set(0, 0);
      }
      if (tween) {
        // A timed camera move: exact, so the same script always gives the same video.
        const k = tween.dur ? Math.min(1, (now - tween.t0) / tween.dur) : 1, e = tween.ease(k), { from, to } = tween;
        const mix = (a: number, b: number) => a + (b - a) * e;
        view.yaw = view.toYaw = mix(from.yaw, to.yaw);
        view.pitch = view.toPitch = mix(from.pitch, to.pitch);
        zoom = toZoom = Math.exp(mix(Math.log(from.zoom), Math.log(to.zoom))); // even speed on a zoom
        pan.set(mix(from.x, to.x), mix(from.y, to.y));
        toPan.copy(pan);
        if (k >= 1) tween = null;
        moving = true;
      }
      zoom = damp(zoom, toZoom, 12);
      pan.set(damp(pan.x, toPan.x, 12), damp(pan.y, toPan.y, 12));
      camera.position.set(pan.x, pan.y, fitDist / zoom);
      view.yaw = damp(view.yaw, view.toYaw, 12);
      view.pitch = damp(view.pitch, view.toPitch, 12);
      shadow.visible = live.current.shadow;
      view.tiltX = damp(view.tiltX, view.toTiltX, 7);
      view.tiltY = damp(view.tiltY, view.toTiltY, 7);
      rig.rotation.set(view.pitch + view.tiltX, view.yaw + view.tiltY, 0);

      const docking = live.current.docked;
      if (docking && !dock) loadDock();
      if (docking !== seenDock) {
        seenDock = docking;
        // Swing round to a three-quarter view (as in device-docked.png) so the Dock reads in depth.
        if (!studio && !tween) {
          view.yaw -= Math.round(view.yaw / (Math.PI * 2)) * Math.PI * 2;
          view.toYaw = docking ? -0.5 : -0.3;
          view.toPitch = docking ? 0.2 : 0.12;
          toZoom = 1;
          toPan.set(0, 0);
        }
      }
      // Docking, in strict order so nothing passes through the Dock:
      //   the tray slides closed → the Dock fades up → the Device travels over the seat → it lowers in.
      // Undocking is the same backwards: it lifts out, travels back, the Dock fades away, then the tray slides open.
      const dockGoal = docking && dock ? DOCK_MS : 0;
      slide = damp(slide, live.current.open && !docking && dockT === 0 ? 1 : 0, 7);
      const trayShut = slide < 0.01;
      if (dockT !== dockGoal && (dockGoal === 0 || trayShut)) {
        dockT = THREE.MathUtils.clamp(dockT + (dockGoal ? 1 : -1) * dt * 1000, 0, DOCK_MS);
        moving = true;
      }
      const step = (from: number, len: number) => THREE.MathUtils.clamp((dockT - from) / len, 0, 1);
      const show = EASE.inOut(step(0, DOCK_FADE));
      const travel = EASE.inOut(step(DOCK_FADE, DOCK_TRAVEL));
      const land = EASE.inOut(step(DOCK_FADE + DOCK_TRAVEL, DOCK_LAND));
      if (model) {
        handPos.set(0, OPEN_SHIFT * slide, 0); // keep the whole Device centred on the pivot
        hoverPos.copy(seatPos).y += DOCK_HOVER;
        model.position.lerpVectors(handPos, hoverPos, travel);
        model.position.y -= DOCK_HOVER * land;
        model.quaternion.slerpQuaternions(identity, seatQuat, travel);
      }
      if (dock) {
        dock.visible = show > 0;
        dock.position.set(dockAt.x, dockAt.y - 24 * (1 - show), dockAt.z);
        setDockFade(show);
        if (indicator) {
          // The green charging light comes on once the contacts meet.
          const on = dockT >= DOCK_MS ? 1 : 0;
          const k = damp(indicator.emissiveIntensity / (indicatorOn.glow || 1), on, 6);
          indicator.emissiveIntensity = k * indicatorOn.glow;
          indicator.color.copy(indicatorOff).lerp(indicatorOn.color, k);
          indicator.opacity = show;
          if (indicator.transparent !== show < 1) { indicator.transparent = show < 1; indicator.needsUpdate = true; }
        }
      }
      // Pull back for the Dock as it appears, and come in again once it has gone.
      const e = EASE.inOut(step(0, DOCK_FADE + DOCK_TRAVEL));
      frameNow.w = THREE.MathUtils.lerp(frameHand.w, frameDock.w, e);
      // …and pull back a little more while it hovers over the seat, so its top stays in frame.
      frameNow.h = THREE.MathUtils.lerp(frameHand.h, frameDock.h, e) + DOCK_HOVER * travel * (1 - land);
      fitDist = fitFor(frameNow);
      if (mixer && slideClip) {
        slideClip.time = slide * slideClip.getClip().duration;
        mixer.update(0);
      }

      const press = (k: Part) => (depth[k] = damp(depth[k] || 0, (k === "mic" ? micHeld : now < (held[k] || 0)) ? 1 : 0, 38));
      for (const k of ["a", "b", "c", "d"] as const) if (node[k]) node[k]!.position.z = rest[k]!.z - 0.0006 * press(k);
      if (node.pushBar) node.pushBar.position.y = rest.pushBar!.y - 0.0006 * press("pushBar");
      if (node.mic) node.mic.position.x = rest.mic!.x + 0.0006 * press("mic");
      if (node.appWheel) node.appWheel.position.y = rest.appWheel!.y - 0.0005 * press("appWheel");
      if (micGlow) micGlow.emissiveIntensity = 0.9 * (depth.mic || 0);
      if (node.power) node.power.position.y = damp(node.power.position.y, rest.power!.y + (powered ? 0 : 0.0028), 22);
      if (node.kickstand) node.kickstand.rotation.x = damp(node.kickstand.rotation.x, standOut && !docking && dockT === 0 ? 0.95 : 0, 11);
      if (node.dpad) {
        const on = now < (held.dpad || 0) ? 0.09 : 0;
        dpadTilt.set(damp(dpadTilt.x, dpadTarget.x * on, 38), damp(dpadTilt.y, dpadTarget.y * on, 38));
        node.dpad.rotation.set(dpadTilt.x, dpadTilt.y, 0);
      }
      spin.systemWheel = damp(spin.systemWheel, spinTarget.systemWheel, 16);
      spin.appWheel = damp(spin.appWheel, spinTarget.appWheel, 16);
      if (node.systemWheel) node.systemWheel.rotation.z = -spin.systemWheel;
      if (node.appWheel) node.appWheel.rotation.y = -spin.appWheel;

      if (pushGlow) {
        const wanted = live.current.want;
        pushGlow.emissiveIntensity = damp(pushGlow.emissiveIntensity, wanted ? 0.75 + 0.45 * Math.sin(now / 260) : 0, 10);
        if (wanted) moving = true;
      }

      for (let i = ringList.length - 1; i >= 0; i--) {
        const r = ringList[i], s = spot(r.target);
        const still = r.hold && micHeld;
        if (still) r.t0 = now; // a held mic keeps its ring until it is let go
        const k = Math.min(1, (now - r.t0) / 520);
        if (k >= 1 || !s) {
          scene.remove(r.sprite);
          r.sprite.material.dispose();
          ringList.splice(i, 1);
        } else {
          const grow = 1 - (1 - k) ** 3;
          r.sprite.position.copy(s.world);
          r.sprite.scale.setScalar(2 * r.size * (still ? 1.5 + 0.12 * Math.sin(now / 130) : 1.1 + 0.9 * grow));
          r.sprite.material.opacity = still ? 0.6 : 0.75 * (1 - k) ** 1.5;
        }
        moving = true;
      }

      if (!moving) return;
      renderer.render(scene, camera);
      css.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      offPress();
      if (micHeld) emit({ c: "mic", phase: "up" });
      live.current.poke = () => { };
      live.current.zoomBy = () => { };
      host.style.filter = "";
      ringMap.dispose();
      scene.traverse(o => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
      });
      env.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      css.domElement.remove();
    };
  }, []);

  return <div className={"stage3d" + (studio ? " studio" : "")} ref={stage}>
    {createPortal(children, host)}
    {!loaded && <div className="stage3d-note">Loading the Device model…</div>}
    {!studio && <div className="stage3d-tip" ref={label} />}
    {!studio && <div className="stage3d-zoom">
      <button aria-label="Zoom out" onClick={() => live.current.zoomBy(1 / 1.5)}>−</button>
      <button aria-label="Zoom in" onClick={() => live.current.zoomBy(1.5)}>+</button>
    </div>}
  </div>;
}
