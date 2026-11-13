// Claude access with the user's own key (BYOK). The key lives on this server only:
// env ANTHROPIC_API_KEY, or pasted on the /setup page (saved to data/secrets.json, mode 600).
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { secrets } from "./store.js";

let client: Anthropic | null = null;
let clientKey = "";

export function apiKey() {
  return secrets.anthropicKey || config.anthropicKey || "";
}

export function hasLlm() {
  return !!apiKey();
}

export function claude(): Anthropic {
  const key = apiKey();
  if (!key) throw new Error("No Anthropic key set");
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
    clientKey = key;
  }
  return client;
}

/** Common request bits: refusal fallback (server-side, routes by refusal category). */
export const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

export function describeApiError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Your Anthropic key was rejected. Check it on the setup page.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Your Anthropic key can't use this model.";
  if (err instanceof Anthropic.RateLimitError) return "Claude is rate limited right now. Try again in a minute.";
  if (err instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach Claude. Check the server's connection.";
  if (err instanceof Anthropic.APIError) return `Claude error ${err.status ?? ""}: ${err.message}`;
  return (err as Error)?.message || String(err);
}
