# 0016: To-Do is a light app with lists, and a dump there becomes a task

Status: Accepted
Date: 2026-11-13
Relates to: 0012 and 0014. Like the Notes mic, the To-Do mic makes a Dump, not a message to the To-Do agent. That agent still takes To-Do work that other Task agents send it.

## Decision
The To-Do app looks like Notes (ADR 0011) in blue: a blue header with the dotted edge, lists on the left, tasks on the right. Lists: **Today** (due today or overdue), **Inbox** (no project), **Scheduled** (a board with one column per day, Overdue first), **Completed**, then the projects. The selected task opens into a white card in place; the other tasks stay one line.

Holding the mic in To-Do pushes the app down and the main agent appears above it on black, as in Notes. What you say is saved as a note first (a dump is always a note), then the main agent makes it **one task**: a title, maybe a day and time, maybe a project, and an agent only when you name one ("ask the mail agent to …"). The open list is the default: dumping in Today makes it due today, dumping in a project files it there.

Controls in To-Do:

| Control | Does |
| --- | --- |
| In-app wheel / D-pad up and down | Browse tasks, or lists when the sidebar has focus |
| D-pad left and right | Between the sidebar and the tasks; between days on the Scheduled board |
| Push bar | Complete. In Completed: Restore |
| A | Open the task (steps, approvals, stop) |
| B | Back to the lists, then back to Home |
| C | Move to Today. On the Overdue column: reschedule all of it to today |
| D | Hand to an agent |
| Mic | Hold to add a task |

Completed tasks no longer just disappear: they leave the list and wait in Completed, where the push bar restores them.

Protocol: `Task` gains optional `due` (local "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm") and `projectId`; the snapshot gains `projects`; `task.reschedule` moves a task; the voice target `{ kind: "task", listId }` is answered with `task.routed`. All of it is additive, so the protocol version stays 2.

## Motion (decided from a throwaway prototype with three directions, now deleted)
- One row element per task, never remounted while browsing. The title is always set at 20px and scaled to 0.75 when closed; opening scales it up in place and wraps it. Nothing fades in or out.
- The card's height grows to fit and uncovers the details below the title. Height, title scale and list offset share 320ms, `cubic-bezier(0.32, 0.72, 0, 1)`.
- A task with nothing under its title opens as a 44px card with the title centred.
- Completing ticks the box, slides the row out and closes the gap; the next task opens with the same morph.

Rejected:
- **Legal pad** (tasks on the ruled lines of one sheet): matched Notes, but one line per task cuts long titles and leaves no room for project or agent.
- **Ledger** (flat list grouped by day, every row with full metadata): easy to scan, but the busiest and least like the device.
- **Crossfading** a one-line title into a separate open title: the card flashed empty white on every move.
- A "Todoist · synced" label: we don't sync with Todoist, so the header shows open and done counts instead.

## Why
To-Do and Notes are the two apps you live in, and they should feel like one family. One task opened at a time fits a wheel and a small screen, and shows an agent's steps right where the task is. Making the dump a task directly (still keeping the note) is what you want when you're already in your list.

## Consequences
- device-controls.md "To-Do Mode" changes: completed tasks go to Completed instead of disappearing.
- Projects are seeded on the server. There is no way to create one on the Device yet.
- Saved state from before this change has no dates or projects: those tasks show in Inbox.
- The Todoist integration (ADR 0005) is still open; this is "our own list".
