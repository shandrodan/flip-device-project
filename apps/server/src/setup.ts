// /setup: the companion page for things the Device can't type (it has no keyboard):
// your AI key, speech-to-text key, and which machines run a PC agent.
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { state, secrets, saveSecrets, save, saveNow } from "./store.js";
import { cancelTask } from "./agents/runner.js";
import { anthropicKey, openRouterKey, llmMode } from "./llm.js";
import { sttMode } from "./voice.js";
import { machines } from "./machines.js";
import { bus } from "./bus.js";

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hint = (k: string) => (k ? `…${k.slice(-4)}` : "not set");

async function body(req: IncomingMessage) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e5) break;
  }
  return new URLSearchParams(raw);
}

export async function handleSetup(req: IncomingMessage, res: ServerResponse, url: URL) {
  const token = config.setupToken || config.deviceToken;
  if (token && url.searchParams.get("token") !== token) {
    res.writeHead(401, { "content-type": "text/plain" }).end("Add ?token=<SETUP_TOKEN> to the URL.");
    return;
  }
  let msg = "";
  if (req.method === "POST") {
    const f = await body(req);
    const action = f.get("action");
    if (action === "keys") {
      const patch: Record<string, string> = {};
      const router = (f.get("openRouterKey") || "").trim();
      if (router) patch.openRouterKey = router;
      if (f.get("clearOpenRouter")) patch.openRouterKey = "";
      const a = (f.get("anthropicKey") || "").trim();
      if (a) patch.anthropicKey = a;
      const s = (f.get("sttKey") || "").trim();
      if (s) patch.sttKey = s;
      const su = (f.get("sttUrl") || "").trim();
      if (su) patch.sttUrl = su;
      const sm = (f.get("sttModel") || "").trim();
      if (sm) patch.sttModel = sm;
      if (f.get("clearAnthropic")) patch.anthropicKey = "";
      if (f.get("clearStt")) patch.sttKey = "";
      saveSecrets(patch);
      msg = "Saved. Keys stay on this server.";
    } else if (action === "addMachine") {
      const name = (f.get("name") || "").trim(), u = (f.get("url") || "").trim();
      if (name && /^wss?:\/\//.test(u)) {
        state.machines = state.machines.filter(m => m.url !== u).concat({ name, url: u });
        save();
        machines.sync();
        msg = `Added ${name}.`;
      } else msg = "Give a name and a ws:// address.";
    } else if (action === "removeMachine") {
      state.machines = state.machines.filter(m => m.url !== f.get("url"));
      save();
      machines.sync();
      msg = "Removed.";
    } else if (action === "resetNotesTodos") {
      // Stop agent work first so nothing writes into the cleared lists.
      for (const task of [...state.tasks]) cancelTask(task.id);
      const notes = state.notes.length, tasks = state.tasks.length;
      state.notes = [];
      state.tasks = [];
      state.messages = [];
      state.approvals = [];
      saveNow();
      msg = `Cleared ${notes} ${notes === 1 ? "Note" : "Notes"} and ${tasks} ${tasks === 1 ? "To-Do" : "To-Dos"}.`;
    }
    bus.changed();
  }

  const list = machines.list();
  const tok = token ? `?token=${encodeURIComponent(token)}` : "";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device setup</title>
<style>
:root{--bg:#f5f5f7;--fg:#1d1d1f;--mute:#6e6e73;--card:#fff;--line:rgba(0,0,0,.08);--acc:#0a84ff}
@media (prefers-color-scheme:dark){:root{--bg:#000;--fg:#f5f5f7;--mute:#86868b;--card:#111113;--line:rgba(255,255,255,.1)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.47 -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
main{max-width:640px;margin:0 auto;padding:40px 16px 80px}h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px}p.lead{color:var(--mute);margin:0 0 24px}
section{background:var(--card);border-radius:18px;padding:18px 20px;margin:0 0 16px}h2{font-size:17px;margin:0 0 4px}.mute{color:var(--mute);font-size:13.5px}
label{display:block;font-size:13px;color:var(--mute);margin:12px 0 4px}input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit}
button{margin-top:14px;border:0;border-radius:999px;padding:9px 16px;background:var(--fg);color:var(--bg);font:600 14px system-ui;cursor:pointer}
.row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:10px 0;border-top:1px solid var(--line)}.row:first-of-type{border-top:0}
.chip{font-size:12px;padding:3px 9px;border-radius:999px;background:var(--line)}.ok{background:rgba(52,209,122,.18);color:#1f9d5a}.msg{padding:10px 14px;border-radius:12px;background:rgba(10,132,255,.12);margin-bottom:16px}
form.inline{display:inline}form.inline button{margin:0;padding:5px 10px;font-size:12px;background:var(--line);color:inherit}
</style></head><body><main>
<h1>Device setup</h1>
<p class="lead">The Device has no keyboard, so keys and machines are set here. Everything stays on this server.</p>
${msg ? `<div class="msg">${esc(msg)}</div>` : ""}
<section><h2>AI provider · bring your own key</h2>
<div class="mute">OpenRouter key: <b>${esc(hint(openRouterKey()))}</b> · ${esc(config.openRouterModel)} and Whisper Large V3 Turbo.<br>Anthropic key: <b>${esc(hint(anthropicKey()))}</b> · ${esc(config.agentModel)}. Active: ${llmMode()}.</div>
<form method="post" action="/setup${tok}"><input type="hidden" name="action" value="keys">
<label for="openRouterKey">OpenRouter API key</label><input id="openRouterKey" name="openRouterKey" type="password" autocomplete="off" placeholder="sk-or-v1-…">
<label>Anthropic API key</label><input name="anthropicKey" type="password" autocomplete="off" placeholder="sk-ant-…">
<label>Speech to text key (OpenAI-compatible, e.g. OpenAI or Groq)</label><input name="sttKey" type="password" autocomplete="off" placeholder="Currently ${hint(secrets.sttKey || config.sttKey)} · mode: ${sttMode()}">
<label>Speech to text URL</label><input name="sttUrl" placeholder="${esc(secrets.sttUrl || config.sttUrl)}">
<label>Speech to text model</label><input name="sttModel" placeholder="${esc(secrets.sttModel || config.sttModel)}">
<button>Save keys</button></form>
<form method="post" action="/setup${tok}" class="inline"><input type="hidden" name="action" value="keys"><input type="hidden" name="clearOpenRouter" value="1"><button style="margin-top:10px">Remove saved OpenRouter key</button></form>
<form method="post" action="/setup${tok}" class="inline"><input type="hidden" name="action" value="keys"><input type="hidden" name="clearAnthropic" value="1"><button style="margin-top:10px">Remove Anthropic key</button></form>
<form method="post" action="/setup${tok}" class="inline"><input type="hidden" name="action" value="keys"><input type="hidden" name="clearStt" value="1"><button style="margin-top:10px">Remove STT key</button></form>
</section>
<section><h2>Machines · Tailscale</h2>
<div class="mute">Run the PC agent on each machine, then add its Tailscale address. Token must match <code>PC_AGENT_TOKEN</code>.</div>
${list.map(m => `<div class="row"><span><b>${esc(m.name)}</b><br><span class="mute">${esc(m.url)}${m.roots ? " · " + esc(m.roots.join(", ")) : ""}</span></span>
<span><span class="chip ${m.online ? "ok" : ""}">${m.online ? "Online" : "Offline"}</span>
<form method="post" action="/setup${tok}" class="inline"><input type="hidden" name="action" value="removeMachine"><input type="hidden" name="url" value="${esc(m.url)}"><button>Remove</button></form></span></div>`).join("")}
<form method="post" action="/setup${tok}"><input type="hidden" name="action" value="addMachine">
<label>Name</label><input name="name" placeholder="MacBook Pro"><label>Address</label><input name="url" placeholder="ws://100.101.102.103:7077"><button>Add machine</button></form>
</section>
<section><h2>Status</h2><div class="mute">Permission mode: ${state.permissionMode} · Hosting: ${state.hosting} · Mail: ${config.smtpUrl ? "SMTP" : "Outbox (.eml)"} · Notes: ${state.notes.length} · Tasks: ${state.tasks.length}</div></section>
<section><h2>Reset Device data</h2>
<div class="mute">Deletes every saved Note and To-Do and stops agent work in progress. Agents, projects, settings, keys and machines stay.</div>
<form method="post" action="/setup${tok}" onsubmit="return confirm('Delete all ${state.notes.length} Notes and ${state.tasks.length} To-Dos? This can\\'t be undone.')"><input type="hidden" name="action" value="resetNotesTodos">
<button style="background:#ff453a;color:#fff">Reset Notes and To-Dos</button></form>
</section>
</main></body></html>`);
}
