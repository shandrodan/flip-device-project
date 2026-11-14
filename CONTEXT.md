# CONTEXT.md

Our shared words. Use them exactly in code, docs, issues and the pitch.

| Term | Meaning |
| --- | --- |
| **Device** | The handheld flip unit. In the hackathon: the `apps/device` web app. |
| **Dock** | The cradle at the desk. In the hackathon: a second screen of `apps/device`. |
| **Handheld mode** | Device off the dock, on battery. |
| **Dock mode** | Device in the dock, acting as a companion screen. |
| **Dump** | Speaking a raw thought into the device. Always saved as a note first. |
| **Note** | The saved transcript of a dump. |
| **Suggestion** | A task the device proposes from a note. Accepted with one press. |
| **Task** | A unit of work, either kept as a todo or handed to an agent. |
| **Project** | A named list of tasks in the To-Do app. A task with no project sits in Inbox. |
| **Build** | The app where you talk and an agent builds a web app on your machine, with a live preview. With no Task agent of its own, the main agent works there. |
| **Task agent** | A server-side agent that owns one kind of work. A Device app has one or more assigned Task agents. Other agents send app work to one of them. |
| **Coding agent** | A coding tool running on your own machine (Claude Code, Codex, OpenCode, …). The PC agent reports it; the Dock shows it. Not a Task agent. |
| **PC agent** | The small program on the user's laptop that executes actions sent over Tailscale. |
| **Approval press** | The physical-button press, with a haptic click, that confirms a risky action. |
| **Risky action** | Anything that sends, deletes, pays, or leaves the user's machines. Always needs an approval press. |
| **Permission mode** | Manual, Auto or Full. See `docs/adr/0004-permission-modes.md`. |
| **Our cloud / Own VM / Self-hosted** | The three places the server can run. |
| **BYOK** | Bring your own AI provider key. |
| **Protocol** | The WebSocket messages in `packages/protocol`. What real firmware would speak. |
