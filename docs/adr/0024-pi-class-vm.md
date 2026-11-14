# 0024: The Device software runs on a Pi 5-class VM

Status: Accepted
Date: 2026-11-14

## Decision
For the demo, the whole Device side runs on a Google Cloud arm64 VM set up as a Raspberry Pi 5 2 GB: 4 cores, the kernel clamped to 2 GB (`mem=2G`), no swap. On it run the server, the Device app, and a kiosk browser drawing the Device screen at 784×504. The laptop only draws the 3D twin and the page around it.

A relay on the VM (`pi-vm/relay.mjs`) links the two:
- **Screen:** the kiosk's screen streams to the twin (`/?remote=…`), on the model's screen.
- **Controls:** the twin's control presses go back as the Device's keys.
- **Mic:** while the mic is held, the laptop's microphone streams to the VM. There it feeds a PulseAudio pipe source that the kiosk records as its own mic, and the VM's server transcribes the recording (OpenRouter Whisper, ADR 0018).
- **Resources:** the relay reports RAM and CPU for each service from its cgroup, shown live under the twin.

Setup is in `pi-vm/`.

## Why
The Docker limits (`docker/`) showed only that the static server fits. Judges should see the full stack, browser included, living in 2 GB. The screen they watch on the twin and the voice they hear transcribed should be the work of that board.

## Consequences
It proves memory fit, not Pi speed: Axion cores are faster than Cortex-A76, and there is no Pi GPU. Say that on stage, and never call the VM real hardware (ADR 0002).

The Device's sounds and any spoken replies play on the VM's null sink, not the laptop; the press clicks still play on the laptop. With `?remote`, `studio.state()` cannot read the screen's words, and the frame-by-frame recorder cannot freeze the VM's clock: film remote takes live with *Record video*.

Everything is reached over an SSH tunnel; no port is open to the internet. The VM costs money while it runs: stop it after the demo.
