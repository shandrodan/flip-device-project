#!/usr/bin/env bash
# Reach the cloud VM from this laptop over SSH. Nothing on it is open to the internet.
#   localhost:18788  the cloud server: /setup for keys, /health, /preview/ for the Build app
# And back the other way: the cloud's agents reach this laptop's PC agent (pnpm dev:pc) on 127.0.0.1:7077.
set -euo pipefail
NAME=${NAME:-flip-cloud}
ZONE=${ZONE:-europe-west1-b}
echo "Setup page: http://localhost:18788/setup     Build preview: http://localhost:18788/preview/"
gcloud compute ssh --zone "$ZONE" "$NAME" -- -N \
  -L 18788:127.0.0.1:8787 -R 7077:127.0.0.1:7077 \
  -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes
