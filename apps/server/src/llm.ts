// Model access with server-side BYOK credentials.
import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.js";
import { secrets } from "./store.js";

let client: Anthropic | null = null;
let clientKey = "";

export const openRouterKey = () => secrets.openRouterKey || config.openRouterKey;
export const anthropicKey = () => secrets.anthropicKey || config.anthropicKey;
export const apiKey = () => openRouterKey() || anthropicKey();
export const llmMode = () => openRouterKey() ? "openrouter" : anthropicKey() ? "claude" : "planner";
export const agentModel = () => openRouterKey() ? config.openRouterModel : config.agentModel;

async function openRouterMessage(key: string, request: Anthropic.Beta.MessageCreateParamsNonStreaming) {
  let response: Response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/messages", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...request, provider: { require_parameters: true } }),
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new Error("Couldn't reach OpenRouter or the request timed out.");
  }
  if (response.status === 401) throw new Error("Your OpenRouter key was rejected. Check it on the setup page.");
  if (response.status === 402) throw new Error("OpenRouter requires credits for this request.");
  if (response.status === 429) throw new Error("OpenRouter is rate limited right now. Try again later.");
  if (!response.ok) throw new Error(`OpenRouter request failed (HTTP ${response.status}).`);
  const result = await response.json() as Anthropic.Beta.BetaMessage;
  if (!Array.isArray(result.content)) throw new Error("OpenRouter returned an invalid message.");
  return result;
}

export function messageClient() {
  const key = openRouterKey();
  if (key) {
    return {
      name: "OpenRouter", openRouter: true,
      create: (request: Anthropic.Beta.MessageCreateParamsNonStreaming) =>
        openRouterMessage(key, { ...request, model: config.openRouterModel }),
    };
  }
  return {
    name: "Claude", openRouter: false,
    create: (request: Anthropic.Beta.MessageCreateParamsNonStreaming) =>
      claude().beta.messages.create({ ...request, ...FALLBACK }),
  };
}

export function hasLlm() {

  return !!apiKey();
}

export function claude(): Anthropic {
  const key = anthropicKey();
  if (!key) throw new Error("No Anthropic key set");
  if (!client || clientKey !== key) {
    client = new Anthropic({ apiKey: key, maxRetries: 2, timeout: 120_000 });
    clientKey = key;
  }
  return client;
}

/** Use a forced function for JSON on OpenRouter so reasoning stays out of the result. */
export async function structuredMessage(request: Anthropic.Beta.MessageCreateParamsNonStreaming) {
  const client = messageClient();
  const format = request.output_config?.format;
  if (client.openRouter && format?.type === "json_schema") {
    const { output_config, ...input } = request;
    const name = "return_result";
    const response = await client.create({
      ...input,
      max_tokens: Math.max(input.max_tokens, 4000),
      tools: [{ name, description: "Return the result in the requested format.", input_schema: format.schema as Anthropic.Beta.BetaTool["input_schema"] }],
      tool_choice: { type: "tool", name },
    });
    if (response.stop_reason === "refusal") return null;
    const call = response.content.find(block => block.type === "tool_use" && block.name === name);
    if (!call || call.type !== "tool_use") throw new Error("OpenRouter did not return the requested structured result.");
    return call.input;
  }
  const response = await client.create(request);
  if (response.stop_reason === "refusal") return null;
  return JSON.parse(response.content.map(block => block.type === "text" ? block.text : "").join("")) as unknown;
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
