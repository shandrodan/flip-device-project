# 0022: Server-proxied Build preview

Status: Accepted. Supersedes the preview-address consequence of 0021
Date: 2026-11-14

## Decision

Build starts with a server-proxied preview. The Device loads `/preview/` from the same server it already reaches, and that route reads only files inside `BUILD_DIR` through the existing `fs.read` PC-agent action. `BUILD_PREVIEW_URL` or `build_preview` switches Build to a verified custom dev-server address when a framework needs one.

## Why

An agent must not guess a Tailscale address, and a plain HTML build should not need shell access just to appear on the Device. The server already has an authenticated link to the PC agent and is reachable by the Device.

## Consequences

Static HTML, CSS, browser JavaScript, and assets work without enabling shell access. A project that needs compilation still needs an explicit dev server and custom preview address. The server reads preview files on demand, so this path is for the small demo app rather than large asset delivery.
