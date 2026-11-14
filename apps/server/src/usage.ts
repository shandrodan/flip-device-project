// Cost and speed per Task (roadmap P2.17). Each Task agent run records its model calls, tokens, cost
// and time. Kept in memory for /api/usage and appended to DATA_DIR/usage.jsonl.
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

export interface TaskUsage {
  taskId: string;
  agentId: string;
  model: string;
  /** Model calls (assistant messages). */
  calls: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  /** US dollars, or null when the model's price is unknown. */
  cost: number | null;
  seconds: number;
  at: string;
}

const recent: TaskUsage[] = [];
const FILE = () => path.join(config.dataDir, "usage.jsonl");

export function recordUsage(usage: TaskUsage) {
  recent.push(usage);
  if (recent.length > 1000) recent.splice(0, recent.length - 1000);
  try { fs.appendFileSync(FILE(), JSON.stringify(usage) + "\n"); } catch { /* the log is best effort */ }
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  console.log(`[usage] ${usage.taskId} ${usage.model}: ${usage.calls} calls, ${k(usage.input)} in / ${k(usage.output)} out${usage.cacheRead ? ` (${k(usage.cacheRead)} cached)` : ""}, ${usage.cost === null ? "cost unknown" : `$${usage.cost.toFixed(4)}`}, ${usage.seconds.toFixed(1)} s`);
}

/** Usage of these Tasks, or the latest 200. */
export function usageFor(ids?: string[]): TaskUsage[] {
  if (!ids?.length) return recent.slice(-200);
  const want = new Set(ids);
  return recent.filter(item => want.has(item.taskId));
}

/** Price per token in US dollars. */
export interface Price { input: number; output: number; cacheRead: number }

/** ENGINE_PRICE="in,out" in US dollars per million tokens, e.g. "0.05,0.20". */
export function priceFromEnv(): Price | null {
  const raw = process.env.ENGINE_PRICE;
  if (!raw) return null;
  const [input, output] = raw.split(",").map(Number);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  return { input: input / 1e6, output: output / 1e6, cacheRead: input / 1e6 };
}

/** OpenCode counts input without the cached part, so cached tokens are priced on their own. */
export function costOf(price: Price | null, t: { input: number; output: number; reasoning: number; cacheRead: number }): number | null {
  if (!price) return null;
  return t.input * price.input + (t.output + t.reasoning) * price.output + t.cacheRead * price.cacheRead;
}
