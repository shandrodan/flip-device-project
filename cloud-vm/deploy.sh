#!/usr/bin/env bash
# Copy this working tree, .env and the /setup keys to the cloud VM, then provision it. Re-run after changes.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${NAME:-flip-cloud}
ZONE=${ZONE:-europe-west1-b}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git ls-files -co --exclude-standard -z | grep -zv '^renders/\|^pitch/\|^apps/device/studio/' | tar --null -T - -czf "$tmp/flip.tgz"
files=("$tmp/flip.tgz")
[ -f .env ] && cp .env "$tmp/flip.env" && files+=("$tmp/flip.env")
[ -f apps/server/data/secrets.json ] && cp apps/server/data/secrets.json "$tmp/flip-secrets.json" && files+=("$tmp/flip-secrets.json")
[ -f apps/server/data/state.json ] && cp apps/server/data/state.json "$tmp/flip-state.json" && files+=("$tmp/flip-state.json")

gcloud compute scp --zone "$ZONE" "${files[@]}" cloud-vm/provision.sh "$NAME":/tmp/
gcloud compute ssh --zone "$ZONE" "$NAME" --command "sudo PUBLIC_URL='${PUBLIC_URL:-}' PC_AGENTS='${PC_AGENTS:-}' TZ_NAME='${TZ_NAME:-}' bash /tmp/provision.sh"
