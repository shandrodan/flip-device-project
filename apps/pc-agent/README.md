# apps/pc-agent

Small Node program on the user's laptop. The server connects to it over Tailscale, sends `pc.run`, and gets `pc.progress` and `pc.done` back. It prints every action in the terminal, so the room can follow along on the projector.

```bash
# on the laptop (find its address with `tailscale ip -4`)
PC_AGENT_TOKEN=change-me PC_AGENT_HOST=100.x.y.z PC_AGENT_NAME="MacBook Pro" pnpm --filter pc-agent dev
# on the server
PC_AGENTS="MacBook Pro=ws://100.x.y.z:7077" PC_AGENT_TOKEN=change-me pnpm --filter server dev
```

The file tools default to `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Pictures`, and `~/Flip`. Set `PC_AGENT_ROOTS` to change that list. The trash tool moves files to `~/.flip-trash`.

With the default token it only listens on 127.0.0.1.

Set `PC_AGENT_ALLOW_OPEN=0` for unattended runs that should keep file actions enabled but leave desktop apps closed.

## Shell access

Shell access lets a Task agent perform local actions with the permissions of the OS account running the PC agent. It uses Windows PowerShell on Windows and POSIX sh on macOS and Linux. Commands can work outside the file-tool folders and can make changes that the trash tool cannot reverse.

1. Set a private random `PC_AGENT_TOKEN` of at least 24 characters in the PC agent environment and put the same value in the server's `.env`. For a remote PC agent, set `PC_AGENT_HOST` to its Tailscale IP and set `PC_AGENTS` on the server.
2. Set a separate random `DEVICE_ACCESS_TOKEN` of at least 24 letters, digits, underscores, or hyphens in the server's `.env`. Restart the server and open the Device at `http://localhost:5173/#deviceToken=YOUR_TOKEN`. Use HTTPS for a remote Device. The setup page takes `?token=YOUR_TOKEN` using the setup token when one is configured, or the Device token otherwise.
3. Stop the default PC agent if it is already running. In the PC agent terminal set `PC_AGENT_ALLOW_SHELL=1` and run `pnpm dev:pc`. On Windows PowerShell, set it with `$env:PC_AGENT_ALLOW_SHELL = "1"`. The flag `--allow-shell` also enables it.

Manual and Auto ask before executing a shell command. Full uses the existing no-approval behavior and is intended for a sandbox or your own VM. See [ADR 0026](../../docs/adr/0026-conversational-task-agents.md).
