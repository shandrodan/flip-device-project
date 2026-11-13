# APPS.md

Built-in apps. Notes, To-Do, Focus, Agents, and Settings each have at least one assigned Task agent.
When another Task agent needs an app, the server sends a saved request to the assigned agent
with the fewest active Tasks and waits for a reply. The server checks approvals before an
agent changes app state.
On Home, select an app and press the blue D button to add, change, or delete a Task agent.
One Task agent can belong to only one app. The last Task agent of an app cannot be deleted.
The Dock reads other app state and has no assigned Task agent.

## Notes (core of the demo)

Flow:
1. Press talk and speak.
2. Transcribe with the cloud model. If offline, transcribe locally, then re-transcribe with the cloud once back online.
3. Save the note instantly. No question asked while you talk.
4. The device suggests actions ("this looks like 2 tasks"). One press accepts.
5. An accepted task goes to an agent, or to a todo list.

Rules:
- Cloud re-transcription only replaces the text if the user hasn't edited the note.
- Hackathon scope: one todo integration only (our own list or Todoist). "More coming" for the rest.

## Todo

- Tasks from notes or voice.
- Each task can be handed to an agent or kept as a plain todo.

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
