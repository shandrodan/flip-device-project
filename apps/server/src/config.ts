import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(SERVER_ROOT, "../..");

// Tiny .env loader (repo root, then apps/server). Real env vars win.
for (const file of [path.join(REPO_ROOT, ".env"), path.join(SERVER_ROOT, ".env")]) {
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const env = (k: string, d = "") => process.env[k] ?? d;

export const config = {
  port: Number(env("PORT", "8787")),
  host: env("HOST", "0.0.0.0"),
  dataDir: path.resolve(env("DATA_DIR", path.join(SERVER_ROOT, "data"))),
  /** Public URL of this server, shown on the Device for the setup page. */
  publicUrl: env("PUBLIC_URL", ""),
  setupToken: env("SETUP_TOKEN", ""),
  hosting: (env("HOSTING", "self") as "cloud" | "vm" | "self"),

  anthropicKey: env("ANTHROPIC_API_KEY", ""),
  agentModel: env("AGENT_MODEL", "claude-opus-5-5"),
  suggestModel: env("SUGGEST_MODEL", "claude-opus-5-5"),

  // Speech to text. Any OpenAI-compatible /audio/transcriptions endpoint works
  // (OpenAI, Groq, or a local faster-whisper / whisper.cpp server).
  sttUrl: env("STT_URL", "https://api.openai.com/v1/audio/transcriptions"),
  sttKey: env("STT_API_KEY", ""),
  sttModel: env("STT_MODEL", "whisper-1"),
  localSttUrl: env("LOCAL_STT_URL", ""),
  localSttModel: env("LOCAL_STT_MODEL", "whisper-1"),

  // PC agents: "Name=ws://100.x.y.z:7077,Other=ws://..." (Tailscale addresses)
  pcAgents: env("PC_AGENTS", "This computer=ws://127.0.0.1:7077"),
  pcToken: env("PC_AGENT_TOKEN", "dev-token"),

  // Mail. Without SMTP, "send" saves an .eml to ~/Flip/Outbox and opens it.
  smtpUrl: env("SMTP_URL", ""),
  mailFrom: env("MAIL_FROM", ""),
  contacts: Object.fromEntries(
    env("CONTACTS", "")
      .split(",")
      .map(x => x.split("=").map(s => s.trim()))
      .filter(([n, e]) => n && e)
      .map(([n, e]) => [n.toLowerCase(), e]),
  ) as Record<string, string>,
};

fs.mkdirSync(config.dataDir, { recursive: true });
