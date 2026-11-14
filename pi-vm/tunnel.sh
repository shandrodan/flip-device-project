#!/usr/bin/env bash
# Reach the VM from this laptop over SSH. Nothing on the VM is open to the internet.
#   localhost:17900  the Device screen stream + resource monitor (relay.mjs)
#   localhost:15173  the Device app served by the VM (open /dock here for the Dock)
#   localhost:18787  the VM's server
# And back the other way: the VM's server reaches this laptop's PC agent on 127.0.0.1:7077.
set -euo pipefail
NAME=${NAME:-flip-pi}
ZONE=${ZONE:-europe-west1-b}
echo "Twin with the VM's screen: http://localhost:5173/?remote=http://localhost:17900&server=http://localhost:18787"
echo "Monitor:                   http://localhost:17900"
gcloud compute ssh --zone "$ZONE" "$NAME" -- -N \
  -L 17900:127.0.0.1:7900 -L 15173:127.0.0.1:5173 -L 18787:127.0.0.1:8787 \
  -R 7077:127.0.0.1:7077 -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes
