# 0015: One or more Task agents per Device app

Status: Accepted
Date: 2026-11-13

## Decision

Each Device app has at least one assigned Task agent. One Task agent can belong to at most one
app. The main Task agent stays a coordinator and cannot join an app. This supersedes the
single-agent rule in ADR 0014.

On Home, the blue D button opens an app agent menu with Add, Change, and Delete. Add assigns
a free Task agent or makes a new one. Change replaces one app agent with a free agent and keeps
the old agent. Delete removes the selected Task agent from the system after an approval press.
The last Task agent of an app cannot be deleted. On Home, the same D button opens pending
Suggestions when the selected item is not an app.

For a new app request, the server chooses the assigned Task agent with the fewest active Tasks.
It saves that agent on the Task before work starts. An agent assigned to an app can do its own
app action. App-screen voice uses the same selection rule. Voice on one Task agent's screen
still goes to that agent. The Notes mic still makes a Dump.

## Consequences

The server converts saved single-agent assignments to lists and keeps existing agents, Tasks,
and messages. It does not recreate a default app agent after that agent is deleted. The server
enforces one app per agent and at least one agent per app for every change. App actions still
use saved Tasks, replies, and the existing approval rules.
