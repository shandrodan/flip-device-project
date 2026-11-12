# 0004: Permission modes with hard rules on top

Status: Accepted
Date: 2026-11-12

## Decision
Three modes: Manual (every action needs an approval press), Auto (a model decides whether to ask) and Full (runs like Claude Code, sandbox or own VM only, never the default). In every mode except Full, risky actions (send, delete, pay, leave the user's machines) always need an approval press, whatever the model decides.

## Why
One wrong auto-decision destroys trust. Hard rules are predictable; the model only handles the grey zone.

## Consequences
The approval press is the main reason the hardware has buttons. The demo uses Auto and shows one approval press.
