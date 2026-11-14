# 0028: Disconnect a Task agent from an app

Status: Accepted
Date: 2026-11-14

## Decision
Adds a fourth app agent action to ADR 0015 and ADR 0017: **Disconnect agent**. It takes a Task agent out of an app and keeps it. The agent becomes free, so it can join another app or stay on its own.

- Protocol: `{ type: "app.agent.remove"; app; agentId }`. Not risky: nothing is deleted and nothing leaves the user's machines, so no approval press.
- App cell menu and the app agent screen: Open · Add agent · Change agent · Disconnect agent · Delete agent.
- Bot cell menu: a linked bot shows "Leave <app>" where a free bot shows "Join an app".
- The same rules as Delete: the last agent of an app that needs one can't leave (`minAppAgents`), and a busy agent must finish its work first. Build can lose its last agent; the main agent takes over (ADR 0021).
- The main agent is never linked to an app (ADR 0029).

## Why
The only way to unlink a bot from an app was to delete it, which also threw away its name, look and personality, and needed an approval press. Moving a bot between apps should be a quick, safe press.

## Consequences
On Home the bot splits off its app cluster and stands alone right away. Deleting stays a separate, risky action.
