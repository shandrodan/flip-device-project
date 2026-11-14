// Undo by voice (roadmap P1.5). The Build project on the server is a git repository: the server
// commits after every Build Task with the spoken request as the message, and `build_undo` reverts
// commits. History is never rewritten (no reset), so an undo can itself be undone.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { localBuild, projectDir } from "./build-host.js";

const IGNORE = ["node_modules/", "dist/", ".vite/", "*.log", ".DS_Store", ""].join("\n");

function git(args: string[], cwd = projectDir()): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    execFile("git", ["-c", "user.name=Flip", "-c", "user.email=build@flip.local", "-c", "commit.gpgsign=false", ...args], { cwd, timeout: 30_000, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

/** Make the project a git repository with a first commit, once. */
export async function ensureRepo(): Promise<boolean> {
  if (!localBuild()) return false;
  const dir = projectDir();
  if (fs.existsSync(path.join(dir, ".git"))) return true;
  if (!fs.existsSync(path.join(dir, ".gitignore"))) fs.writeFileSync(path.join(dir, ".gitignore"), IGNORE);
  const init = await git(["init", "-q", "-b", "main"]);
  if (!init.ok) { console.warn(`[build] git init failed: ${init.out}`); return false; }
  await git(["add", "-A"]);
  await git(["commit", "-q", "--allow-empty", "-m", "Start"]);
  return true;
}

/** Commit everything that changed in the project. Returns the short hash, or null when nothing changed. */
export async function commitBuild(message: string): Promise<string | null> {
  if (!(await ensureRepo())) return null;
  await git(["add", "-A"]);
  const staged = await git(["diff", "--cached", "--quiet"]);
  if (staged.ok) return null;
  const subject = message.replace(/\s+/g, " ").trim().slice(0, 200) || "Build change";
  const done = await git(["commit", "-q", "-m", subject]);
  if (!done.ok) { console.warn(`[build] commit failed: ${done.out}`); return null; }
  return (await git(["rev-parse", "--short", "HEAD"])).out;
}

export interface Change { hash: string; when: string; message: string }

/** The newest changes first. */
export async function history(limit = 15): Promise<Change[]> {
  if (!(await ensureRepo())) return [];
  const log = await git(["log", `-${limit}`, "--format=%h%x09%cr%x09%s"]);
  if (!log.ok) return [];
  return log.out.split("\n").filter(Boolean).map(line => {
    const [hash, when, ...rest] = line.split("\t");
    return { hash, when, message: rest.join("\t") };
  });
}

/** Revert the newest `steps` changes in one new commit. Uncommitted edits count as the newest change. */
export async function undo(steps: number): Promise<{ undone: Change[]; hash: string }> {
  await commitBuild("Changes not saved yet");
  const all = await history(steps + 1);
  // The first commit ("Start") is the project as it was found: it is never undone.
  const undoable = all.length > 0 && all.length <= steps ? all.slice(0, -1) : all.slice(0, steps);
  if (!undoable.length) throw new Error("There is nothing to undo yet.");
  const revert = await git(["revert", "--no-commit", "--no-edit", `HEAD~${undoable.length}..HEAD`]);
  if (!revert.ok) {
    await git(["revert", "--abort"]);
    throw new Error(`Could not undo: ${revert.out.slice(0, 300)}`);
  }
  const message = `Undo: ${undoable.map(change => change.message).join(" · ")}`;
  const hash = await commitBuild(message);
  return { undone: undoable, hash: hash ?? "" };
}
