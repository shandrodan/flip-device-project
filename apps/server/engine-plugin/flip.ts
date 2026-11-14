// Runs inside OpenCode, not in the Flip server (ADR 0032).
// The Flip server copies this file into the engine workspace at start. On load it asks the server
// for the Flip tool manifest and registers each tool. A call goes back to the server with the
// OpenCode session ID, so the server runs it with that Task's context, gate and approval press.
import { tool, type Plugin } from "@opencode-ai/plugin";

const z = tool.schema;
const SERVER = process.env.FLIP_ENGINE_URL ?? "";
const TOKEN = process.env.FLIP_ENGINE_TOKEN ?? "";
const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

type Schema = { type?: string | string[]; enum?: unknown[]; items?: Schema; properties?: Record<string, Schema>; required?: string[]; description?: string };
interface Manifest { name: string; description: string; props: Record<string, Schema>; required: string[] }
interface CallState { id: string; done: boolean; output?: string; error?: string; attachments?: { type: "file"; mime: string; url: string; filename?: string }[] }

/** The small JSON Schema subset Flip tools use, as zod. */
function toZod(schema: Schema): any {
  const types = Array.isArray(schema?.type) ? schema.type : [schema?.type];
  const base = types.find(type => type && type !== "null");
  let out: any;
  if (Array.isArray(schema?.enum) && schema.enum.length) out = z.enum(schema.enum.map(String) as [string, ...string[]]);
  else if (base === "string") out = z.string();
  else if (base === "number" || base === "integer") out = z.number();
  else if (base === "boolean") out = z.boolean();
  else if (base === "array") out = z.array(toZod(schema.items ?? {}));
  else if (base === "object" && schema.properties)
    out = z.object(Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, schema.required?.includes(key) ? toZod(value) : toZod(value).optional()])));
  else if (base === "object") out = z.record(z.string(), z.any());
  else out = z.any();
  if (types.includes("null")) out = out.nullable();
  if (schema?.description) out = out.describe(schema.description);
  return out;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A call can wait minutes for an approval press, so the server answers in rounds of about 20 s. */
async function call(sessionID: string, callID: string, name: string, args: unknown, abort: AbortSignal): Promise<CallState> {
  let response = await fetch(`${SERVER}/engine/call`, { method: "POST", headers, body: JSON.stringify({ sessionID, callID, tool: name, args }), signal: abort });
  for (;;) {
    if (!response.ok) throw new Error(`Flip server error ${response.status}: ${await response.text()}`);
    const state = await response.json() as CallState;
    if (state.done) {
      if (state.error) throw new Error(state.error);
      return state;
    }
    if (abort.aborted) throw new Error("Stopped.");
    response = await fetch(`${SERVER}/engine/call/${state.id}`, { headers, signal: abort });
  }
}

async function manifest(): Promise<Manifest[]> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(`${SERVER}/engine/tools`, { headers });
      if (response.ok) return await response.json() as Manifest[];
    } catch { /* the server is still starting */ }
    await sleep(500);
  }
  throw new Error("The Flip server did not give its tool list.");
}

export const Flip: Plugin = async () => {
  const tools: Record<string, ReturnType<typeof tool>> = {};
  for (const def of await manifest()) {
    const args = Object.fromEntries(Object.entries(def.props).map(([key, schema]) => {
      const type = toZod(schema);
      return [key, def.required.includes(key) ? type : type.optional()];
    }));
    tools[def.name] = tool({
      description: def.description,
      args,
      async execute(input, context) {
        const say = typeof (input as { say?: unknown }).say === "string" ? String((input as { say: string }).say) : def.name;
        context.metadata({ title: say });
        const result = await call(context.sessionID, `${context.messageID}:${def.name}:${crypto.randomUUID()}`, def.name, input, context.abort);
        // A Build screenshot comes back as an image the model can look at.
        return result.attachments?.length ? { output: result.output ?? "Done.", attachments: result.attachments } : result.output ?? "Done.";
      },
    });
  }
  return {
    tool: tools,
    // OpenCode's own tools (read, edit, bash, …) run only where Flip allows them: the server checks the
    // folder and asks for the approval press first. A refusal stops the call with its reason.
    async "tool.execute.before"(input, output) {
      if (!NATIVE.includes(input.tool)) return;
      await call(input.sessionID, input.callID, `opencode.${input.tool}`, output.args, new AbortController().signal);
    },
  };
};

const NATIVE = ["read", "glob", "grep", "edit", "write", "bash", "apply_patch", "list"];
