// What task agents can do, and how risky each thing is (ADR 0004, ADR 0008).
// Hard rules are fixed per tool: the model can't talk its way past them.
// Grey-zone tools carry an `ask_first` flag the model sets in Auto mode.
// Every tool calls ctx.gate first: in Manual mode that means every action waits for a press.
import type Anthropic from "@anthropic-ai/sdk";
import type { Agent, AgentPurpose, ApprovalRequest, FsEntry, PcAction, RiskKind, Task } from "@app/protocol";
import nodemailer from "nodemailer";
import { config } from "../config.js";

export interface PcResult { output: string; data: any }

export interface Ctx {
  task: Task;
  agent: Agent;
  /** Start a visible step on the Device. */
  step(text: string): void;
  /** Rename the current step (e.g. add a count once known). */
  stepText(text: string): void;
  /** Ask for an approval press if the rules say so. Throws Cancelled if the task is stopped. */
  gate(opts: { risk?: RiskKind; askFirst?: boolean; title: string; body?: string; preview?: ApprovalRequest["preview"] }): Promise<void>;
  /** Run a PC agent action. Throws MachineOffline, or ToolError when the machine says no. */
  pc(action: PcAction, args: Record<string, unknown>, machine?: string): Promise<PcResult>;
  machineName(machine?: string): string;
  hasShell(): boolean;
}

export class ToolError extends Error {}

type Input = Record<string, any>;
export interface ToolDef {
  name: string;
  description: string;
  props: Record<string, unknown>;
  required: string[];
  risk?: RiskKind;
  grey?: boolean; // gets an ask_first flag
  alwaysAsk?: boolean; // asks in Manual and Auto, never skipped except in Full
  purposes: AgentPurpose[] | "all";
  run(ctx: Ctx, input: Input): Promise<{ text: string; data?: any }>;
}

const SAY = { type: "string", description: "What you're doing, 3 to 8 words, shown on the user's device. Present tense, plain words, e.g. 'Moving 167 screenshots to Archive'." };
const MACHINE = { type: "string", description: "Machine name. Leave out to use the first one online." };
const ASK = { type: "boolean", description: "Auto mode: true if the user would want to confirm this before it happens (it is hard to undo, or touches things they care about). Sends and deletes always ask anyway." };
const PATH = (d: string) => ({ type: "string", description: d + " Use ~/ paths, e.g. ~/Desktop/Screenshots." });

const short = (s: string) => s.replace(/^~\//, "");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const mb = (b: number) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : b >= 1e3 ? `${Math.round(b / 1e3)} KB` : `${b} bytes`);

export const TOOLS: ToolDef[] = [
  {
    name: "list_files",
    description: "List a folder on one of the user's machines, newest first. Returns name, path, size, modified time and whether it is a folder.",
    props: { path: PATH("Folder to list."), machine: MACHINE, say: SAY },
    required: ["path", "say"],
    purposes: ["main", "pc", "files", "writer", "mail", "custom"],
    async run(ctx, i) {
      await ctx.gate({ title: `Look in ${short(i.path)}?`, body: `On ${ctx.machineName(i.machine)}.` });
      const r = await ctx.pc("fs.list", { path: i.path, limit: 500 }, i.machine);
      const entries = r.data as FsEntry[];
      ctx.stepText(`Scanned ${short(i.path)}, ${plural(entries.filter(e => !e.isDir).length, "file")}`);
      return { text: JSON.stringify(entries.slice(0, 300).map(e => ({ n: e.name, p: e.path, d: e.isDir || undefined, s: e.size, m: e.mtime.slice(0, 16) }))), data: entries };
    },
  },
  {
    name: "read_file",
    description: "Read a text file (first 20 KB) on one of the user's machines.",
    props: { path: PATH("File to read."), machine: MACHINE, say: SAY },
    required: ["path", "say"],
    purposes: ["main", "pc", "files", "writer", "mail", "custom"],
    async run(ctx, i) {
      await ctx.gate({ title: `Read ${short(i.path)}?`, body: `On ${ctx.machineName(i.machine)}.` });
      const r = await ctx.pc("fs.read", { path: i.path }, i.machine);
      return { text: r.data.text + (r.data.truncated ? "\n[truncated]" : "") };
    },
  },
  {
    name: "find_duplicates",
    description: "Find files with identical content in one folder. Returns groups with the oldest copy to keep and the duplicates.",
    props: { path: PATH("Folder to check."), machine: MACHINE, say: SAY },
    required: ["path", "say"],
    purposes: ["main", "pc", "files", "custom"],
    async run(ctx, i) {
      await ctx.gate({ title: `Check ${short(i.path)} for duplicates?` });
      const r = await ctx.pc("fs.duplicates", { path: i.path }, i.machine);
      ctx.stepText(r.output);
      return { text: JSON.stringify(r.data), data: r.data };
    },
  },
  {
    name: "write_file",
    description: "Write a text file (markdown, notes, drafts) on one of the user's machines. Never overwrites: a free name is picked. Put new work under ~/Flip unless the user named a place.",
    props: { path: PATH("File to create."), content: { type: "string" }, machine: MACHINE, say: SAY, ask_first: ASK },
    required: ["path", "content", "say"],
    grey: true,
    purposes: ["main", "pc", "files", "writer", "research", "mail", "custom"],
    async run(ctx, i) {
      await ctx.gate({ askFirst: i.ask_first, title: `Write ${short(i.path)}?`, body: `On ${ctx.machineName(i.machine)}.` });
      const r = await ctx.pc("fs.write", { path: i.path, content: i.content }, i.machine);
      ctx.stepText(`Wrote ${short(r.data.path)}`);
      return { text: r.output, data: r.data };
    },
  },
  {
    name: "make_folder",
    description: "Create a folder on one of the user's machines.",
    props: { path: PATH("Folder to create."), machine: MACHINE, say: SAY, ask_first: ASK },
    required: ["path", "say"],
    grey: true,
    purposes: ["main", "pc", "files", "custom"],
    async run(ctx, i) {
      await ctx.gate({ askFirst: i.ask_first, title: `Make ${short(i.path)}?` });
      const r = await ctx.pc("fs.mkdir", { path: i.path }, i.machine);
      return { text: r.output };
    },
  },
  {
    name: "move_files",
    description: "Move files or folders into a folder on the same machine (created if missing). Use this to archive or sort. Nothing is lost.",
    props: { paths: { type: "array", items: { type: "string" } }, to: PATH("Destination folder."), machine: MACHINE, say: SAY, ask_first: ASK },
    required: ["paths", "to", "say"],
    grey: true,
    purposes: ["main", "pc", "files", "custom"],
    async run(ctx, i) {
      const paths: string[] = i.paths || [];
      await ctx.gate({ askFirst: i.ask_first, title: `Move ${plural(paths.length, "item")}?`, body: `Into ${short(i.to)} on ${ctx.machineName(i.machine)}.`, preview: { files: paths.slice(0, 6) } });
      const r = await ctx.pc("fs.move", { paths, to: i.to }, i.machine);
      ctx.stepText(`Moved ${plural(r.data.moved, "item")} to ${short(i.to).split("/").pop()}`);
      return { text: r.output };
    },
  },
  {
    name: "trash_files",
    description: "Delete files. Always asks the user with a physical button press first. Files go to ~/.flip-trash on that machine so it can be undone.",
    props: { paths: { type: "array", items: { type: "string" } }, reason: { type: "string", description: "Why, in one short sentence the user will read, e.g. 'Duplicates in Screenshots, 48.2 MB.'" }, machine: MACHINE, say: SAY },
    required: ["paths", "reason", "say"],
    risk: "delete",
    purposes: ["main", "pc", "files", "custom"],
    async run(ctx, i) {
      const paths: string[] = i.paths || [];
      if (!paths.length) return { text: "Nothing to delete." };
      const m = ctx.machineName(i.machine);
      await ctx.gate({ risk: "delete", title: `Can I delete ${plural(paths.length, "file")}?`, body: `${i.reason || ""} On ${m}. I always ask before deleting.`.trim(), preview: { files: paths.slice(0, 6) } });
      const r = await ctx.pc("fs.trash", { paths }, i.machine);
      ctx.stepText(`Deleted ${plural(r.data.trashed, "file")}, ${mb(r.data.bytes)} back`);
      return { text: r.output };
    },
  },
  {
    name: "open_on_machine",
    description: "Open a file, folder or https URL on the user's machine so they see it on screen.",
    props: { target: { type: "string", description: "A ~/ path inside the allowed folders, or an https URL." }, machine: MACHINE, say: SAY },
    required: ["target", "say"],
    purposes: "all",
    async run(ctx, i) {
      await ctx.gate({ title: `Open ${short(String(i.target)).slice(0, 60)}?`, body: `On ${ctx.machineName(i.machine)}.` });
      const r = await ctx.pc("open", { target: i.target }, i.machine);
      return { text: r.output };
    },
  },
  {
    name: "notify",
    description: "Show a short desktop notification on the user's machine.",
    props: { title: { type: "string" }, body: { type: "string" }, machine: MACHINE, say: SAY },
    required: ["title", "body", "say"],
    purposes: "all",
    async run(ctx, i) {
      await ctx.gate({ title: "Show a notification?", body: i.title });
      const r = await ctx.pc("notify", { title: i.title, body: i.body }, i.machine);
      return { text: r.output };
    },
  },
  {
    name: "run_shell",
    description: "Run a shell command on the user's machine (only if that machine allows it). Always asks the user first unless Full mode is on.",
    props: { command: { type: "string" }, cwd: PATH("Working folder."), machine: MACHINE, say: SAY },
    required: ["command", "say"],
    alwaysAsk: true,
    purposes: ["main", "pc", "custom"],
    async run(ctx, i) {
      await ctx.gate({ askFirst: true, title: "Run this command?", body: i.command });
      const r = await ctx.pc("shell", { command: i.command, cwd: i.cwd }, i.machine);
      return { text: `${r.output}\n${r.data?.stdout ?? ""}` };
    },
  },
  {
    name: "send_email",
    description: "Send an email. Always asks the user with a physical button press first, showing the draft. Optionally attach one file from the user's machine.",
    props: {
      to: { type: "string", description: "Recipient name or email address." },
      subject: { type: "string" },
      body: { type: "string", description: "Plain text, short and friendly, in the user's voice." },
      attach_path: PATH("Optional file to attach."),
      machine: MACHINE,
      say: SAY,
    },
    required: ["to", "subject", "body", "say"],
    risk: "send",
    purposes: ["main", "mail", "custom"],
    async run(ctx, i) {
      let attach: { name: string; base64: string; bytes: number } | null = null;
      if (i.attach_path) {
        const r = await ctx.pc("fs.read", { path: i.attach_path, encoding: "base64" }, i.machine);
        attach = { name: r.data.name, base64: r.data.text, bytes: r.data.bytes };
      }
      const who = String(i.to);
      const address = who.includes("@") ? who : config.contacts[who.toLowerCase().split(" ")[0]];
      ctx.stepText(`Drafted the email to ${who}`);
      ctx.step(`Send the email to ${who}`);
      await ctx.gate({
        risk: "send",
        title: `Send this to ${who}?`,
        body: "Sending leaves your machines, so I always ask.",
        preview: { to: address ? `${who} <${address}>` : who, subject: i.subject, body: i.body, attach: attach ? `${attach.name} · ${mb(attach.bytes)}` : undefined },
      });
      if (config.smtpUrl && address) {
        const transport = nodemailer.createTransport(config.smtpUrl);
        await transport.sendMail({
          from: config.mailFrom || undefined,
          to: address,
          subject: i.subject,
          text: i.body,
          attachments: attach ? [{ filename: attach.name, content: Buffer.from(attach.base64, "base64") }] : undefined,
        });
        ctx.stepText(`Sent to ${who}`);
        return { text: `Sent to ${address}.` };
      }
      // No mail server: write a ready-to-send .eml and open it in the user's mail app.
      const eml = buildEml({ to: address || who, subject: i.subject, body: i.body, attach });
      const name = `~/Flip/Outbox/${i.subject.replace(/[^\w\- ]+/g, "").slice(0, 50) || "Email"}.eml`;
      const w = await ctx.pc("fs.write", { path: name, content: eml }, i.machine);
      const opened = await ctx.pc("open", { target: w.data.path }, i.machine).then(() => true, err => {
        if (err instanceof ToolError) return false;
        throw err;
      });
      ctx.stepText(opened ? "Put it in Outbox, opened in Mail" : `Saved to ${w.data.path}`);
      const why = !config.smtpUrl ? "No mail server is set up" : `I don't have an address for ${who}`;
      return {
        text: `${why}, so I saved the email to ${w.data.path}${opened ? " and opened it in the mail app. The user presses Send there." : ". Opening it failed on that machine, so the user opens it themselves."}`,
        data: { opened, path: w.data.path },
      };
    },
  },
];

function buildEml(m: { to: string; subject: string; body: string; attach: { name: string; base64: string } | null }) {
  const head = [`To: ${m.to}`, `Subject: ${m.subject}`, "X-Unsent: 1", "MIME-Version: 1.0"];
  if (!m.attach) return [...head, "Content-Type: text/plain; charset=utf-8", "", m.body, ""].join("\r\n");
  const b = "flip-" + Date.now().toString(36);
  const wrapped = m.attach.base64.replace(/.{1,76}/g, "$&\r\n");
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${b}"`,
    "",
    `--${b}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    m.body,
    `--${b}`,
    `Content-Type: application/octet-stream; name="${m.attach.name}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${m.attach.name}"`,
    "",
    wrapped,
    `--${b}--`,
    "",
  ].join("\r\n");
}

export function toolsFor(agent: Agent, opts: { shell: boolean }): ToolDef[] {
  return TOOLS.filter(t => (t.purposes === "all" || t.purposes.includes(agent.purpose)) && (t.name !== "run_shell" || opts.shell));
}

export function toApiTool(t: ToolDef): Anthropic.Beta.BetaTool {
  return {
    name: t.name,
    description: t.description,
    input_schema: { type: "object", properties: t.props, required: t.required },
  };
}

export const WEB_SEARCH_PURPOSES: AgentPurpose[] = ["main", "research", "writer", "custom"];
