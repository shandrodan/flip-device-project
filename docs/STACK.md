# STACK.md

## Layers (real device)

1. **Hardware:** small arm64 board with screen, mic, speaker, buttons, battery.
2. **Linux:** Debian or Raspberry Pi OS Lite for now. Buildroot or Yocto later for a tiny, fast-booting image.
3. **UI runtime:** browser in kiosk mode showing the React app. Chromium for dev, WPE WebKit (Cog) in production for lower memory use.
4. **Backend:** Node + TypeScript running the agents.

## Hackathon stack

| Part | Tech |
| --- | --- |
| Device UI | React + Vite PWA, full screen |
| Dock screen | Same app, second view on the same WebSocket |
| Backend | Node + TypeScript, WebSocket server |
| Agents | Agent loop on the backend; Playwright in Docker for browser tasks |
| Device-to-PC link | Tailscale, plus a small agent running on the PC |
| Voice | Cloud speech-to-text, local model as fallback |
| Container | arm64 image via `docker buildx`, run with `--memory=512m --cpus=1` |

## How it fits

```
Device (React UI, voice input, apps)
   │  WebSocket: voice + app requests, progress events back
   ▼
Backend (Node): task agents, cloud offload
   │
   ├── Your devices (PC agent over Tailscale)
   └── AI provider (bring your own key)
```

The WebSocket protocol is what real firmware would speak, so a hardware client is a swap, not a rewrite.

## Hosting

- Our cloud by default.
- Bring your own AI key.
- Connect your own VM instead of our cloud.
- Fully self-hostable, no reliance on our infrastructure.

## Agent permissions

| Mode | Behavior |
| --- | --- |
| Manual | Every action waits for a button press. |
| Auto (default for demo) | A model decides whether to ask. Hard rules override it: send, delete, pay and anything leaving your machines always ask. |
| Full | Runs like Claude Code with full permissions. Only for your own sandbox or VM. Never the default. |

## Latency target

Under 2 seconds from end of speech to the first visible reaction. Stream speech-to-text, text-to-speech and agent progress events.
