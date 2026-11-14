#!/usr/bin/env bash
# Create the Pi 5-class VM on Google Cloud (ADR 0024).
#   arm64 (Google Axion, Neoverse V2), 4 cores like the Pi 5's 4x Cortex-A76.
#   The machine has 8 GB; provision.sh clamps the kernel to 2 GB (mem=2G) and turns swap off.
# Usage: pi-vm/create.sh            (then pi-vm/deploy.sh)
set -euo pipefail
NAME=${NAME:-flip-pi}
ZONE=${ZONE:-europe-west1-b}
TYPE=${TYPE:-c4a-highcpu-4}

gcloud compute instances create "$NAME" \
  --zone "$ZONE" --machine-type "$TYPE" \
  --image-family debian-12-arm64 --image-project debian-cloud \
  --boot-disk-size 20GB --boot-disk-type hyperdisk-balanced \
  --labels purpose=flip-pi-demo

echo "Created $NAME in $ZONE. Next: pi-vm/deploy.sh"
