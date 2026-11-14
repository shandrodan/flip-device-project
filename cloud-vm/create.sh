#!/usr/bin/env bash
# Create the cloud VM on Google Cloud (ADR 0033): the server, the agent engine and the Build project.
#   e2-standard-2: 2 vCPU, 8 GB, x86. Same zone as the Device VM (pi-vm/) so they talk on the internal network.
#   No public ports: the Device reaches it on the VPC; you reach it over SSH (cloud-vm/tunnel.sh).
# Usage: cloud-vm/create.sh            (then cloud-vm/deploy.sh, or cloud-vm/up.sh for everything)
set -euo pipefail
NAME=${NAME:-flip-cloud}
ZONE=${ZONE:-europe-west1-b}
TYPE=${TYPE:-e2-standard-2}

if gcloud compute instances describe "$NAME" --zone "$ZONE" >/dev/null 2>&1; then
  echo "$NAME already exists in $ZONE."
  exit 0
fi
gcloud compute instances create "$NAME" \
  --zone "$ZONE" --machine-type "$TYPE" \
  --image-family debian-12 --image-project debian-cloud \
  --boot-disk-size 30GB --boot-disk-type pd-balanced \
  --labels purpose=flip-cloud
echo "Created $NAME in $ZONE. Next: cloud-vm/deploy.sh"
