// Build app tools (ADR 0021). The agent that serves Build (its assigned agent, or the main agent
// when it has none) works inside one project folder on the user's machine and sets the preview the
// Device shows. Paths are relative to the project, and nothing can step outside it.
import type { FsEntry } from "@app/protocol";
import { bus } from "../bus.js";
import { saveNow, state } from "../store.js";
import { ToolError, type ToolDef } from "./tools.js";

const SAY = { type: "string", description: "What you're doing, 3 to 8 words, shown on the Device, e.g. 'Adding the waitlist form'." };
const REL = (d: string) => ({ type: "string", description: `${d} Relative to the project folder, e.g. src/App.tsx.` });
const ASK = { type: "boolean", description: "Auto mode: true if the user would want to confirm this first." };

/** A project-relative path as a ~/ path on the machine. Refuses anything that leaves the project. */
export function inProject(rel: unknown): string {
  const raw = typeof rel === "string" ? rel.trim().replace(/^\.\/+/, "") : "";
  if (raw.startsWith("/") || raw.startsWith("~")) throw new ToolError("Use a path inside the project, like src/App.tsx.");
  const parts = raw.split("/").filter(p => p && p !== ".");
  if (parts.includes("..")) throw new ToolError("Stay inside the project folder.");
  return [state.build.dir, ...parts].join("/");
}

export const BUILD_TOOLS: ToolDef[] = [
  {
    name: "build_list",
    description: "List a folder in the Build project (newest first). Leave path empty for the project root.",
    props: { path: REL("Folder to list."), say: SAY }, required: ["say"], purposes: "all",
    async run(ctx, i) {
      await ctx.gate({ title: `Look in ${state.build.name}?` });
      const r = await ctx.pc("fs.list", { path: inProject(i.path ?? ""), limit: 300 });
      const entries = r.data as FsEntry[];
      return { text: JSON.stringify(entries.map(e => ({ n: e.name, d: e.isDir || undefined, s: e.size }))) };
    },
  },
  {
    name: "build_read",
    description: "Read a file in the Build project (first 60 KB).",
    props: { path: REL("File to read."), say: SAY }, required: ["path", "say"], purposes: "all",
    async run(ctx, i) {
      await ctx.gate({ title: `Read ${i.path}?` });
      const r = await ctx.pc("fs.read", { path: inProject(i.path), maxBytes: 60000 });
      return { text: r.data.text + (r.data.truncated ? "\n[truncated]" : "") };
    },
  },
  {
    name: "build_write",
    description: "Create or replace a file in the Build project with the full new content. The dev server reloads the preview by itself.",
    props: { path: REL("File to write."), content: { type: "string" }, say: SAY, ask_first: ASK },
    required: ["path", "content", "say"], grey: true, purposes: "all",
    async run(ctx, i) {
      await ctx.gate({ askFirst: i.ask_first, title: `Write ${i.path}?`, body: `In ${state.build.name}.` });
      await ctx.pc("fs.write", { path: inProject(i.path), content: i.content, overwrite: true });
      return { text: `Wrote ${i.path}.` };
    },
  },
  {
    name: "build_run",
    description: "Run a shell command in the Build project folder, e.g. `npm install`. Use commands for the PC's platform. Commands time out after 60 seconds. Only available when the PC agent allows shell.",
    props: { command: { type: "string" }, say: SAY }, required: ["command", "say"], alwaysAsk: true, purposes: "all",
    async run(ctx, i) {
      return { text: await ctx.shell({ command: i.command, cwd: state.build.dir }) };
    },
  },
  {
    name: "build_deploy",
    description: "Publish the Build project with a deploy command, e.g. `npx vercel --prod --yes`. It leaves the user's machines, so it always needs the push bar. Only on a machine that allows shell.",
    props: { command: { type: "string" }, say: SAY }, required: ["command", "say"], risk: "leave", purposes: "all",
    async run(ctx, i) {
      return { text: await ctx.shell({ command: i.command, cwd: state.build.dir, publish: true }) };
    },
  },
  {
    name: "build_preview",
    description: "Set a custom dev-server address only after starting and verifying that server. The Device normally previews static Build files through the Flip server, so do not call this for ordinary HTML, CSS, or browser JavaScript changes. Use a reachable Tailscale or LAN URL, never localhost or a guessed address.",
    props: { url: { type: "string" }, say: SAY }, required: ["url", "say"], purposes: "all",
    async run(ctx, i) {
      const url = String(i.url).trim();
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new ToolError("Give a full http:// or https:// address.");
      await ctx.gate({ title: "Show this preview?", body: url });
      state.build.previewMode = "custom";
      state.build.previewUrl = url;
      saveNow();
      bus.changed();
      return { text: `The Device now shows ${url}.` };
    },
  },
];
