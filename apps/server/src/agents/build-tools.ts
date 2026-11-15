// Build app tools (ADR 0021). The agent that serves Build (its assigned agent, or the main agent
// when it has none) works inside one project folder on the user's machine and sets the preview the
// Device shows. Paths are relative to the project, and nothing can step outside it.
import fs from "node:fs";
import path from "node:path";
import type { FsEntry } from "@app/protocol";
import { bus } from "../bus.js";
import { checkAfterEdit } from "../build-check.js";
import { devLog, devLogMark, devServer, insideProject, localBuild, projectDir, runInProject, startDev, stopDev } from "../build-host.js";
import { commitBuild, ensureRepo, history, undo } from "../build-git.js";
import { SERVER_ROOT } from "../config.js";
import { shootPreview } from "../build-shot.js";
import { saveNow, state } from "../store.js";
import { ToolError, type ToolDef } from "./tools.js";

const SAY = { type: "string", description: "What you're doing, 3 to 8 words, shown on the Device, e.g. 'Adding the waitlist form'." };
const REL = (d: string) => ({ type: "string", description: `${d} Relative to the project folder, e.g. src/App.tsx.` });
/** Starters in apps/server/starters (P1.6). */
const STARTERS = ["static", "vite-vanilla", "vite-react"];
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
      if (localBuild()) {
        const dir = local(i.path ?? "");
        const names = fs.readdirSync(dir).filter(name => name !== "node_modules" && name !== ".git").slice(0, 300);
        return { text: JSON.stringify(names.map(name => { const st = fs.statSync(path.join(dir, name)); return { n: name, d: st.isDirectory() || undefined, s: st.isDirectory() ? undefined : st.size }; })) };
      }
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
      if (localBuild()) {
        const text = fs.readFileSync(local(i.path), "utf8");
        return { text: text.length > 60000 ? text.slice(0, 60000) + "\n[truncated]" : text };
      }
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
      if (localBuild()) {
        const file = local(i.path);
        const mark = devLogMark();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, String(i.content));
        const check = await checkAfterEdit(path.relative(projectDir(), file), mark).catch(() => ({ text: "" }));
        return { text: `Wrote ${i.path}.${check.text ? `\n${check.text}` : ""}` };
      }
      await ctx.pc("fs.write", { path: inProject(i.path), content: i.content, overwrite: true });
      return { text: `Wrote ${i.path}.` };
    },
  },
  {
    name: "build_run",
    description: "Run a shell command in the Build project folder, e.g. `npm install`. Use commands for the PC's platform. Commands time out after 60 seconds. Only available when the PC agent allows shell.",
    props: { command: { type: "string" }, say: SAY }, required: ["command", "say"], alwaysAsk: true, purposes: "all",
    async run(ctx, i) {
      if (localBuild()) return { text: await localCommand(ctx, String(i.command ?? ""), false) };
      return { text: await ctx.shell({ command: i.command, cwd: state.build.dir }) };
    },
  },
  {
    name: "build_deploy",
    description: "Publish the Build project with a deploy command, e.g. `npx vercel --prod --yes`. It leaves the user's machines, so it always needs the push bar. Only on a machine that allows shell.",
    props: { command: { type: "string" }, say: SAY }, required: ["command", "say"], risk: "leave", purposes: "all",
    async run(ctx, i) {
      if (localBuild()) return { text: await localCommand(ctx, String(i.command ?? ""), true) };
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
  {
    name: "build_serve",
    description: "Start the Build project's dev server on the server machine and show it in the Device preview. Run it with base path /preview/ on 127.0.0.1, e.g. `npx vite --host 127.0.0.1 --port 5300 --strictPort --base /preview/`. Install dependencies with build_run first. Plain HTML, CSS and JavaScript need no dev server: the preview shows the files as they are. One dev server runs at a time; starting one stops the last.",
    props: { command: { type: "string", description: "The dev server command, with --base /preview/ (or the framework's base-path option) and the port." }, port: { type: "number", description: "The port it listens on, 5300 to 5399." }, say: SAY },
    required: ["command", "port", "say"], alwaysAsk: true, purposes: "all",
    async run(ctx, i) {
      const port = Number(i.port);
      if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new ToolError("Use a port from 5300 to 5399.");
      const command = String(i.command ?? "").trim();
      if (!command) throw new ToolError("Give the dev server command.");
      await ctx.gate({ askFirst: true, title: "Start the dev server?", body: `${state.build.name} · port ${port}`, preview: { command } });
      const result = await startDev(command, port);
      if (!result.ok) throw new ToolError(result.output);
      return { text: `${result.output}\nCheck it with build_run: curl -s http://127.0.0.1:${port}/preview/ | head` };
    },
  },
  {
    name: "build_stop",
    description: "Stop the Build dev server. The preview goes back to showing the project's files.",
    props: { say: SAY }, required: ["say"], purposes: "all",
    async run(ctx) {
      await ctx.gate({ title: "Stop the dev server?" });
      stopDev();
      return { text: "Stopped. The preview shows the project's files." };
    },
  },
  {
    name: "build_screenshot",
    description: "See the Build preview as the Device shows it: a screenshot at the preview's size, with the page's errors and the position and size of its visible elements. Use it after a visible change and fix what looks wrong before you answer.",
    props: { path: REL("Page to show, e.g. about.html. Leave out for the home page."), say: SAY }, required: ["say"], purposes: "all",
    async run(ctx, i) {
      await ctx.gate({ title: "Look at the preview?" });
      const shot = await shootPreview(typeof i.path === "string" ? i.path : "").catch(err => { throw new ToolError((err as Error).message); });
      ctx.step(`Screenshot of the preview (${path.basename(shot.file)})`);
      return { text: shot.summary, image: { mime: "image/png", base64: shot.png.toString("base64") } };
    },
  },
  {
    name: "build_new",
    description: "Start the Build project over from a starter, ready in seconds with no download: static (HTML, CSS, JS), vite-vanilla, or vite-react. It installs from the local cache and starts the dev server for Vite starters. The old files stay in history: build_undo brings them back. Then edit the starter to build what the user asked.",
    props: { template: { type: "string", enum: STARTERS, description: "Which starter." }, title: { type: "string", description: "The app's title, shown on the page, e.g. Lemon Stand." }, say: SAY },
    required: ["template", "say"], purposes: "all",
    async run(ctx, i) {
      const template = String(i.template);
      if (!STARTERS.includes(template)) throw new ToolError(`template is one of ${STARTERS.join(", ")}.`);
      const title = String(i.title ?? "").replace(/[<>{}"'`$\\]/g, "").replace(/\s+/g, " ").trim().slice(0, 60) || state.build.name;
      await ctx.gate({ askFirst: true, title: `Start ${state.build.name} over as ${template}?`, body: "Replaces the project's files. Undo brings them back." });
      const t0 = Date.now();
      const dir = projectDir();
      await ensureRepo();
      await commitBuild("Before starting over");
      stopDev();
      for (const name of fs.readdirSync(dir)) if (name !== ".git") fs.rmSync(path.join(dir, name), { recursive: true, force: true });
      copyStarter(path.join(SERVER_ROOT, "starters", template), dir, title);
      const lines = [`New ${template} project "${title}".`];
      if (template.startsWith("vite")) {
        ctx.step("Installing from the cache");
        const install = await runInProject("npm install --prefer-offline --no-audit --no-fund --loglevel=error", 180_000);
        if (!install.ok) throw new ToolError(`npm install failed:\n${install.output.slice(-1500)}`);
        ctx.step("Starting the dev server");
        const port = await freePort();
        const dev = await startDev(`npx vite --host 127.0.0.1 --port ${port} --strictPort --base /preview/`, port);
        if (!dev.ok) throw new ToolError(dev.output);
        lines.push(`Installed, and the dev server runs on port ${port}. The Device preview shows it and hot-reloads on every edit.`);
      } else lines.push("The Device preview shows the files as they are.");
      await commitBuild(`New ${template} project: ${title}`);
      state.build.rev++;
      bus.changed();
      lines.push(`Files: ${listFiles(dir).join(", ")}. Ready in ${Math.round((Date.now() - t0) / 1000)} s.`);
      return { text: lines.join("\n") };
    },
  },
  {
    name: "build_history",
    description: "List the latest saved changes to the Build project, newest first. Every finished Build request is saved as one change, named after what the user asked.",
    props: { say: SAY }, required: ["say"], purposes: "all",
    async run(ctx) {
      await ctx.gate({ title: `Read ${state.build.name}'s history?` });
      const list = await history();
      if (!list.length) return { text: "No saved changes yet." };
      return { text: list.map((change, n) => `${n + 1}. ${change.message} (${change.when}, ${change.hash})`).join("\n") };
    },
  },
  {
    name: "build_undo",
    description: "Undo the latest changes to the Build project. steps: how many saved changes to undo, newest first (1 for \"undo that\"). Any edit not saved yet counts as the newest change. An undo is itself a change, so it can be undone too.",
    props: { steps: { type: "number", description: "How many changes to undo, from 1." }, say: SAY }, required: ["steps", "say"], purposes: "all",
    async run(ctx, i) {
      const steps = Number(i.steps);
      if (!Number.isInteger(steps) || steps < 1 || steps > 20) throw new ToolError("steps is a whole number from 1 to 20. Use build_history to count.");
      const list = await history(steps + 1);
      await ctx.gate({ title: steps === 1 ? "Undo the last change?" : `Undo the last ${steps} changes?`, body: list.slice(0, steps).map(change => change.message).join(" · ").slice(0, 200) || state.build.name });
      const result = await undo(steps).catch(err => { throw new ToolError((err as Error).message); });
      state.build.rev++;
      bus.changed();
      return { text: `Undid ${result.undone.length}: ${result.undone.map(change => `"${change.message}"`).join(", ")}. The files are back as they were before.` };
    },
  },
  {
    name: "build_logs",
    description: "Read the last output of the Build dev server: compile errors, warnings, the address.",
    props: { say: SAY }, required: ["say"], purposes: "all",
    async run(ctx) {
      await ctx.gate({ title: "Read the dev server output?" });
      const running = devServer();
      return { text: `${running ? `${running.running ? "Running" : "Stopped"} on port ${running.port}: ${running.command}` : "No dev server."}\n${devLog()}` };
    },
  },
];

/** Tools that exist only when the Build project is on this machine, and those only for the PC. */
export const SERVER_BUILD_ONLY = ["build_serve", "build_stop", "build_logs", "build_screenshot", "build_history", "build_undo", "build_new"];
export const PC_BUILD_ONLY = ["build_preview"];

function copyStarter(from: string, to: string, title: string) {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.name === "README.md") continue;
    const src = path.join(from, entry.name), dest = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      copyStarter(src, dest, title);
    } else fs.writeFileSync(dest, fs.readFileSync(src, "utf8").replaceAll("{{title}}", title));
  }
}

function listFiles(dir: string, base = ""): string[] {
  return fs.readdirSync(path.join(dir, base), { withFileTypes: true })
    .filter(entry => entry.name !== ".git" && entry.name !== "node_modules" && entry.name !== ".gitignore")
    .flatMap(entry => entry.isDirectory() ? listFiles(dir, path.join(base, entry.name)) : [path.join(base, entry.name)]);
}

/** The first free port from 5300 to 5399. */
async function freePort(): Promise<number> {
  const net = await import("node:net");
  for (let port = 5300; port < 5400; port++) {
    const free = await new Promise<boolean>(resolve => {
      const server = net.createServer().once("error", () => resolve(false)).once("listening", () => server.close(() => resolve(true)));
      server.listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new ToolError("No free port from 5300 to 5399.");
}

/** A project-relative path on this machine (BUILD_HOST=server). */
function local(rel: unknown): string {
  const raw = typeof rel === "string" ? rel.trim().replace(/^\.\/+/, "") : "";
  if (raw.startsWith("/") || raw.startsWith("~")) throw new ToolError("Use a path inside the project, like src/App.tsx.");
  const full = insideProject(raw || ".");
  if (!full) throw new ToolError("Stay inside the project folder.");
  projectDir();
  return full;
}

/** A command in the project on this machine, behind the same approval as the PC shell. */
async function localCommand(ctx: Parameters<ToolDef["run"]>[0], command: string, publish: boolean) {
  if (!command.trim()) throw new ToolError("Supply a command.");
  await ctx.gate({
    risk: publish ? "leave" : undefined,
    askFirst: true,
    title: publish ? `Publish ${state.build.name}?` : "Run this command?",
    body: `Server · ${state.build.dir}`,
    preview: { command },
  });
  const result = await runInProject(command);
  if (!result.ok) throw new ToolError(result.output);
  return result.output;
}
