// Speech to text (ADR 0009). Cloud first; a local whisper server as fallback; otherwise the
// Device's own transcript (the browser's speech recognition) is used as-is.
import { config } from "./config.js";
import { secrets } from "./store.js";

export type SttResult = { text: string; by: "cloud" | "local" } | null;

const cloudUrl = () => secrets.sttUrl || config.sttUrl;
const cloudKey = () => secrets.sttKey || config.sttKey;
const cloudModel = () => secrets.sttModel || config.sttModel;

export function sttMode(): "cloud" | "local" | "device" {
  if (cloudKey()) return "cloud";
  if (config.localSttUrl) return "local";
  return "device";
}

async function post(url: string, key: string, model: string, audio: Buffer, mime: string): Promise<string> {
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), `dump.${ext}`);
  form.append("model", model);
  form.append("response_format", "json");
  const res = await fetch(url, {
    method: "POST",
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`STT ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string };
  return (j.text || "").trim();
}

export async function transcribe(audio: Buffer, mime: string): Promise<SttResult> {
  if (audio.length < 2000) return null; // too short to be speech
  if (cloudKey()) {
    try {
      const text = await post(cloudUrl(), cloudKey(), cloudModel(), audio, mime);
      if (text) return { text, by: "cloud" };
    } catch (err) {
      console.warn("[voice] cloud transcription failed:", (err as Error).message);
    }
  }
  if (config.localSttUrl) {
    try {
      const text = await post(config.localSttUrl, "", config.localSttModel, audio, mime);
      if (text) return { text, by: "local" };
    } catch (err) {
      console.warn("[voice] local transcription failed:", (err as Error).message);
    }
  }
  return null;
}
