# 0011: Notes, where the agent decides which note a dump goes into

Status: Accepted
Date: 2026-11-13

## Decision
The Notes app is redesigned. It's a light app: a yellow header, the list of notes on the left, and the open note on a ruled legal pad on the right. Every note is its own sheet. Browsing lifts the sheet off the pad, and going back drops the last one onto it. A reads the note full width. C deletes it. D suggests or reviews tasks.

Holding the mic in Notes pushes the app down and the main agent appears above it on black: listening, thinking, then the result, which stays up for 5 seconds. The dump goes out with a new voice target, `{ kind: "auto", openNoteId }`. The server decides where the words go and answers with `note.routed`:

| What you say | Where it goes |
| --- | --- |
| "add to this note …", "add X to this note" | The open note |
| "add oat milk to the grocery list" | The note you named |
| "new note …", "add X to a new note" | A new note |
| Same topic as the open note ("carrots" on a grocery list) | The open note |
| Clearly another note's subject | That note |
| Anything else, or a heading like "Grocery list" | A new note |

Claude makes the call when a key is set (`apps/server/src/route.ts`). Otherwise rules do it: spoken commands, shared words, and a small food lexicon. Added text goes on a new line, so a list stays a list. Offline, a dump is kept on the Device as a new note.

## Why
Dumping is the core of the demo. Making the user say "new note" or "append" before every thought breaks the flow. The agent already sees the open note, so it can file "carrots" under the grocery list on its own. Deciding on the server keeps the Device thin (ADR 0003).

## Consequences
- Protocol: `VoiceTarget` gains `auto`; `ServerMessage` gains `note.routed`.
- Holding the mic outside Notes (Home) is unchanged: a new note, then suggestions (ADR 0005).
- Rehearsal mode in Notes plays five lines in order (`PAD_SAMPLES` in `apps/device/src/voice/capture.ts`): a list, an item for it, an explicit add, another note's topic, an explicit new note.
- The rules fallback only understands shared words and food. Real topic sense needs the Claude key.
