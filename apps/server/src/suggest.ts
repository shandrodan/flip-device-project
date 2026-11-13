// Turn a note into suggested tasks (ADR 0005). The configured model when a key is set, otherwise a small
// rule-based splitter that still routes obvious work to the right agent.
import { APP_IDS, type Agent, type Note, type Suggestion } from "@app/protocol";
import { structuredMessage, hasLlm, describeApiError } from "./llm.js";
import { config } from "./config.js";
import { state, id, appOfAgent, pickAppAgent } from "./store.js";

const WHY: Record<string, string> = {
  mail: "asks before it sends",
  pc: "on your machine, asks before it deletes",
  files: "asks before it deletes",
  research: "searches the web, writes a summary",
  writer: "writes it into a file",
  app: "owns a Device app",
};

function why(agent: Agent | undefined) {
  if (!agent) return "A plain todo";
  const extra = WHY[agent.purpose];
  return extra ? `${agent.name}, ${extra}` : agent.name;
}

export async function suggestTasks(note: Note): Promise<Suggestion[]> {
  if (hasLlm()) {
    try {
      return await viaModel(note);
    } catch (err) {
      console.warn("[suggest] Model failed, using rules:", describeApiError(err));
    }
  }
  return viaRules(note.text);
}

/* ------------------------------- Model ------------------------------- */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "agent"],
        properties: {
          title: { type: "string", description: "Imperative, at most 7 words, e.g. 'Send pitch deck to Jonas'" },
          agent: { type: "string", description: "An agent id from the list, or 'todo' for a plain todo the user does themselves" },
        },
      },
    },
  },
};

async function viaModel(note: Note): Promise<Suggestion[]> {
  const agents = state.agents.map(a => `- ${a.id}: ${a.name}. ${a.role} Apps: ${APP_IDS.filter(app => state.appAgents[app].includes(a.id)).join(", ") || "none"}.`).join("\n");
  const res = await structuredMessage({
    model: config.suggestModel,
    max_tokens: 2000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system:
      "You read a voice note someone dumped into a small desk device and pull out the tasks in it. " +
      "Only real tasks: a passing thought or idea gives zero tasks. At most 4. Keep the speaker's names and details. " +
      "Hand a task to an agent only if that agent can actually do it with its tools (email, files on the user's computer, web research, writing files). " +
      "For a task that changes a Device app, use that app's assigned Task agent. " +
      "Errands, calls and things only a person can do are 'todo'.\n\nAgents:\n" + agents,
    messages: [{ role: "user", content: note.text }],
  });
  const parsed = res as { tasks: { title: string; agent: string }[] } | null;
  if (!parsed) return [];
  return parsed.tasks.slice(0, 4).map(t => {
    const selected = state.agents.find(a => a.id === t.agent);
    const selectedApp = selected && appOfAgent(selected.id);
    const routed = routeByWords(t.title);
    const agent = routed && appOfAgent(routed.id) ? routed : selectedApp ? pickAppAgent(selectedApp) : selected;
    return { id: id("s"), title: t.title.trim(), agentId: agent ? agent.id : null, why: why(agent) };
  });
}

/* ------------------------------- Rules ------------------------------- */

const FILLER = /^(okay|ok|so|and|oh|um|uh|also|then|right|well|like|anyway|plus|but)\b[\s,]*/i;
const LEAD = /^(i (really )?(need|have|want|got|should|must) to|i'?ll|remind me to|don'?t forget to|can you|could you|please|let'?s|we need to|need to|gotta|you should|maybe)\s+/i;
const VERB = /\b(add|start|stop|save|set|change|send|email|mail|reply|clean|tidy|organi[sz]e|archive|move|delete|remove|sort|find|research|look up|summari[sz]e|write|draft|call|buy|book|export|record|rename|fix|check|update|prepare|make|create|schedule|plan|review|read|ship|deploy|test|ask|tell|pay|order|print|backup|back up)\b/i;

export function viaRules(text: string): Suggestion[] {
  const clauses = text
    .replace(/\b(before \w+day|tomorrow|tonight|today)\b,?/gi, m => m) // keep time words
    .split(/(?:[.!?;]+\s*|,\s*(?:and\s+)?(?=(?:oh |also |then |and )?(?:i |can |could |please |remind |send |clean |find |archive |export |write |call |book |buy |research |look |move |delete |tidy |organi)))|\s+and also\s+|\s+(?:and|but) then\s+|\s+oh and\s+/i)
    .map(s => s && s.trim())
    .filter(Boolean) as string[];

  const out: Suggestion[] = [];
  let lastObject = "";
  for (let raw of clauses) {
    let s = raw;
    for (let i = 0; i < 4; i++) s = s.replace(FILLER, "").replace(LEAD, "");
    s = s.replace(/^(before \w+day|tomorrow|today|tonight)\s*,?\s*/i, "").replace(LEAD, "");
    if (!VERB.test(s) && /\b(is a mess|messy|is full)\b/i.test(s)) {
      lastObject = s.replace(/^my\s+/i, "").replace(/\s+(is|are)\b.*$/i, "");
      continue; // "my screenshots folder is a mess" -> context for the next clause
    }
    if (!VERB.test(s)) continue;
    s = s.replace(/\bit\b/i, lastObject || "it");
    let title = s
      .replace(/,?\s+(but|except|while|so that|because)\b.*$/i, "") // "clean it up, but keep..." -> the detail stays in the note
      .replace(/\s+(please|for me)\b/gi, "")
      .replace(/^(clean|tidy|sort|back|clear)\s+(.+?)\s+up$/i, "$1 up $2")
      .replace(/\s+/g, " ")
      .trim();
    title = title.replace(/\bmy\b/gi, "").replace(/\s+/g, " ").trim();
    if (title.length > 60) title = title.slice(0, 57).replace(/\s+\S*$/, "") + "…";
    title = title.charAt(0).toUpperCase() + title.slice(1);
    title = title.replace(/^Send (\w+) the (.+)$/i, (_, who, what) => `Send ${what} to ${who}`);
    const agent = routeByWords(title + " " + raw);
    out.push({ id: id("s"), title, agentId: agent?.id ?? null, why: why(agent) });
    if (out.length >= 4) break;
  }
  return out;
}

function routeByWords(t: string): Agent | undefined {
  const has = (re: RegExp) => re.test(t);
  const byPurpose = (...ps: string[]) => {
    for (const p of ps) {
      const a = state.agents.find(x => x.purpose === p);
      if (a) return a;
    }
    return undefined;
  };
  const appOwner = (app: keyof typeof state.appAgents) => pickAppAgent(app);
  if (has(/\b(add|create|make) (a )?(to-?do|task)( to|:)/i)) return appOwner("todo");
  if (has(/\b(start|stop) (a |the )?focus( timer)?\b/i)) return appOwner("focus");
  if (has(/\bsave (a )?note\b/i)) return appOwner("notes");
  if (has(/\b(create|make) (a |an )?agent\b/i)) return appOwner("agents");
  if (has(/\b(change|set) (the )?(permission|settings)\b/i)) return appOwner("settings");
  if (has(/\b(call|buy|book|pick up|meet|phone|visit|record|print)\b/i)) return undefined;
  if (has(/\b(send|email|e-mail|mail|reply)\b/i)) return byPurpose("mail", "main");
  if (has(/\b(research|look up|find out|summari[sz]e|write-?ups?|articles?|compare)\b/i)) return byPurpose("research", "main");
  if (has(/\b(screenshots?|folder|files?|downloads?|desktop|clean|tidy|archive|organi[sz]e|duplicates?|laptop|macbook|move)\b/i)) return byPurpose("files", "pc", "main");
  if (has(/\b(write|draft|doc|readme|outline|notes? for)\b/i)) return byPurpose("writer", "main");
  return undefined;
}
