#!/usr/bin/env bash
# The cloud architecture on this machine: build both images, start the 8 GB cloud box and the 2 GB
# device box, run the smoke test through the device box, print memory. Needs Docker and a model key.
#   OPENROUTER_API_KEY=... cloud-vm/sim/run.sh         KEEP=1 leaves the boxes running
# Behind a TLS-inspecting proxy: CA_CERT=/path/ca.crt (HTTPS_PROXY is passed through).
set -euo pipefail
cd "$(dirname "$0")/../.."
build() {
  local args=(--network host -t "$1" -f "$2")
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY; do [ -n "${!v:-}" ] && args+=(--build-arg "$v=${!v}"); done
  [ -n "${CA_CERT:-}" ] && args+=(--secret "id=ca,src=$CA_CERT")
  DOCKER_BUILDKIT=1 docker build "${args[@]}" .
}
[ -n "${SKIP_BUILD:-}" ] || { build flip-server:local docker/server.Dockerfile; build flip-device:local docker/device.Dockerfile; }
compose() { docker compose -f cloud-vm/sim/compose.yml -p flip-sim "$@"; }
compose up -d
trap '[ -n "${KEEP:-}" ] || compose down' EXIT
for i in $(seq 1 90); do curl -fs http://127.0.0.1:5173/health >/dev/null 2>&1 && break; sleep 1; done
node cloud-vm/sim/smoke.mjs
