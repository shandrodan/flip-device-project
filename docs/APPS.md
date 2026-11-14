# APPS.md

Built-in apps. Notes, To-Do, Focus, Agents, and Settings each have at least one assigned Task agent.
Build can have none: then the main agent does its work (ADR 0021).
When another Task agent needs an app, the server sends a saved request to the assigned agent
with the fewest active Tasks and waits for a reply. The server checks approvals before an
agent changes app state.
On Home, select an app and press the blue D button to add, change, or delete a Task agent. On a Task agent, D renames it and changes its personality or look (ADR 0017).
One Task agent can belong to only one app. The last Task agent of an app cannot be deleted, except in Build, where the main agent takes over again.
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

## Build (ADR 0021)

- Talk, and an agent builds a web app on your own machine. The Device shows the live preview.
- On screen: a black sidebar with the agent's bot and one line (what you said, the current step, or the result). The preview takes the rest, inside a caution-tape stroke that marches while the agent works.
- No agent of its own: the main agent works here. Add a Task agent to Build (D on Home) and its bot takes the sidebar.
- The project is `BUILD_DIR` on the PC agent's machine (default `~/Flip/build`). Running commands needs the PC agent's `--allow-shell`. Publishing always needs the push bar.

## Focus timer

- Pomodoro timer, mainly used when docked.

## Dock (StandBy, ADR 0020)

- Turn the in-app wheel through Clock, Focus, Agents, the To-Do board and a split screen of two blocks you pick.
- Agents here are the coding agents on your machines (Claude Code, Codex, OpenCode, …), reported by the PC agent: working, idle or finished.
- Focus shows its progress as a glow around the screen edge.
- "Claude limits reset in X min" is one of the split-screen blocks (fun hook for the builder audience).

## Settings

- AI key, hosting choice (our cloud, own VM, self-hosted), permission mode, connected devices.

## Maybe later

- Journal
- Third-party apps via the open SDK
