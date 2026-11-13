# 0009: Speech to text chain

Status: Accepted
Date: 2026-11-13

## Decision
While the mic is held, the Device streams audio to the server (`voice.chunk`) and shows its own live transcript (browser speech recognition where available). On release the note is saved at once with that text, then replaced by the server's transcript unless the user changed the note:

1. Cloud: any OpenAI-compatible `/audio/transcriptions` endpoint (`STT_API_KEY`).
2. Local: a whisper.cpp / faster-whisper server (`LOCAL_STT_URL`).
3. Otherwise the Device's own transcript stays.

Offline, the note and its audio stay on the Device and sync with `note.sync` when back; the cloud re-transcribes it only if the user hasn't edited it (ADR 0005).

A scripted voice mode plays sample dumps word by word for rehearsals and stage backup.

## Why
Meets the under-2-second first reaction (the note appears in about 50 ms on a LAN) without waiting for transcription. Claude has no speech-to-text endpoint, so STT is a separate, swappable provider.

## Consequences
- A real mic needs a secure context: use `localhost` or HTTPS (`tailscale serve` works).
- In scripted mode notes show "Cloud transcript" after the simulated re-check. Say so if asked.
