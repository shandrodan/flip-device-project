#!/usr/bin/env bash
# Runs on the cloud VM as root (deploy.sh calls it). Idempotent.
# Turns a stock Debian 12 VM into the Flip cloud: the server on :8787 with the agent engine (OpenCode)
# and the Build project in /var/lib/flip/build. Capped at 8 GB by systemd.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP=/opt/flip

if ! node -v 2>/dev/null | grep -q '^v22'; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg git python3 make g++
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
corepack enable
corepack prepare pnpm@9.15.0 --activate >/dev/null
timedatectl set-timezone "${TZ_NAME:-Europe/Vilnius}"

id flip >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/flip --shell /bin/bash flip
mkdir -p "$APP"
rm -rf "$APP/apps" "$APP/packages"
tar -xzf /tmp/flip.tgz -C "$APP"
[ -f /tmp/flip.env ] && install -m 600 -o flip /tmp/flip.env "$APP/.env"
chown -R flip:flip "$APP"
install -d -o flip -g flip /var/lib/flip/data /var/lib/flip/build
[ -f /tmp/flip-secrets.json ] && install -m 600 -o flip -g flip /tmp/flip-secrets.json /var/lib/flip/data/secrets.json
[ -f /tmp/flip-state.json ] && [ ! -f /var/lib/flip/data/state.json ] && install -m 600 -o flip -g flip /tmp/flip-state.json /var/lib/flip/data/state.json
rm -f /tmp/flip-secrets.json /tmp/flip.env
cd "$APP"
sudo -u flip -H pnpm install --filter server... --no-frozen-lockfile
# Headless Chromium for build_screenshot (the agent looks at its own preview). Shared, read-only.
export PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
(cd "$APP/apps/server" && node node_modules/playwright-core/cli.js install --with-deps --only-shell chromium)
chmod -R a+rX /opt/ms-playwright

mkdir -p /etc/flip
# Loaded after .env, so these win. PUBLIC_URL is how the Device reaches the server: through its own
# Device app server (docker/serve.mjs passes /ws, /setup and /preview/ through), so one origin.
cat >/etc/flip/cloud.env <<ENV
PORT=8787
HOST=0.0.0.0
DATA_DIR=/var/lib/flip/data
HOSTING=vm
BUILD_HOST=server
BUILD_DIR=/var/lib/flip/build
PUBLIC_URL=${PUBLIC_URL:-http://localhost:5173}
PC_AGENTS=${PC_AGENTS:-This computer=ws://127.0.0.1:7077}
PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ENV

cat >/etc/systemd/system/flip-server.service <<UNIT
[Unit]
Description=Flip cloud server (agents, engine, Build)
After=network-online.target
[Service]
User=flip
WorkingDirectory=$APP/apps/server
EnvironmentFile=-$APP/.env
EnvironmentFile=/etc/flip/cloud.env
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=always
RestartSec=2
# The whole cloud side (server, OpenCode, the Build dev server, npm installs) stays under 8 GB.
MemoryMax=8G
MemorySwapMax=0
KillMode=control-group
[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable flip-server
systemctl restart flip-server
for i in $(seq 1 60); do curl -fs http://127.0.0.1:8787/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:8787/health && echo
echo "Internal address: http://$(hostname -I | awk '{print $1}'):8787"
