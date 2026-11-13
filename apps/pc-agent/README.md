# apps/pc-agent

Small Node program on the user's laptop. The server connects to it over Tailscale, sends `pc.run`, and gets `pc.progress` and `pc.done` back. It prints every action in the terminal, so the room can follow along on the projector.

```bash
# on the laptop (find its address with `tailscale ip -4`)
PC_AGENT_TOKEN=change-me PC_AGENT_HOST=100.x.y.z PC_AGENT_NAME="MacBook Pro" pnpm --filter pc-agent dev
# on the server
PC_AGENTS="MacBook Pro=ws://100.x.y.z:7077" PC_AGENT_TOKEN=change-me pnpm --filter server dev
```

Allowed actions and folders: ADR 0008. Defaults: `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Pictures`, `~/Flip` (set `PC_AGENT_ROOTS` to change). Deletes go to `~/.flip-trash`. `--allow-shell` turns on shell commands, which always need an approval press unless Full mode is on.

With the default token it only listens on 127.0.0.1.
