# Deploy on Google Cloud

Plug and play: one command makes both VMs and wires them. Re-run it after every change.

## Once

```sh
gcloud auth login
gcloud config set project <your-project>
gcloud services enable compute.googleapis.com
```

Put your keys in `.env` at the repo root (copied to the cloud VM, mode 600), or paste them on the setup page later:

```sh
OPENROUTER_API_KEY=sk-or-...
# optional
OPENROUTER_MODEL=deepseek/deepseek-v4.1-flash     # default; anthropic/claude-haiku-5.5 if you want stronger
DEVICE_ACCESS_TOKEN=...                           # optional; needed to enable PC-agent shell from the Device
```

## Up

```sh
cloud-vm/up.sh
```

It:
1. creates `flip-cloud` (`e2-standard-2`, 8 GB, Debian 12) if missing,
2. creates `flip-pi` (`c4a-highcpu-4` arm64, clamped to 2 GB) if missing,
3. tags both and adds the firewall rule `flip-device-to-cloud` (tcp:8787, Device VM to cloud VM only),
4. deploys the server to the cloud VM (`cloud-vm/deploy.sh` → `provision.sh`, systemd `flip-server`, `MemoryMax=8G`),
5. deploys the Device to the Pi VM with `SERVER_URL=http://<cloud internal IP>:8787`, so the Pi VM runs no server.

Both VMs are in `europe-west1-b`. Change with `ZONE=...`. Names: `CLOUD_NAME`, `PI_NAME`.

## Use it

Two tunnels from your laptop, each in its own terminal:

```sh
cloud-vm/tunnel.sh    # localhost:18788 → cloud server (/setup, /health, /preview/); your PC agent → cloud
pi-vm/tunnel.sh       # the Device screen stream, mic, and the Device app on localhost:15173
pnpm dev:pc           # optional: your laptop as a machine the agents can act on
pnpm dev:device       # the 3D twin on the laptop
```

Open **http://localhost:5173/?remote=http://localhost:17900&server=http://localhost:18787** (the twin showing the Pi VM's real screen). Keys: **http://localhost:18788/setup**.

Check it end to end from the laptop (needs Node and Playwright, with `pi-vm/tunnel.sh` open):

```sh
DEVICE=http://localhost:15173 VITE=0 node cloud-vm/sim/smoke.mjs
```

## Look inside

```sh
cloud-vm/status.sh                                   # health, memory, top processes, last logs
gcloud compute ssh flip-cloud --zone europe-west1-b
journalctl -u flip-server -f
ls /var/lib/flip/build                               # the Build project
ls /var/lib/flip/data/engine/home/data/opencode      # agent sessions (opencode.db)
```

## Change things

| Want | Do |
| --- | --- |
| Deploy code changes | `cloud-vm/up.sh` (or just `cloud-vm/deploy.sh` for server-only changes) |
| Another model | `OPENROUTER_MODEL=...` in `.env`, redeploy. Or `ENGINE_MODEL=provider/model` for the agents only |
| A local or other provider | `ENGINE_CONFIG` JSON (see `apps/server/README.md`) |
| Reset agent memory | delete `/var/lib/flip/data/engine/home`, restart `flip-server` |
| Start the Build project over | empty `/var/lib/flip/build` (keep the folder) |
| PC agent over Tailscale instead of the tunnel | install Tailscale on the cloud VM and the laptop, `PC_AGENTS="MacBook=ws://100.x.y.z:7077" cloud-vm/deploy.sh` |
| Bigger cloud | `TYPE=e2-standard-4 cloud-vm/create.sh` before the first `up.sh`, or resize the stopped VM |

## Costs and stopping

`e2-standard-2` and `c4a-highcpu-4` run around a few dollars a day together. Stop both when you're done:

```sh
gcloud compute instances stop flip-cloud flip-pi --zone europe-west1-b      # keeps disks
gcloud compute instances delete flip-cloud flip-pi --zone europe-west1-b    # gone
gcloud compute firewall-rules delete flip-device-to-cloud
```

## When it doesn't work

| Symptom | Look at |
| --- | --- |
| Device says it can't reach the server | `curl http://<cloud internal IP>:8787/health` from the Pi VM; firewall rule and tags; `systemctl status flip-device` on the Pi VM (its `SERVER_URL`) |
| Agents answer "Add an OpenRouter or Anthropic key" | Keys: `/setup` through `cloud-vm/tunnel.sh`, or `.env` + redeploy |
| First agent request is slow | OpenCode starts with the server; its first start installs its plugin package from npm (one time, ~20 s) |
| `[engine] ... built-in loop` in the log | OpenCode failed to start; Tasks still work on the old loop. `ENGINE_VERBOSE=1` shows why |
| Build preview blank with a dev server | `build_logs` (ask the Build agent "show me the dev server logs"); the dev server must use `--base /preview/` |
| PC tools fail | `pnpm dev:pc` running and `cloud-vm/tunnel.sh` open (it carries 7077 back to the laptop) |
