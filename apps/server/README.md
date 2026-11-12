# apps/server

Node + TypeScript. WebSocket server speaking `@app/protocol`.

- Voice: streaming cloud speech-to-text, local fallback.
- Notes and suggestions (ADR 0005).
- Task agents, one per app, with permission modes and hard rules (ADR 0004).
- Sends commands to the PC agent over Tailscale (ADR 0006).
- BYOK: provider key from env or settings.
