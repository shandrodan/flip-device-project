# 0006: Reach the user's machines through Tailscale

Status: Accepted
Date: 2026-11-12

## Decision
A small PC agent runs on each machine the user wants controlled. The server reaches it over Tailscale.

## Why
Secure private networking with no port forwarding, and judges who know it trust it.

## Consequences
The PC agent is the riskiest part of the demo. Build and test it first. What it may control (files, apps, terminal) is still open.
