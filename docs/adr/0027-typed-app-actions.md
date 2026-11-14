# 0027: Typed app actions from Task agents

Status: Accepted
Date: 2026-11-14

Supersedes the delegation limits in 0013 for typed app requests. The limits in 0013 still apply to requests that start another model turn.

## Decision

An assigned app agent runs a forwarded app action directly from its saved tool input. A Task agent can use these actions at any delegation depth, including when the app agent also sent the original Task. Each action runs through the app's ownership and approval checks.

The To-Do read action exposes the current tasks, due dates, and projects. The write action can rename, reschedule, or move an existing To-Do by ID. Notes can replace the text of an existing Note after approval in Manual or Auto.

## Why

An app action reads or changes live state. The Task agent can resolve the target from the app even when a saved Task has no conversation. An app action runs a typed operation, so it does not need a model turn or use the limit on agent-to-agent conversations.
