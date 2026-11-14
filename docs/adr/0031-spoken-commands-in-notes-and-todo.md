# 0031: A spoken command in Notes or To-Do goes to the app's Task agent

Status: Accepted
Date: 2026-11-14
Supersedes: the "always saved as a note first" part of 0011 and 0016, for commands only

## Decision
Holding the mic in Notes or To-Do still makes a Dump. Before it is saved, the server checks whether the words are something to keep or a command for the app (`apps/server/src/intent.ts`):

| What you say | What happens |
| --- | --- |
| "Buy oat milk", "grocery list", "remind me to call Rasa" | Kept, as before (ADR 0011, 0016) |
| "Delete all the notes", "move everything in Inbox to today", "how many tasks are due today?" | Sent to the app's Task agent. No Note is saved. |

The command reaches the agent like any voice request (`{ kind: "app", app }`, ADR 0012), with what was on screen: the open Note, the open list and the selected To-Do. The dictation band stays up and follows the agent's Task. It shows the current step, says when the agent needs a press, then shows its answer.

Agents can now do what these commands need, through `change_app`:
- `notes.delete` and `todo.delete`. Deleting is a Risky action, so it always takes the push bar, and one press covers the whole batch.
- `todo.update`, `todo.complete` and `todo.reopen` take several IDs, so "all" is one call and one approval.
- `read_app` returns up to 200 Notes or To-Dos and the total count.

Tasks an agent is working on are never changed or deleted under it. The command's own Task is hidden from the To-Do lists (`isAppCommand` in the protocol).

The configured model decides keep or command, and "when in doubt, keep". Without a key, rules catch only clear commands ("delete …", "move all …"). The Device then says an AI key is needed and saves nothing. Moving, renaming or completing the selected To-Do still works by rules (ADR 0025).

## Why
"Hey, delete all the notes" became a Note called "Hey, delete all the notes". Saving every Dump made sense for thoughts, but it made the mic useless for managing the app. The agents already had the tools to read and change apps; the mic in Notes and To-Do never reached them.

## Consequences
- A Dump is saved as a Note unless it is a command for the open app (CONTEXT.md updated).
- Every Dump in Notes and To-Do makes one extra short model call when a key is set.
- Protocol: `Task.voiceContext` and `isAppCommand`.
