# pi-vm

The whole Device side on a VM set up as a Raspberry Pi 5 2 GB (ADR 0024). Your laptop draws the 3D model and the page; the Device software, its browser and its server run on the VM.

```
 laptop (localhost)                          VM (arm64, 4 cores, 2 GB, no swap)
 ┌──────────────────────────┐  SSH tunnel   ┌───────────────────────────────────────┐
 │ 3D twin  /?remote=…      │──presses────▶ │ relay.mjs ──keys──▶ Chromium kiosk     │
 │  screen = <img> stream   │◀──MJPEG────── │   │ ▲ screencast      (Xvfb 784×504)   │
 │  your mic, while held    │──audio──────▶ │   │ └──▶ PulseAudio mic ──▶ records     │
 │  resource panel below    │◀──metrics──── │   └ cgroups     server :8787 (Whisper)  │
 │ PC agent :7077           │◀──────────────│                 Device app :5173        │
 └──────────────────────────┘               └───────────────────────────────────────┘
```

## Run it

```sh
gcloud auth login && gcloud config set project <project>
pi-vm/create.sh      # once: c4a-highcpu-4 in europe-west1-b (NAME, ZONE, TYPE to change)
pi-vm/deploy.sh      # copies this working tree, .env and the /setup keys, installs, builds, starts.
                     # Re-run after changes. The first run reboots the VM once to clamp RAM to 2 GB.
pi-vm/tunnel.sh      # keep it open
pnpm dev:device      # the twin on the laptop, as usual
```

Then open **http://localhost:5173/?remote=http://localhost:17900&server=http://localhost:18787**

- The model's screen is the VM's kiosk. Every press (model, panel, keyboard, gamepad) goes to the VM.
- Hold the mic (red button, panel, or Space): your laptop mic goes to the VM, which records and transcribes it. The browser asks for the mic on the first hold.
- Under the model: RAM used of 2 GB, CPU, and each service, live.

Also:

- Studio: `/?studio=1&remote=http://localhost:17900`
- `http://localhost:17900`: the monitor on its own page.
- `http://localhost:15173/dock`: the Dock, served by the VM.
- PC agent: run `pnpm dev:pc` on the laptop; the tunnel lets the VM reach it.

## What to say

"The Device software, browser included, runs in a VM with a Pi 5's 2 GB and 4 arm64 cores. That's its real screen on the model, it hears me through its mic, and that's what it uses." Memory fit, not Pi speed: these cores are faster than a Pi's, and there is no Pi GPU.

## Look inside

```sh
gcloud compute ssh flip-pi --zone europe-west1-b
systemctl status 'flip-*'      journalctl -u flip-server -f      free -m
```

## Stop paying

```sh
gcloud compute instances stop flip-pi --zone europe-west1-b      # keeps the disk
gcloud compute instances delete flip-pi --zone europe-west1-b    # gone
```
