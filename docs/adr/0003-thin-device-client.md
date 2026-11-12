# 0003: Thin device, smart server

Status: Accepted
Date: 2026-11-12

## Decision
The device only does UI, voice capture and button input. Agents, browsing and heavy work run on the server (our cloud, own VM or self-hosted). Device and server talk over the WebSocket protocol in `packages/protocol`.

## Why
Keeps the device inside Raspberry Pi 5-class memory, and lets real firmware replace the web app later without a rewrite.

## Consequences
The device needs a connection for agents. Offline, only local transcription and notes work. Production UI runtime: WPE WebKit (Cog) instead of Chromium for lower memory.
