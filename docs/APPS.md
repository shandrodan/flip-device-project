# APPS.md

Built-in apps. Each app has its own agent behind it. Keep them simple.

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
