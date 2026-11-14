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

const SCREEN_W = 784, SCREEN_H = 504;
const FOV = 26;
/** Half extents to keep in frame, in mm: the Device with its tray out, plus breathing room. */
const FRAME_W = 86, FRAME_H = 78;
/** How far the Device's centre drops when the tray is out (tray travels 32 mm). */
const OPEN_SHIFT = 16;

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
const partOf = (name: string) => PARTS.find(([re]) => re.test(name))?.[1];

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

export default function Device3D({ open, want, resetView, onToggleOpen, onFail, children }: {
  /** Tray slid out (controls showing) or closed. */
  open: boolean;
  /** An approval press is wanted: the push bar glows. */
  want: boolean;
  /** Bump to bring the camera back to the front. */
  resetView: number;
  /** The shell was clicked: slide the tray the other way. */
  onToggleOpen?: () => void;
  /** WebGL or the model is not available. */
  onFail?: () => void;
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
  const live = useRef({ open, want, resetView, onToggleOpen, poke: () => { }, zoomBy: (_f: number) => { } });
  live.current.onToggleOpen = onToggleOpen;
  live.current.open = open;
  live.current.want = want;
  live.current.resetView = resetView;
  useEffect(() => { live.current.poke(); }, [open, want, resetView]);

  useEffect(() => {
    const el = stage.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      onFail?.();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
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
    const rimLight = new THREE.DirectionalLight(0xdfe8ff, 0.9);
    rimLight.position.set(300, 80, -260);
    scene.add(keyLight, rimLight);
    const camera = new THREE.PerspectiveCamera(FOV, 1, 20, 3000);

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
    const fit = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      css.setSize(w, h);
      camera.aspect = w / h;
      fitDist = Math.max(FRAME_H / tanHalf, FRAME_W / (tanHalf * camera.aspect));
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

      // Keep the surface textures sharp at grazing angles and up close.
      const aniso = renderer.capabilities.getMaxAnisotropy();
      model.traverse(o => {
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
      // Arrive with a small turn and the tray sliding out.
      view.yaw = -0.7; view.pitch = 0.28; slide = 0; zoom = 0.86;
      dirty = true;
      setLoaded(true);
    }, undefined, () => { if (!dead) onFail?.(); });

    let slide = live.current.open ? 1 : 0;

    // ---- Control feedback: every press moves its part, wherever the press came from ----
    const held: Partial<Record<Part, number>> = {}; // part → time the press visibly ends
    const depth: Partial<Record<Part, number>> = {}; // 0 = at rest, 1 = fully in
    const dpadTilt = new THREE.Vector2(), dpadTarget = new THREE.Vector2();
    const spin = { systemWheel: 0, appWheel: 0 }, spinTarget = { systemWheel: 0, appWheel: 0 };
    let micHeld = false;
    const offPress = onPress(e => {
      dirty = true;
      if (e.c === "mic") { micHeld = e.phase === "down"; return; }
      if (e.c === "systemWheel" || e.c === "appWheel") { spinTarget[e.c] += (e.dir || 1) * (Math.PI / 6); return; }
      const now = performance.now();
      if (e.c === "up" || e.c === "down" || e.c === "left" || e.c === "right") {
        dpadTarget.set(e.c === "up" ? -1 : e.c === "down" ? 1 : 0, e.c === "right" ? 1 : e.c === "left" ? -1 : 0);
        held.dpad = now + 130;
        return;
      }
      held[e.c === "appWheelPress" ? "appWheel" : e.c] = now + 130;
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
      const next = THREE.MathUtils.clamp(toZoom * factor, 1, MAX_ZOOM);
      const before = (tanHalf * fitDist) / toZoom, after = (tanHalf * fitDist) / next;
      toPan.x += x * camera.aspect * (before - after);
      toPan.y += y * (before - after);
      toZoom = next;
      clampPan();
      dirty = true;
    };
    const clampPan = () => {
      const reach = 1 - 1 / toZoom; // nothing to pan to when the whole Device is in frame
      toPan.set(THREE.MathUtils.clamp(toPan.x, -FRAME_W * reach, FRAME_W * reach), THREE.MathUtils.clamp(toPan.y, -FRAME_H * reach, FRAME_H * reach));
    };
    live.current.zoomBy = f => zoomAt(0, 0, f);

    let powered = true, standOut = false;
    type Mode = null | "orbit" | "pan" | "pinch" | { wheel: "systemWheel" | "appWheel"; acc: number; turned: boolean; back: boolean };
    let mode: Mode = null;
    let moved = 0, onShell = false, pinch = 0;
    const touches = new Map<number, { x: number; y: number }>();
    let seenReset = live.current.resetView;
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
      canvas.setPointerCapture(ev.pointerId);
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
      } else if (part === "power") { powered = !powered; host.style.filter = powered ? "" : "brightness(0)"; dirty = true; }
      else if (part === "kickstand") { standOut = !standOut; dirty = true; }
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
        view.toTiltY = n.x * 0.07;
        view.toTiltX = -n.y * 0.05;
        const part = pick(ev)?.part;
        canvas.style.cursor = part ? "pointer" : "grab";
        tip(part ? LABEL[part] : null, ev);
        dirty = true;
      }
    };
    const up = (ev: PointerEvent) => {
      if (!touches.delete(ev.pointerId)) return;
      if (micHeld) emit({ c: "mic", phase: "up" });
      if (mode === "orbit" && moved < 5 && onShell) live.current.onToggleOpen?.();
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
      zoom = damp(zoom, toZoom, 12);
      pan.set(damp(pan.x, toPan.x, 12), damp(pan.y, toPan.y, 12));
      camera.position.set(pan.x, pan.y, fitDist / zoom);
      view.yaw = damp(view.yaw, view.toYaw, 12);
      view.pitch = damp(view.pitch, view.toPitch, 12);
      view.tiltX = damp(view.tiltX, view.toTiltX, 7);
      view.tiltY = damp(view.tiltY, view.toTiltY, 7);
      rig.rotation.set(view.pitch + view.tiltX, view.yaw + view.tiltY, 0);

      slide = damp(slide, live.current.open ? 1 : 0, 9);
      if (model) model.position.y = OPEN_SHIFT * slide; // keep the whole Device centred on the pivot
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
      if (node.kickstand) node.kickstand.rotation.x = damp(node.kickstand.rotation.x, standOut ? 0.95 : 0, 11);
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

  return <div className="stage3d" ref={stage}>
    {createPortal(children, host)}
    {!loaded && <div className="stage3d-note">Loading the Device model…</div>}
    <div className="stage3d-tip" ref={label} />
    <div className="stage3d-zoom">
      <button aria-label="Zoom out" onClick={() => live.current.zoomBy(1 / 1.5)}>−</button>
      <button aria-label="Zoom in" onClick={() => live.current.zoomBy(1.5)}>+</button>
    </div>
  </div>;
}
