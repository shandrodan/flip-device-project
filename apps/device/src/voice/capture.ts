// Voice capture while the mic button is held.
//  "mic":    real microphone (MediaRecorder) streamed to the server, plus the browser's speech
//            recognition for an instant on-device transcript (the <2 s first reaction).
//  "script": rehearsal mode. A sample dump "plays" word by word, as if spoken. Reliable on stage.

export type VoiceSource = "mic" | "script";

export const SAMPLES = [
  {
    text: "okay so before Sunday I need to send Jonas the pitch deck, and my screenshots folder is a mess, clean it up but keep the ones from this week",
    clean: "Before Sunday I need to send Jonas the pitch deck. And my screenshots folder is a mess. Clean it up, but keep the ones from this week.",
  },
  { text: "remind me to call the venue about the projector adapter tomorrow morning", clean: "Remind me to call the venue about the projector adapter tomorrow morning." },
  { text: "can you find the best write-ups on WPE WebKit memory use and give me a short summary", clean: "Find the best write-ups on WPE WebKit memory use and give me a short summary." },
  { text: "oh and export the dock render, and archive the old renders folder on my laptop", clean: "Export the dock render, and archive the old renders folder on my laptop." },
  { text: "idea: the dock could show a tiny ring when an agent is busy", clean: "Idea: the dock could show a tiny ring when an agent is busy." },
];
/** Notes rehearsal lines, in order: a list, a related item, an explicit add, another note's topic, an explicit new note. */
export const PAD_SAMPLES = [
  { text: "grocery list", clean: "Grocery list" },
  { text: "carrots and potatoes", clean: "Carrots and potatoes." },
  { text: "add to this note, oat milk and eggs", clean: "Add to this note, oat milk and eggs." },
  { text: "remind me to ask the venue for two more extension cords", clean: "Remind me to ask the venue for two more extension cords." },
  { text: "new note, book the train back for Sunday evening", clean: "New note, book the train back for Sunday evening." },
];
/** To-Do rehearsal lines (ADR 0016): a dated task that fits a project, a hand-off to an agent, a plain errand. */
export const TODO_SAMPLES = [
  { text: "remind me to print the pitch deck tomorrow morning", clean: "Remind me to print the pitch deck tomorrow morning." },
  { text: "ask the mail agent to reply to Rasa about the venue Wi-Fi", clean: "Ask the mail agent to reply to Rasa about the venue Wi-Fi." },
  { text: "buy AA batteries for the haptic test rig", clean: "Buy AA batteries for the haptic test rig." },
];
const NAMES = ["Scout", "Juniper", "Echo", "Pixel", "Maple", "Orbit"];
/** Rehearsal lines for dictating a longer field, such as an agent's personality (ADR 0017). */
const TEXTS = [
  "Calm and short. Use plain words and no emoji.",
  "Cheerful, a little playful, and always says what it changed.",
  "Dry humour, very direct, never more than two sentences.",
];
const WORD_MS = 95;

export interface CaptureResult {
  durationMs: number;
  /** What the Device heard itself (speech recognition or the script so far). */
  hint: string;
  /** Script mode: what the cloud would hear. */
  cloudText?: string;
  audio?: Blob;
  mime: string;
}

export interface Capture {
  source: VoiceSource;
  mime: string;
  stop(): Promise<CaptureResult>;
  cancel(): void;
  level(): number;
}

interface Opts {
  onPartial(text: string): void;
  onChunk?(b: Blob): void;
  sample?: number;
  /** Script mode: play this line instead of a sample. */
  line?: { text: string; clean: string };
  purpose?: "note" | "name" | "text";
}

export function defaultSource(): VoiceSource {
  try {
    const saved = localStorage.getItem("flip-voice") as VoiceSource | null;
    if (saved) return saved;
  } catch { /* ignore */ }
  return window.isSecureContext && !!navigator.mediaDevices?.getUserMedia ? "mic" : "script";
}

export function nextSample() {
  let i = 0;
  try { i = Number(localStorage.getItem("flip-sample") || 0) % SAMPLES.length; localStorage.setItem("flip-sample", String((i + 1) % SAMPLES.length)); } catch { /* ignore */ }
  return i;
}

export function nextPadSample() {
  let i = 0;
  try { i = Number(localStorage.getItem("flip-pad-sample") || 0) % PAD_SAMPLES.length; localStorage.setItem("flip-pad-sample", String((i + 1) % PAD_SAMPLES.length)); } catch { /* ignore */ }
  return PAD_SAMPLES[i];
}

export function nextTodoSample() {
  let i = 0;
  try { i = Number(localStorage.getItem("flip-todo-sample") || 0) % TODO_SAMPLES.length; localStorage.setItem("flip-todo-sample", String((i + 1) % TODO_SAMPLES.length)); } catch { /* ignore */ }
  return TODO_SAMPLES[i];
}

export async function startCapture(source: VoiceSource, o: Opts): Promise<Capture> {
  return source === "mic" ? startMic(o) : startScript(o);
}

function startScript(o: Opts): Capture {
  const t0 = Date.now();
  const pick = (xs: string[]) => xs[Math.floor(Math.random() * xs.length)];
  const s = o.purpose === "name" ? { text: pick(NAMES), clean: "" } : o.purpose === "text" ? { text: pick(TEXTS), clean: "" } : o.line ?? SAMPLES[o.sample ?? 0];
  const words = s.text.split(" ");
  let n = 0;
  const id = window.setInterval(() => {
    n = Math.min(words.length, Math.floor((Date.now() - t0) / WORD_MS) + 1);
    o.onPartial(words.slice(0, n).join(" ") + (n < words.length ? " …" : ""));
  }, 60);
  return {
    source: "script",
    mime: "text/plain",
    level: () => 0.35 + Math.random() * 0.6,
    cancel: () => clearInterval(id),
    async stop() {
      clearInterval(id);
      const heard = Math.min(words.length, Math.floor((Date.now() - t0) / WORD_MS));
      const complete = heard >= words.length * 0.7;
      const raw = words.slice(0, heard).join(" ");
      const partial = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) + (heard < words.length ? "…" : "") : "";
      return { durationMs: Date.now() - t0, hint: complete ? s.text : partial, cloudText: complete ? s.clean || s.text : partial, mime: "text/plain" };
    },
  };
}

async function startMic(o: Opts): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const t0 = Date.now();
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find(m => MediaRecorder.isTypeSupported?.(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => {
    if (!e.data.size) return;
    chunks.push(e.data);
    o.onChunk?.(e.data);
  };
  rec.start(250);

  // Level meter for the bot's wobble.
  const ctx = new AudioContext();
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const level = () => {
    an.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / buf.length) * 5);
  };

  // On-device transcript, where the browser has one.
  const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
  let finalText = "", interim = "";
  let sr: any = null;
  if (SR) {
    try {
      sr = new SR();
      sr.continuous = true;
      sr.interimResults = true;
      sr.lang = navigator.language || "en-US";
      sr.onresult = (ev: any) => {
        interim = "";
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const r = ev.results[i];
          if (r.isFinal) finalText += r[0].transcript + " ";
          else interim += r[0].transcript;
        }
        o.onPartial((finalText + interim).trim());
      };
      sr.onerror = () => { /* keep recording audio anyway */ };
      sr.start();
    } catch { sr = null; }
  }

  const close = () => {
    try { sr?.stop(); } catch { /* ignore */ }
    stream.getTracks().forEach(t => t.stop());
    ctx.close().catch(() => {});
  };

  return {
    source: "mic",
    mime: rec.mimeType || mime || "audio/webm",
    level,
    cancel() {
      try { rec.stop(); } catch { /* ignore */ }
      close();
    },
    stop() {
      return new Promise<CaptureResult>(resolve => {
        rec.onstop = () => {
          // Give speech recognition a moment to deliver its last words.
          setTimeout(() => {
            close();
            const type = rec.mimeType || mime || "audio/webm";
            resolve({ durationMs: Date.now() - t0, hint: (finalText + interim).trim(), audio: new Blob(chunks, { type }), mime: type });
          }, sr ? 250 : 0);
        };
        rec.stop();
      });
    },
  };
}

export function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(b);
  });
}
