#!/usr/bin/env bash
# Health, memory and the last log lines of the cloud VM.
set -euo pipefail
NAME=${NAME:-flip-cloud}
ZONE=${ZONE:-europe-west1-b}
gcloud compute ssh --zone "$ZONE" "$NAME" --command "curl -fs http://127.0.0.1:8787/health; echo; free -m; systemctl show flip-server -p MemoryCurrent -p MemoryMax; ps -o rss,cmd -u flip --sort=-rss | head -8; journalctl -u flip-server -n 30 --no-pager"
