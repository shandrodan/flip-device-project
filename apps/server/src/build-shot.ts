// Screenshots of the Build preview (roadmap P1.4). The agent sees its own work: the server renders
// /preview/ in headless Chromium at the size of the Device's preview pane and gives the image back,
// with a short text layout of what is on the page for models that cannot see images.
// Chromium starts on first use and closes after a quiet minute, so it costs no memory when idle.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** The Device's Build preview pane: the 784×504 screen minus the 216 px side column. */
export const SHOT_WIDTH = 568, SHOT_HEIGHT = 504;
const IDLE_CLOSE = 60_000;

type Browser = { newPage(opts: Record<string, unknown>): Promise<any>; close(): Promise<void> };
let browser: Promise<Browser> | null = null;
let idle: NodeJS.Timeout | null = null;

export class NoBrowser extends Error {}

async function launch(): Promise<Browser> {
  let chromium: { launch(opts: Record<string, unknown>): Promise<Browser> };
  try {
    ({ chromium } = await import("playwright-core") as any);
  } catch {
    throw new NoBrowser("No browser on this server: playwright-core is not installed.");
  }
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  try {
    return await chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  } catch (err) {
    throw new NoBrowser(`No browser on this server: ${(err as Error).message.split("\n")[0]} Install it with: npx playwright-core install --with-deps chromium`);
  }
}

function keepAlive() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => void closeShots(), IDLE_CLOSE);
  idle.unref();
}

export async function closeShots() {
  const current = browser;
  browser = null;
  if (current) await current.then(b => b.close()).catch(() => undefined);
}

export interface Shot {
  png: Buffer;
  /** Where the PNG was saved, under the data folder. */
  file: string;
  /** Title, console errors and the visible elements with their boxes. */
  summary: string;
}

let count = 0;

/** Render a page of the Build preview as the Device shows it. `rel` is a path under /preview/. */
export async function shootPreview(rel = ""): Promise<Shot> {
  if (!browser) browser = launch().catch(err => { browser = null; throw err; });
  const b = await browser;
  keepAlive();
  const page = await b.newPage({ viewport: { width: SHOT_WIDTH, height: SHOT_HEIGHT }, deviceScaleFactor: 1 });
  const errors: string[] = [];
  page.on("console", (msg: any) => { if (msg.type() === "error") errors.push(String(msg.text()).slice(0, 200)); });
  page.on("pageerror", (err: Error) => errors.push(String(err.message).slice(0, 200)));
  try {
    const url = `http://127.0.0.1:${config.port}/preview/${rel.replace(/^\/+/, "")}`;
    const status = await fetch(url, { signal: AbortSignal.timeout(10_000) }).then(r => r.status, () => 0);
    // The Device shows the preview in a frame sandboxed like this one: an opaque origin, so
    // localStorage and cookies throw there. Render it the same way, so those errors show up here.
    await page.setContent(`<style>html,body{margin:0;background:#fff}</style><iframe sandbox="allow-scripts allow-forms" src="${url}" style="border:0;display:block;width:${SHOT_WIDTH}px;height:${SHOT_HEIGHT}px"></iframe>`);
    const frame = await (await page.waitForSelector("iframe")).contentFrame();
    await frame.waitForLoadState("load", { timeout: 20_000 }).catch(() => undefined);
    // Frameworks render after load. Wait for the network to settle, but never long.
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
    const png: Buffer = await page.screenshot({ type: "png" });
    const layout: string = await frame.evaluate(describePage, SHOT_WIDTH).catch((err: Error) => `Could not read the page: ${err.message.split("\n")[0]}`);
    const dir = path.join(config.dataDir, "build-shots");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `shot-${String(++count % 20).padStart(2, "0")}.png`);
    fs.writeFileSync(file, png);
    fs.copyFileSync(file, path.join(dir, "latest.png"));
    const summary = [
      `Screenshot of /preview/${rel} at ${SHOT_WIDTH}×${SHOT_HEIGHT}, the size of the Device's preview (HTTP ${status}).`,
      errors.length ? `Errors in the page (fix these first):\n${[...new Set(errors)].slice(0, 8).map(e => `- ${e}`).join("\n")}` : "No errors in the page console.",
      layout,
    ].join("\n");
    return { png, file, summary };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/** Runs in the page: the title and the visible elements a user would notice, with their boxes. */
function describePage(width: number): string {
  const lines: string[] = [`Title: ${document.title || "(none)"}`];
  const doc = document.documentElement;
  if (doc.scrollHeight > window.innerHeight + 4) lines.push(`The page is ${doc.scrollHeight}px tall; ${window.innerHeight}px are visible without scrolling.`);
  if (doc.scrollWidth > window.innerWidth + 4) lines.push(`The page is wider than the preview (${doc.scrollWidth}px): it scrolls sideways.`);
  const picks = Array.from(document.querySelectorAll("h1,h2,h3,p,button,a,input,textarea,select,img,canvas,li,label")).slice(0, 200);
  const out: string[] = [];
  for (const el of picks) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > window.innerHeight * 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
    const tag = el.tagName.toLowerCase();
    const text = (tag === "input" || tag === "textarea" ? (el as HTMLInputElement).value || (el as HTMLInputElement).placeholder : tag === "img" ? (el as HTMLImageElement).alt : el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60);
    const centre = Math.abs(r.left + r.width / 2 - width / 2) <= 6 ? ", centred" : "";
    const extra = tag === "button" || tag === "a" ? `, ${s.fontSize} text, background ${s.backgroundColor}, color ${s.color}` : tag.startsWith("h") || tag === "p" ? `, ${s.fontSize}` : "";
    out.push(`- ${tag}${text ? ` "${text}"` : ""}: x ${Math.round(r.left)}, y ${Math.round(r.top)}, ${Math.round(r.width)}×${Math.round(r.height)}${centre}${extra}`);
    if (out.length >= 25) break;
  }
  lines.push(out.length ? `Visible elements:\n${out.join("\n")}` : "Nothing visible on the page.");
  return lines.join("\n");
}
