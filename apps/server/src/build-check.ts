// Errors come back by themselves (roadmap P1.7). After every edit in the Build project the agent
// gets what broke, appended to the edit's own result, so it fixes errors without asking for logs.
// With a dev server: the edited module is requested through it (Vite only compiles what is asked
// for), the dev server's new error lines are added, and the page is loaded to catch the rest. Without one: the Device preview reloads at
// once, and the page is loaded in the Device's sandboxed frame to collect its errors.
import { bus } from "./bus.js";
import { devLogSince, devServer } from "./build-host.js";
import { previewErrors } from "./build-shot.js";
import { state } from "./store.js";

const ERROR_LINE = /error|failed|cannot|unexpected|unterminated|not defined|is not|✘|\[plugin/i;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** What to add to an edit's result. `rel` is the edited file, relative to the project. */
export async function checkAfterEdit(rel: string, logMark: number): Promise<{ text: string; errors: boolean }> {
  const dev = devServer();
  if (dev?.running) {
    let status = 0;
    if (/\.(m?[jt]sx?|vue|svelte|css|scss)$/.test(rel)) {
      await sleep(150);
      status = await fetch(`http://127.0.0.1:${dev.port}/preview/${rel}`, { signal: AbortSignal.timeout(8_000) }).then(r => r.status, () => 0);
    }
    await sleep(500);
    const fresh = devLogSince(logMark).split("\n").filter(line => line.trim());
    const errorAt = fresh.findIndex(line => ERROR_LINE.test(line));
    if (errorAt >= 0 || status >= 400) {
      const lines = errorAt >= 0 ? fresh.slice(errorAt, errorAt + 14).join("\n").slice(0, 1500) : `${rel} answered HTTP ${status}.`;
      return { text: `The dev server reports an error after this edit. Fix it before you answer:\n${lines}`, errors: true };
    }
    // The dev server may compile without complaint (Vite only scans imports): the browser has the last word.
    const browser = await previewErrors().catch(() => null);
    if (browser?.length) return { text: `The preview shows errors after this edit. Fix them before you answer:\n${browser.map(e => `- ${e}`).join("\n")}`, errors: true };
    return { text: "Dev server: no new errors after this edit.", errors: false };
  }
  // Static files: the Device shows them as they are, so reload it now, not at the end of the Task.
  state.build.rev++;
  bus.changed();
  if (!/\.(html?|m?js|css)$/.test(rel)) return { text: "", errors: false };
  const errors = await previewErrors().catch(() => null);
  if (!errors) return { text: "", errors: false };
  return errors.length
    ? { text: `The preview shows errors after this edit. Fix them before you answer:\n${errors.map(e => `- ${e}`).join("\n")}`, errors: true }
    : { text: "Preview: no errors after this edit.", errors: false };
}
