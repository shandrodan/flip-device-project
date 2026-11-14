// Speech to text (ADR 0009). Cloud first; a local whisper server as fallback; otherwise the
// Device's own transcript (the browser's speech recognition) is used as-is.
import { config } from "./config.js";
import { openRouterKey } from "./llm.js";
import { secrets } from "./store.js";

export type SttResult = { text: string; by: "cloud" | "local" } | null;

const cloudUrl = () => secrets.sttUrl || config.sttUrl;
const cloudKey = () => secrets.sttKey || config.sttKey;
const cloudModel = () => secrets.sttModel || config.sttModel;

export function sttMode(): "cloud" | "local" | "device" {
  if (openRouterKey() || cloudKey()) return "cloud";
  if (config.localSttUrl) return "local";
  return "device";
}

/** Dumps are transcribed as English only, so Whisper never guesses another language. */
const STT_LANGUAGE = "en";

async function post(url: string, key: string, model: string, audio: Buffer, mime: string, openRouter = false): Promise<string> {
  const ext = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : mime.includes("wav") ? "wav" : "webm";
  let body: string | FormData;
  if (openRouter) {
    body = JSON.stringify({ model, language: STT_LANGUAGE, input_audio: { data: audio.toString("base64"), format: ext } });
  } else {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), `dump.${ext}`);
    form.append("model", model);
    form.append("language", STT_LANGUAGE);
    form.append("response_format", "json");
    body = form;
  }
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(openRouter ? { "Content-Type": "application/json" } : {}),
    },
    body,
    redirect: openRouter ? "error" : "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`STT request failed (HTTP ${res.status}).`);
  const j = (await res.json()) as { text?: string };
  return (j.text || "").trim();
}

export async function transcribe(audio: Buffer, mime: string): Promise<SttResult> {
  if (audio.length < 2000) return null; // too short to be speech
  const key = openRouterKey();
  if (key) {
    try {
      const text = await post("https://openrouter.ai/api/v1/audio/transcriptions", key, "openai/whisper-large-v3-turbo", audio, mime, true);
      if (text) return { text, by: "cloud" };
    } catch (err) {
      console.warn("[voice] OpenRouter transcription failed:", (err as Error).message);
    }
  }
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
