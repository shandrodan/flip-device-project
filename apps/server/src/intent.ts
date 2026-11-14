// Is a Dump in Notes or To-Do something to keep, or a command for the app's Task agent (ADR 0031)?
// "Buy oat milk" is kept. "Delete all the notes" or "move everything in Inbox to today" goes to the agent.
// The configured model decides when a key is set. Rules are the fallback and only catch clear commands.
import { structuredMessage, hasLlm, describeApiError } from "./llm.js";
import { config } from "./config.js";

export type DumpApp = "notes" | "todo";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["intent"],
  properties: {
    intent: {
      type: "string",
      enum: ["keep", "command"],
      description: "keep: words to save. command: an instruction or question for the assistant about the user's existing items.",
    },
  },
};

const PROMPT: Record<DumpApp, string> = {
  notes:
    "Someone holds the mic in the Notes app of a small desk device. Decide what their words are.\n" +
    "- keep: a thought, idea, list item, reminder or anything to write down, including 'add X to this note' and 'new note …'.\n" +
    "- command: they tell the assistant to do something with existing notes or to-dos, or ask about them: " +
    "'delete all the notes', 'remove the grocery list', 'rename this note', 'merge these notes', 'how many notes do I have', " +
    "'summarise my notes', 'turn this note into tasks'.\n" +
    "When in doubt, keep.",
  todo:
    "Someone holds the mic in the To-Do app of a small desk device. Decide what their words are.\n" +
    "- keep: new work to add as a to-do: 'buy batteries tomorrow', 'remind me to call Rasa', 'read chapter 3'.\n" +
    "- command: they tell the assistant to do something with existing to-dos or notes, or ask about them: " +
    "'delete all my tasks', 'move everything in Inbox to today', 'move this task to tomorrow', 'mark it done', " +
    "'clear completed', 'what's due today', 'rename this to call the venue'.\n" +
    "When in doubt, keep.",
};

const VERB = /^(?:(?:hey|ok(?:ay)?|so|please|can you|could you|would you)[,\s]+)*(?:delete|remove|erase|clear|wipe|empty|move|rename|merge|combine|reschedule|postpone|mark|complete|reopen|undo|archive|sort|summari[sz]e|how many|what(?:'s| is| are)|which|list all|show me)\b/i;
const OBJECT = /\b(?:notes?|tasks?|to-?dos?|todos?|lists?|inbox|projects?|everything|all|it|this|that|these|those|them)\b/i;

/** Rules: only clear commands ("delete all the notes"), so ordinary thoughts are never lost. */
export function commandByRules(text: string): boolean {
  return VERB.test(text.trim()) && OBJECT.test(text);
}

export async function dumpIntent(text: string, app: DumpApp): Promise<"keep" | "command"> {
  if (hasLlm()) {
    try {
      const res = await structuredMessage({
        model: config.suggestModel,
        max_tokens: 200,
        output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
        system: PROMPT[app],
        messages: [{ role: "user", content: text }],
      }) as { intent?: string } | null;
      if (res?.intent === "keep" || res?.intent === "command") return res.intent;
    } catch (err) {
      console.warn("[intent] Model failed, using rules:", describeApiError(err));
    }
  }
  return commandByRules(text) ? "command" : "keep";
}
