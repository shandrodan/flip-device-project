# 0012: One assigned Task agent per Device app

Status: Accepted
Date: 2026-11-13

## Decision

Notes, To-Do, Focus, Agents, and Settings each have one assigned Task agent. The server saves
the assignment and sends every agent app action to that agent. The requesting Task agent waits
for the assigned agent's saved reply. An agent can own only one app. The user can change an
assignment on the Device. An assigned agent cannot be deleted until the user assigns a new one.

This supersedes the part of ADR 0011 that lets every Task agent directly use every app action.
The Dock is a read-only view of other app data. It has no assigned Task agent. The Notes mic
still records a Dump directly; recording is a Device input action, not an agent app action.

## Why

The server must enforce which Task agent owns an app. A prompt alone cannot do this. Saved
assignments let a new Task agent become an owner without changing the routing code.

## Consequences

The server adds default app agents to existing state files and keeps user agents and tasks.
App requests use the existing Task queue, messages, and approval rules. The assigned agent
receives a structured app request. A failed owner task reports its failure to the requester.
Keys and Full permission mode stay user-only.
