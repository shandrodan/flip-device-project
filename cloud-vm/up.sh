#!/usr/bin/env bash
# Everything, plug and play: the cloud VM (8 GB) and the Device VM (Pi 5-class, 2 GB), wired together.
#   gcloud auth login && gcloud config set project <project>
#   cloud-vm/up.sh            then cloud-vm/tunnel.sh and pi-vm/tunnel.sh
# Re-run after changes: it skips what exists and redeploys both.
set -euo pipefail
cd "$(dirname "$0")/.."
ZONE=${ZONE:-europe-west1-b}
CLOUD=${CLOUD_NAME:-flip-cloud}
PI=${PI_NAME:-flip-pi}

NAME=$CLOUD ZONE=$ZONE cloud-vm/create.sh
gcloud compute instances describe "$PI" --zone "$ZONE" >/dev/null 2>&1 || NAME=$PI ZONE=$ZONE pi-vm/create.sh

# Only the Device VM may reach the server port, on the internal network.
gcloud compute instances add-tags "$CLOUD" --zone "$ZONE" --tags flip-cloud >/dev/null
gcloud compute instances add-tags "$PI" --zone "$ZONE" --tags flip-pi >/dev/null
gcloud compute firewall-rules describe flip-device-to-cloud >/dev/null 2>&1 || gcloud compute firewall-rules create flip-device-to-cloud \
  --network "${NETWORK:-default}" --allow tcp:8787 --source-tags flip-pi --target-tags flip-cloud --description "Flip Device VM to cloud server"

NAME=$CLOUD ZONE=$ZONE cloud-vm/deploy.sh
IP=$(gcloud compute instances describe "$CLOUD" --zone "$ZONE" --format='get(networkInterfaces[0].networkIP)')
echo "Cloud VM internal address: $IP"
NAME=$PI ZONE=$ZONE SERVER_URL="http://$IP:8787" pi-vm/deploy.sh

echo
echo "Done. Device VM → cloud VM at http://$IP:8787 (internal network only)."
echo "Next, on this laptop:"
echo "  cloud-vm/tunnel.sh      setup page on http://localhost:18788/setup, and your PC agent for the cloud"
echo "  pi-vm/tunnel.sh         the Device screen, then open the twin as in pi-vm/README.md"
