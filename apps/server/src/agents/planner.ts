// Runs when the server has no AI key: fixed plans for the common jobs, built from the same
// tools (and the same approval rules) the Claude agents use. Reliable for rehearsals and offline demos.
import type { FsEntry } from "@app/protocol";
import { TOOLS, ToolError, type Ctx } from "./tools.js";
import { noteById, state } from "../store.js";
import { requestText } from "./coordination.js";

async function use(ctx: Ctx, name: string, input: Record<string, any>) {
  const def = TOOLS.find(t => t.name === name)!;
  ctx.step(input.say);
  return def.run(ctx, input);
}

/** Opening a file on screen is a nicety: if the machine can't (no desktop), carry on. */
async function show(ctx: Ctx, target: string, say: string) {
  try {
    await use(ctx, "open_on_machine", { target, say });
    return true;
  } catch (err) {
    if (!(err instanceof ToolError)) throw err;
    ctx.stepText("Couldn't open it on screen there");
    return false;
  }
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const size = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} bytes`);
const STOP = new Set(["the", "a", "an", "my", "old", "up", "folder", "folders", "files", "on", "laptop", "macbook", "computer", "archive", "move", "clean", "tidy", "to", "of", "and", "from", "in", "this", "that", "week", "but", "keep", "ones", "it"]);

export async function runPlanner(ctx: Ctx): Promise<string> {
  const title = requestText(ctx.task);
  const t = title.toLowerCase();
  const ask = title.match(/^ask (.+?) to (.+)$/i);
  if (ask) {
    const name = ask[1].trim().toLowerCase();
    const recipient = state.agents.find(agent => agent.id !== ctx.agent.id && (agent.name.toLowerCase() === name || agent.id.toLowerCase() === name));
    if (recipient) {
      ctx.step(`Asking ${recipient.name}`);
      await ctx.gate({ title: `Ask ${recipient.name} to work?`, body: ask[2].slice(0, 120) });
      ctx.sendAgentMessage(recipient.id, ask[2], true);
      return (await ctx.waitForChildren()) ?? "The request did not return a result.";
    }
  }
  const todo = title.match(/^(?:add|create|make) (?:me )?(?:a )?(?:to-?do|task)(?: to|:)? (.+)$/i);
  if (todo) return (await use(ctx, "change_app", { action: "todo.create", text: todo[1], say: "Adding a To-Do" })).text;
  const note = title.match(/^save (?:a )?note (?:that|to|:)? (.+)$/i);
  if (note) return (await use(ctx, "change_app", { action: "notes.create", text: note[1], say: "Saving a Note" })).text;
  const focus = title.match(/^start (?:a )?focus(?: timer)? for (\d+) minutes?$/i);
  if (focus) return (await use(ctx, "change_app", { action: "focus.start", minutes: Number(focus[1]), say: "Starting focus" })).text;
  if (/^stop (?:the )?focus(?: timer)?$/i.test(title))
    return (await use(ctx, "change_app", { action: "focus.stop", say: "Stopping focus" })).text;
  const mode = title.match(/^(?:set|change) (?:the )?permission mode (?:to )?(manual|auto)$/i);
  if (mode) return (await use(ctx, "change_app", { action: "settings.permission", mode: mode[1].toLowerCase(), say: "Changing permission mode" })).text;
  const newAgent = title.match(/^(?:create|make) (?:a )?(?:task )?agent (.+?) (?:to|for) (.+)$/i);
  if (newAgent) return (await use(ctx, "change_app", { action: "agents.create", name: newAgent[1], role: newAgent[2], say: "Making a Task agent" })).text;
  if (ctx.agent.id === "main" && ctx.task.requestMessageId && (ctx.task.depth ?? 0) === 0) {
    const purposes = /\b(send|email|mail|reply)\b/.test(t) ? ["mail"]
      : /\b(screenshot|folder|file|clean|tidy|archive|move|duplicate)\b/.test(t) ? ["files", "pc"]
      : /\b(research|look up|compare|summari[sz]e)\b/.test(t) ? ["research"]
      : /\b(write|draft|document)\b/.test(t) ? ["writer"] : [];
    const recipient = state.agents.find(agent => agent.id !== "main" && purposes.includes(agent.purpose));
    if (recipient) {
      ctx.step(`Asking ${recipient.name} to work`);
      await ctx.gate({ title: `Ask ${recipient.name} to work?`, body: title.slice(0, 120) });
      ctx.sendAgentMessage(recipient.id, title, true);
      return (await ctx.waitForChildren()) ?? "The request did not return a result.";
    }
  }
  if (ctx.agent.purpose === "mail" || /\b(send|email|e-mail|mail)\b/.test(t)) return emailPlan(ctx);
  if (/\b(research|look up|find out|summari[sz]e|write-?ups?|compare)\b/.test(t)) return researchPlan(ctx);
  if (/\b(screenshots?|clean|tidy|declutter|organi[sz]e|duplicates?)\b/.test(t)) return cleanupPlan(ctx);
  if (/\b(archive|move)\b/.test(t)) return archivePlan(ctx);
  if (ctx.task.requestMessageId && !/\b(write|draft|make|create)\b/.test(t))
    return "I heard you. With no AI key, I can add a To-Do, start focus, send email, or work with files. Add an AI key for open questions.";
  return writePlan(ctx);
}

async function listFirst(ctx: Ctx, paths: string[]): Promise<{ path: string; entries: FsEntry[] }> {
  let lastErr: Error | null = null;
  for (const path of paths) {
    try {
      const r = await use(ctx, "list_files", { path, say: `Looking in ${path.replace(/^~\//, "")}` });
      return { path, entries: r.data as FsEntry[] };
    } catch (err) {
      if (!(err instanceof ToolError)) throw err;
      lastErr = err;
    }
  }
  throw new ToolError(lastErr ? `Couldn't find the folder: ${lastErr.message}` : "Couldn't find the folder");
}

async function cleanupPlan(ctx: Ctx) {
  const t = ctx.task.title.toLowerCase();
  const shots = /screenshot/.test(t);
  const candidates = shots ? ["~/Desktop/Screenshots", "~/Pictures/Screenshots", "~/Desktop"] : /download/.test(t) ? ["~/Downloads"] : ["~/Desktop", "~/Downloads"];
  const { path, entries } = await listFirst(ctx, candidates);
  let files = entries.filter(e => !e.isDir);
  if (shots && !/Screenshots$/.test(path)) files = files.filter(e => /^(screen ?shot|cleanshot|capture)/i.test(e.name));
  if (!files.length) return `Nothing to tidy in ${path}.`;

  const weekAgo = Date.now() - 7 * 864e5;
  const recent = files.filter(f => Date.parse(f.mtime) >= weekAgo);
  const older = files.filter(f => Date.parse(f.mtime) < weekAgo);
  const archive = `${path}/Archive`;
  if (older.length) {
    await use(ctx, "move_files", { paths: older.map(f => f.path), to: archive, say: `Moving ${plural(older.length, "older file")} to Archive` });
  }

  const dup = await use(ctx, "find_duplicates", { path, say: "Looking for duplicates" });
  const groups = (dup.data?.groups || []) as { keep: string; dupes: string[]; size: number }[];
  const dupes = groups.flatMap(g => g.dupes);
  const bytes = groups.reduce((s, g) => s + g.size * g.dupes.length, 0);
  if (dupes.length) {
    await use(ctx, "trash_files", { paths: dupes, reason: `Duplicates in ${path.split("/").pop()}, ${size(bytes)}.`, say: `Delete ${plural(dupes.length, "duplicate")}` });
  }
  const kept = recent.length - dupes.length;
  await use(ctx, "notify", { title: "Tidied up", body: `${path}: kept ${kept} from this week, archived ${older.length}, removed ${dupes.length} duplicates.`, say: "Letting you know on screen" }).catch(() => null);
  return `Kept ${kept} from this week, moved ${older.length} to Archive${dupes.length ? `, deleted ${plural(dupes.length, "duplicate")}` : ""}.`;
}

async function archivePlan(ctx: Ctx) {
  const words = ctx.task.title.toLowerCase().replace(/[^\w\s-]/g, "").split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
  if (!words.length) throw new ToolError("I couldn't tell which folder to archive.");
  for (const base of ["~/Desktop", "~/Documents", "~/Downloads", "~/Flip"]) {
    let entries: FsEntry[];
    try {
      entries = (await use(ctx, "list_files", { path: base, say: `Looking in ${base.slice(2)}` })).data;
    } catch (err) {
      if (err instanceof ToolError) continue;
      throw err;
    }
    const hit = entries.find(e => words.some(w => e.name.toLowerCase().includes(w)));
    if (hit) {
      await use(ctx, "move_files", { paths: [hit.path], to: "~/Flip/Archive", say: `Moving ${hit.name} to Archive` });
      return `Moved ${hit.name} to ~/Flip/Archive.`;
    }
  }
  throw new ToolError(`I couldn't find "${words.join(" ")}" on your Desktop, Documents or Downloads.`);
}

async function emailPlan(ctx: Ctx) {
  const title = ctx.task.title;
  const who = title.match(/\b(?:to|email|mail|send|message)\s+([A-Z][\w-]+)/)?.[1] || title.match(/\b([A-Z][a-z]+)\b(?!.*\b[A-Z][a-z]+\b)/)?.[1] || "them";
  const what = title.replace(/^(send|email|mail)\s+/i, "").replace(new RegExp(`\\b(to )?${who}\\b`), "").replace(/\s+/g, " ").trim() || "update";
  let attach: string | undefined;
  if (/\b(deck|pdf|slides|doc|report|file|invoice|cv|resume|contract|render|photo|image)\b/i.test(what)) {
    const keys = what.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
    const found: FsEntry[] = [];
    for (const base of ["~/Downloads", "~/Desktop", "~/Documents"]) {
      try {
        const r = await use(ctx, "list_files", { path: base, say: `Looking for the ${what} in ${base.slice(2)}` });
        found.push(...(r.data as FsEntry[]).filter(e => !e.isDir));
      } catch (err) {
        if (!(err instanceof ToolError)) throw err;
      }
      const match = found.filter(f => keys.some(k => f.name.toLowerCase().includes(k)) || (/deck|slides/.test(what) && /pitch|deck|slides/i.test(f.name)));
      const pick = match.sort((a, b) => b.mtime.localeCompare(a.mtime))[0];
      if (pick) {
        attach = pick.path;
        ctx.stepText(`Found ${pick.name}`);
        break;
      }
    }
  }
  const subject = what.charAt(0).toUpperCase() + what.slice(1);
  const body = `Hi ${who},\n\nHere's the ${what}${attach ? " (attached)" : ""}. Shout if anything looks off.\n\nThanks!`;
  const r = await use(ctx, "send_email", { to: who, subject, body, attach_path: attach, say: `Drafting the email to ${who}` });
  if (r.text.startsWith("Sent")) return `Sent to ${who}.`;
  return r.data?.opened ? `Saved the email to ${who} in Outbox and opened it in Mail. Press Send there.` : `Saved the email to ${who} in ${r.data?.path ?? "~/Flip/Outbox"}.`;
}

async function researchPlan(ctx: Ctx) {
  const q = ctx.task.title.replace(/^(research|look up|find out about|find|summari[sz]e)\s+/i, "");
  const note = ctx.task.noteId ? noteById(ctx.task.noteId) : undefined;
  const url = `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
  const file = `~/Flip/Research/${q.replace(/[^\w\- ]+/g, "").slice(0, 50)}.md`;
  const content = `# ${ctx.task.title}\n\n${note ? `> ${note.text}\n\n` : ""}No AI key on the server yet, so this is a starting point, not a summary.\n\n- [Search the web](${url})\n- [Search Hacker News](https://hn.algolia.com/?q=${encodeURIComponent(q)})\n\n## Notes\n\n`;
  const w = await use(ctx, "write_file", { path: file, content, say: "Writing a research brief" });
  const opened = await show(ctx, url, "Opening a web search");
  return `No AI key on the server, so I ${opened ? "opened a web search and " : ""}saved a brief with search links in ${w.data.path}.`;
}

async function writePlan(ctx: Ctx) {
  const note = ctx.task.noteId ? noteById(ctx.task.noteId) : undefined;
  const file = `~/Flip/Tasks/${ctx.task.title.replace(/[^\w\- ]+/g, "").slice(0, 50)}.md`;
  const content = `# ${ctx.task.title}\n\n${note ? `From your note:\n\n> ${note.text}\n\n` : ""}- [ ] ${ctx.task.title}\n`;
  const w = await use(ctx, "write_file", { path: file, content, say: "Writing it down on your computer" });
  const opened = await show(ctx, w.data.path, "Opening it");
  return `Wrote it up in ${w.data.path}${opened ? " and opened it" : ""}.`;
}
