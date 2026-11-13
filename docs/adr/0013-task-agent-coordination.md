# 0013: Task agent coordination and app actions

Status: Accepted
Date: 2026-11-13

## Decision

The main Task agent can give work to other Task agents and wait for their saved replies.
Any Task agent can ask another Task agent for work. A request can pass through at most two Task agents,
and one Task can send at most four requests. Each built-in app has typed server actions that every
Task agent can use. The server applies the existing approval rules to these actions.
At most two turns of one Task agent and eight active turns on the server start at once.
Other Tasks wait in a saved queue. A Task that waits for another Task agent does not use a run slot.

## Why

The server must know who owns work, what still waits, and what each Task agent changed. A model's
text alone cannot be the source of truth for work or app state.

## Consequences

The server saves requests, replies, and Task state before it starts new work. After a restart,
unfinished work is paused for review. A repeated voice request ID cannot make a second Task.
The Dock reads other app state and has no separate write action. Keys and Full permission mode
remain user-only settings.
