#!/usr/bin/env bash
# Copy this working tree (tracked + untracked, not ignored) and .env to the VM, then provision it.
# Safe to re-run after every change.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=${NAME:-flip-pi}
ZONE=${ZONE:-europe-west1-b}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git ls-files -co --exclude-standard -z | grep -zv '^renders/\|^pitch/' | tar --null -T - -czf "$tmp/flip.tgz"
files=("$tmp/flip.tgz")
[ -f .env ] && cp .env "$tmp/flip.env" && files+=("$tmp/flip.env")
# Keys saved through /setup (OpenRouter for agents and Whisper), and the notes and tasks so far.
[ -f apps/server/data/secrets.json ] && cp apps/server/data/secrets.json "$tmp/flip-secrets.json" && files+=("$tmp/flip-secrets.json")
[ -f apps/server/data/state.json ] && cp apps/server/data/state.json "$tmp/flip-state.json" && files+=("$tmp/flip-state.json")

gcloud compute scp --zone "$ZONE" "${files[@]}" pi-vm/provision.sh "$NAME":/tmp/
gcloud compute ssh --zone "$ZONE" "$NAME" --command "sudo bash /tmp/provision.sh"
