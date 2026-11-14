#!/usr/bin/env bash
# Reach the VM from this laptop over SSH. Nothing on the VM is open to the internet.
#   localhost:17900  the Device screen stream + resource monitor (relay.mjs)
#   localhost:15173  the Device app served by the VM (open /dock here for the Dock)
#   localhost:18787  the server: the cloud VM's when there is one (cloud-vm/), else this VM's
# And back the other way: the VM's server reaches this laptop's PC agent on 127.0.0.1:7077.
set -euo pipefail
NAME=${NAME:-flip-pi}
ZONE=${ZONE:-europe-west1-b}
# With the server on the cloud VM (cloud-vm/up.sh), localhost:18787 reaches it through this VM.
SERVER=${SERVER_TARGET:-127.0.0.1:8787}
if [ -z "${SERVER_TARGET:-}" ] && gcloud compute instances describe "${CLOUD_NAME:-flip-cloud}" --zone "$ZONE" >/dev/null 2>&1; then
  SERVER="$(gcloud compute instances describe "${CLOUD_NAME:-flip-cloud}" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)'):8787"
fi
echo "Twin with the VM's screen: http://localhost:5173/?remote=http://localhost:17900&server=http://localhost:18787"
echo "Monitor:                   http://localhost:17900"
gcloud compute ssh --zone "$ZONE" "$NAME" -- -N \
  -L 17900:127.0.0.1:7900 -L 15173:127.0.0.1:5173 -L "18787:$SERVER" \
  -R 7077:127.0.0.1:7077 -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes
