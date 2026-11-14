#!/usr/bin/env bash
# Runs on the VM as root (deploy.sh calls it). Idempotent.
# Turns a stock Debian 12 arm64 VM into the Device's board: 2 GB RAM, no swap, a kiosk browser
# showing the Device screen, the server, and a relay that streams the screen and the resource use.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
APP=/opt/flip

# --- Packages (first run only) ---
if ! command -v chromium >/dev/null || ! node -v 2>/dev/null | grep -q '^v22'; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs chromium xvfb pulseaudio fonts-inter fonts-noto-color-emoji
fi
command -v pulseaudio >/dev/null || apt-get install -y pulseaudio
corepack enable
corepack prepare pnpm@9.15.0 --activate >/dev/null
# The Device shows local time and plans "tomorrow morning" in it. TZ=... deploy.sh to change.
timedatectl set-timezone "${TZ_NAME:-Europe/Vilnius}"

# The UI asks for SF Pro / system-ui. On Linux, make that Inter.
mkdir -p /etc/fonts/conf.d
cat >/etc/fonts/conf.d/99-flip.conf <<'EOF'
<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <alias><family>system-ui</family><prefer><family>Inter</family></prefer></alias>
  <alias><family>sans-serif</family><prefer><family>Inter</family></prefer></alias>
</fontconfig>
EOF

# --- The code ---
id flip >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/flip --shell /usr/sbin/nologin flip
mkdir -p "$APP"
tar -xzf /tmp/flip.tgz -C "$APP"
[ -f /tmp/flip.env ] && install -m 600 -o flip /tmp/flip.env "$APP/.env"
chown -R flip:flip "$APP"
# Keys saved through /setup on the laptop (OpenRouter etc.). The laptop's state seeds a new VM only.
install -d -o flip -g flip /var/lib/flip/data
[ -f /tmp/flip-secrets.json ] && install -m 600 -o flip -g flip /tmp/flip-secrets.json /var/lib/flip/data/secrets.json
[ -f /tmp/flip-state.json ] && [ ! -f /var/lib/flip/data/state.json ] && install -m 600 -o flip -g flip /tmp/flip-state.json /var/lib/flip/data/state.json
rm -f /tmp/flip-secrets.json /tmp/flip.env
cd "$APP"
sudo -u flip -H pnpm install --filter device... --filter server... --no-frozen-lockfile
sudo -u flip -H pnpm --filter device build

# --- Services. Each is its own cgroup, so relay.mjs can measure each one. ---
mkdir -p /etc/flip
# Loaded after .env, so these win: the PC agent is this laptop, through the SSH tunnel (tunnel.sh).
cat >/etc/flip/vm.env <<'EOF'
PORT=8787
HOST=127.0.0.1
DATA_DIR=/var/lib/flip/data
HOSTING=vm
PC_AGENTS=This computer=ws://127.0.0.1:7077
EOF

unit() { cat >"/etc/systemd/system/$1.service"; }
unit flip-server <<EOF
[Unit]
Description=Flip server
After=network-online.target
[Service]
User=flip
WorkingDirectory=$APP/apps/server
EnvironmentFile=-$APP/.env
EnvironmentFile=/etc/flip/vm.env
ExecStart=/usr/bin/node --import tsx src/index.ts
Restart=always
[Install]
WantedBy=multi-user.target
EOF

unit flip-device <<EOF
[Unit]
Description=Flip Device app (static files + /ws pass-through)
[Service]
User=flip
Environment=ROOT=$APP/apps/device/dist PORT=5173 SERVER_URL=http://127.0.0.1:8787 NODE_OPTIONS=--max-old-space-size=96
ExecStart=/usr/bin/node $APP/docker/serve.mjs
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# The Device's screen: 784x504. On the real board this is the panel; here it is a virtual framebuffer.
unit flip-display <<EOF
[Unit]
Description=Flip screen (virtual framebuffer, 784x504)
[Service]
User=flip
ExecStart=/usr/bin/Xvfb :0 -screen 0 784x504x24 -nolisten tcp
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# The Device's microphone. On the board it is the mic on the lid; here it is a pipe the relay
# fills with the laptop's mic audio. Everything after it (recording, upload, Whisper) is the real path.
cat >/etc/flip/pulse.pa <<'EOF'
load-module module-native-protocol-unix socket=/run/flip-audio/pulse.sock auth-anonymous=1
load-module module-pipe-source source_name=lidmic file=/run/flip-audio/mic.fifo format=s16le rate=48000 channels=1
load-module module-null-sink sink_name=speaker
set-default-source lidmic
set-default-sink speaker
EOF
unit flip-audio <<EOF
[Unit]
Description=Flip microphone (PulseAudio with a pipe source)
[Service]
User=flip
RuntimeDirectory=flip-audio
RuntimeDirectoryPreserve=yes
Environment=HOME=/var/lib/flip XDG_RUNTIME_DIR=/run/flip-audio
ExecStart=/usr/bin/pulseaudio -n --daemonize=no --exit-idle-time=-1 --disallow-exit --use-pid-file=no --log-target=stderr -F /etc/flip/pulse.pa
Restart=always
[Install]
WantedBy=multi-user.target
EOF

# The kiosk browser. It records the mic above; mic permission is pre-granted, like on the board.
unit flip-kiosk <<EOF
[Unit]
Description=Flip kiosk browser
After=flip-display.service flip-device.service flip-audio.service
Requires=flip-display.service
[Service]
User=flip
Environment=DISPLAY=:0 PULSE_SERVER=unix:/run/flip-audio/pulse.sock
ExecStartPre=/bin/sleep 2
ExecStart=/usr/bin/chromium --kiosk --no-first-run --noerrdialogs --disable-infobars --disable-translate \\
  --window-position=0,0 --window-size=784,504 --user-data-dir=/var/lib/flip/kiosk \\
  --autoplay-policy=no-user-gesture-required --password-store=basic --use-fake-ui-for-media-stream \\
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \\
  "http://localhost:5173/?kiosk=1&voice=mic"
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
EOF

unit flip-relay <<EOF
[Unit]
Description=Flip screen relay and resource monitor
After=flip-kiosk.service flip-audio.service
[Service]
User=flip
Environment=MIC_FIFO=/run/flip-audio/mic.fifo
ExecStart=/usr/bin/node $APP/pi-vm/relay.mjs
Restart=always
[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable flip-server flip-device flip-display flip-audio flip-kiosk flip-relay
systemctl restart flip-server flip-device flip-display flip-audio flip-kiosk flip-relay

# --- Make the board a Pi 5 2 GB: the kernel sees 2 GB, and there is no swap ---
swapoff -a || true
sed -i '/\sswap\s/d' /etc/fstab
if ! grep -q 'mem=2G' /proc/cmdline; then
  mkdir -p /etc/default/grub.d
  echo 'GRUB_CMDLINE_LINUX_DEFAULT="$GRUB_CMDLINE_LINUX_DEFAULT mem=2G"' >/etc/default/grub.d/90-pi5-2gb.cfg
  update-grub
  echo "Rebooting once to clamp RAM to 2 GB. Re-run tunnel.sh in a minute."
  systemctl reboot
fi
free -m
