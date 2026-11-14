# 0029: Omni, the main agent, never joins an app

Status: Accepted
Date: 2026-11-14

## Decision
Omni (the main agent, id `main`) is never linked to a Device app. On Home it no longer sits fused to Notes in the Notes colours; it stands alone, white, like in the pitch.

This was already true on the server: `app.agent.add` and `app.agent.replace` refuse `main`, and loading saved state drops `main` from every app. The Device drew a fixed Notes link on top of that (`APP_BOTS` in `tone.tsx`). That link is gone. The Device also never offers "Join an app" for Omni or lists it as a free agent.

Omni still hears every dump and routes it (ADR 0011), and still does Build's work when Build has no agent of its own (ADR 0021). Those are fallbacks, not app membership.

## Why
Omni runs the other agents. Showing it as part of one app made it look like the Notes agent and hid that it sits above all of them.

## Consequences
Notes shows only its own Task agents. Omni can't be disconnected, because it is never connected.
