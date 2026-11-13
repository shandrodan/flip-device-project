// Where a dump in Notes goes (ADR 0011). The main agent reads the open note and decides:
// add to it, add to another note the dump is clearly about, or start a new note.
// Claude when a key is set, otherwise rules that cover the demo (shared words, a food lexicon,
// and spoken commands like "add to this note …" or "new note …").
import type { Note } from "@app/protocol";
import { claude, hasLlm, FALLBACK, describeApiError } from "./llm.js";
import { config } from "./config.js";
import { state, noteById } from "./store.js";

export interface Route {
  action: "new" | "append";
  noteId?: string;
  /** The words to save, without the spoken command. */
  text: string;
  /** One short line for the Device, e.g. "Same topic as the open note". */
  why: string;
}

export async function routeDump(text: string, openNoteId: string | null): Promise<Route> {
  if (hasLlm()) {
    try {
      const r = await viaClaude(text, openNoteId);
      if (r) return r;
    } catch (err) {
      console.warn("[route] Claude failed, using rules:", describeApiError(err));
    }
  }
  return viaRules(text, openNoteId);
}

export const titleOf = (n: Note) => {
  const first = n.text.split("\n")[0].trim();
  const m = first.match(/^(.{3,}?)[.!?](\s|$)/);
  return (m ? m[1] : first).slice(0, 60);
};
const short = (s: string, n = 26) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/* ------------------------------- Claude ------------------------------- */

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "noteId", "text", "why"],
  properties: {
    action: { type: "string", enum: ["append", "new"] },
    noteId: { type: "string", description: "For append: the id of the note to add to. For new: empty string." },
    text: { type: "string", description: "The words to save, cleaned up, without the routing command ('add to this note', 'new note'). Sentence case, ends with a full stop unless it is a title or list heading." },
    why: { type: "string", description: "At most 9 plain words for the screen, e.g. 'Same topic as the open note' or 'You asked for a new note'." },
  },
};

async function viaClaude(text: string, openNoteId: string | null): Promise<Route | null> {
  const open = openNoteId ? noteById(openNoteId) : undefined;
  const list = state.notes.slice(0, 30).map(n => `- ${n.id}${n.id === open?.id ? " (OPEN)" : ""}: ${n.text.replace(/\s+/g, " ").slice(0, 160)}`).join("\n");
  const res = await claude().beta.messages.create({
    model: config.suggestModel,
    max_tokens: 800,
    ...FALLBACK,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
    system:
      "Someone holds the mic on a small notes device and says something while a note is open. Decide where it goes.\n" +
      "- If they say where ('add to this note …', 'add X to the grocery list', 'new note …'), do that.\n" +
      "- Otherwise, if it continues the open note's topic (e.g. 'carrots' while a grocery list is open), append to the open note.\n" +
      "- Otherwise, if it is clearly about another existing note (shares its specific subject), append there.\n" +
      "- Otherwise, start a new note. A short heading like 'Grocery list' starts a new note.\n" +
      "Never invent content. Keep the speaker's words.\n\nNotes (newest first):\n" + list,
    messages: [{ role: "user", content: text }],
  });
  if (res.stop_reason === "refusal") return null;
  const out = JSON.parse(res.content.map(b => (b.type === "text" ? b.text : "")).join("")) as Route & { noteId: string };
  if (!out.text?.trim()) return null;
  if (out.action === "append" && !noteById(out.noteId)) return { action: "new", text: out.text.trim(), why: out.why };
  return { action: out.action, noteId: out.action === "append" ? out.noteId : undefined, text: out.text.trim(), why: out.why };
}

/* ------------------------------- Rules ------------------------------- */

const STOP = new Set("a an the and or to of for in on at my me i is it this that with be we our you your some more about please add put note notes list also remind need get two one new".split(" "));
const stem = (w: string) => w.replace(/ies$/, "y").replace(/oes$/, "o").replace(/([^s])s$/, "$1");
const FOOD = new Set("grocery groceries shopping shop store buy food carrot potato milk oat egg bread apple banana tomato onion cheese butter rice pasta chicken coffee tea water yogurt flour sugar salt pepper garlic lettuce cucumber avocado lemon fruit vegetable veggie meat fish juice cereal snack".split(" ").map(stem));
const words = (s: string) => (s.toLowerCase().match(/[a-z']+/g) || []).filter(w => w.length > 2 && !STOP.has(w)).map(stem);
const overlap = (text: string, n: Note) => { const b = new Set(words(n.text)); return words(text).filter(w => b.has(w)).length; };
// For the open note a shared topic is enough ("carrots" fits a grocery list). Other notes need real shared words.
const score = (text: string, n: Note) => overlap(text, n) + (words(text).some(w => FOOD.has(w)) && words(n.text).some(w => FOOD.has(w)) ? 2 : 0);

const FILLER = /^(okay|ok|so|um|uh|oh|remind me to|i need to|note to self|don'?t forget to)[,\s]+/i;
const LIST_RE = /^(?:(?:a|my|the|new)\s+)?[a-z' ]{2,40}\s+(?:list|checklist)[.!]?$|^list of\b/i;
const NEW_RE = /^(?:please\s+)?(?:(?:add|put|save|write)\s+(?:this\s+|it\s+)?(?:to|in|into|as)\s+(?:a\s+)?(?:new|another|separate|fresh)\s+note|(?:start|make|create|open)\s+(?:a\s+)?new\s+note|new\s+note)\b[\s,:.\-]*(?:with\s+|saying\s+|that\s+says\s+)?/i;
const THIS_RE = /^(?:please\s+)?(?:add|put|append|write)\s+(?:this\s+|it\s+)?(?:to|in|into|on)\s+(?:this|the|my|an?)?\s*(?:current|existing|open|same)?\s*note\b[\s,:.\-]*/i;
const ITEM_NEW = /^(?:please\s+)?(?:add|put)\s+(.+?)\s+(?:to|in|into)\s+(?:a\s+)?(?:new|another|separate)\s+note[.!]?$/i;
const ITEM_THIS = /^(?:please\s+)?(?:add|put)\s+(.+?)\s+(?:to|in|into)\s+(?:this|the current|the open|my current|the existing|an existing)\s+note[.!]?$/i;
const ITEM_NAMED = /^(?:please\s+)?(?:add|put)\s+(.+?)\s+(?:to|in|into|on)\s+(?:the|my)\s+(.+?)(?:\s+(?:note|list))?[.!]?$/i;

function clean(s: string, heading = false) {
  let t = s.trim().replace(/^[,.:;\-\s]+/, "");
  for (let i = 0; i < 3 && FILLER.test(t); i++) t = t.replace(FILLER, "");
  if (!t) return t;
  t = t[0].toUpperCase() + t.slice(1);
  if (heading) return t.replace(/[.!?]+$/, "");
  return /[.!?]$/.test(t) ? t : t + ".";
}

export function viaRules(raw: string, openNoteId: string | null): Route {
  const text = raw.trim();
  const open = openNoteId ? noteById(openNoteId) : undefined;
  const append = (add: string, n: Note, why: string): Route => ({ action: "append", noteId: n.id, text: clean(add), why });
  const fresh = (body: string, why: string): Route => {
    const heading = body.trim().split(/\s+/).length <= 5 && !/[.!?]\s/.test(body.trim());
    return { action: "new", text: clean(body, heading), why };
  };
  const rest = (m: RegExpMatchArray) => text.slice(m[0].length).trim();
  let m: RegExpMatchArray | null;
  if ((m = text.match(ITEM_NEW))) return fresh(m[1], "You asked for a new note");
  if ((m = text.match(NEW_RE)) && rest(m)) return fresh(rest(m), "You asked for a new note");
  if ((m = text.match(ITEM_THIS)) && open) return append(m[1], open, "You asked to add it to this note");
  if ((m = text.match(THIS_RE)) && open && rest(m)) return append(rest(m), open, "You asked to add it to this note");
  if ((m = text.match(ITEM_NAMED))) {
    const target = m[2];
    const named = state.notes.map(n => [n, score(target, n)] as const).sort((a, b) => b[1] - a[1])[0];
    if (named && named[1] >= 1) return append(m[1], named[0], `You named “${short(titleOf(named[0]))}”`);
  }
  if (LIST_RE.test(text)) return fresh(text, "Sounds like the start of a list");
  if (open && score(text, open) >= 1) return append(text, open, "Same topic as the open note");
  const best = state.notes.filter(n => n !== open).map(n => [n, overlap(text, n)] as const).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] >= 2) return append(text, best[0], `Sounds like “${short(titleOf(best[0]))}”`);
  return fresh(text, open ? "A new topic, so it gets its own note" : "A new topic");
}
