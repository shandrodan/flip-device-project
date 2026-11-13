# APPS.md

Built-in apps. Notes, To-Do, Focus, Agents, and Settings each have at least one assigned Task agent.
When another Task agent needs an app, the server sends a saved request to the assigned agent
with the fewest active Tasks and waits for a reply. The server checks approvals before an
agent changes app state.
On Home, select an app and press the blue D button to add, change, or delete a Task agent. On a Task agent, D renames it and changes its personality or look (ADR 0017).
One Task agent can belong to only one app. The last Task agent of an app cannot be deleted.
The Dock reads other app state and has no assigned Task agent.

## Notes (core of the demo)

Flow:
1. Press talk and speak.
2. Transcribe with the cloud model. If offline, transcribe locally, then re-transcribe with the cloud once back online.
3. Save the note instantly. No question asked while you talk.
4. The device suggests actions ("this looks like 2 tasks"). One press accepts.
5. An accepted task goes to an agent, or to a todo list.

On screen (ADR 0011): the list on the left, the open note on a ruled pad on the right. Hold the mic and just talk: the main agent reads the open note and files what you said there, in another note it clearly belongs to, or in a new note. "Add to this note …" and "new note …" force it. The result stays on screen for 5 seconds. On Home the mic talks to the main Task agent instead (ADR 0012).

Rules:
- Cloud re-transcription only replaces the text if the user hasn't edited the note.
- Hackathon scope: one todo integration only (our own list or Todoist). "More coming" for the rest.

## Todo

- Tasks from notes or voice.
- Each task can be handed to an agent or kept as a plain todo.

On screen (ADR 0016): Notes' layout in blue. Today, Inbox, Scheduled (a board of days) and Completed, then projects. The selected task opens into a card in place. Hold the mic and say a task: it's kept as a note, then filed with its day, project, or the agent you named. Our own list for now; Todoist is still open.

## Focus timer

- Pomodoro timer, mainly used when docked.

## Dock widgets

- Focus timer, today's todos, agent activity.
- "Claude limits reset in X min" countdown (fun hook for the builder audience).

## Settings

- AI key, hosting choice (our cloud, own VM, self-hosted), permission mode, connected devices.

## Maybe later

- Journal
- Third-party apps via the open SDK
