// The Device screen from the Pi-class VM (ADR 0024, pi-vm/). `/?remote=http://localhost:17900`
// shows the kiosk browser running on the VM instead of a local DeviceApp. Every control press on
// the twin (model, panel, keyboard, gamepad, `studio.press`) goes back to the VM as the key the
// Device's keymap uses, so the VM's UI reacts exactly as if the keyboard were plugged into it.
// While the mic is held, this laptop's microphone is streamed to the VM, where the kiosk records
// it as the Device's own mic and the VM's server transcribes it.
import { useEffect } from "react";
import { KEYMAP, onPress, type ControlEvent } from "../input/controls";

/** The VM's relay, from `?remote=`. Null: render the Device locally, as usual. */
export const remoteUrl = new URLSearchParams(location.search).get("remote")?.replace(/\/$/, "") || null;

const codeFor = (e: ControlEvent) => {
  if (e.c === "mic") return "Space";
  return Object.entries(KEYMAP).find(([code, m]) =>
    m.c === e.c && (m.dir ?? 0) === (e.dir ?? 0) && code !== "Escape" && code !== "Backspace")?.[0];
};

/* One ordered line to the VM: keys and audio in the order they happened, audio batched. */
type Item = { code: string; type: string } | Int16Array;
const line: Item[] = [];
let busy = false;
async function pump(url: string) {
  if (busy) return;
  busy = true;
  while (line.length) {
    try {
      if (line[0] instanceof Int16Array) {
        const parts: Int16Array[] = [];
        while (line[0] instanceof Int16Array) parts.push(line.shift() as Int16Array);
        const all = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
        let at = 0;
        for (const p of parts) { all.set(p, at); at += p.length; }
        await fetch(`${url}/mic`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: all.buffer });
      } else {
        await fetch(`${url}/key`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(line.shift()) });
      }
    } catch { /* the VM is unreachable: drop it, the screen shows the truth */ }
  }
  busy = false;
}

/* The laptop's mic, opened on the first hold and kept open so later holds lose no words. */
const WORKLET = `registerProcessor("pcm", class extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Int16Array(2048); this.n = 0; }
  process([input]) {
    const ch = input[0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = Math.max(-32768, Math.min(32767, ch[i] * 32768));
      if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Int16Array(2048); this.n = 0; }
    }
    return true;
  }
});`;
let mic: Promise<void> | null = null;
let held = false;
function openMic(url: string) {
  mic ??= (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    const ctx = new AudioContext({ sampleRate: 48000 }); // what the VM's mic pipe expects
    await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" })));
    const node = new AudioWorkletNode(ctx, "pcm");
    node.port.onmessage = (ev: MessageEvent<Int16Array>) => {
      if (!held) return;
      line.push(ev.data);
      void pump(url);
    };
    ctx.createMediaStreamSource(stream).connect(node);
    await ctx.resume();
  })().catch(err => { mic = null; console.warn("[remote] no microphone:", err); });
  return mic;
}

export function RemoteScreen({ url }: { url: string }) {
  useEffect(() => onPress(e => {
    const code = codeFor(e);
    if (!code) return;
    if (e.c === "mic") {
      held = e.phase !== "up";
      if (held) void openMic(url);
    }
    line.push({ code, type: e.c === "mic" ? e.phase ?? "press" : "press" });
    void pump(url);
  }), [url]);
  return <img src={`${url}/stream`} alt="Device screen, streamed from the VM" draggable={false}
    style={{ display: "block", width: "100%", height: "100%", objectFit: "contain", background: "#000" }} />;
}
