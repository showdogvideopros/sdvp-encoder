#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
#  SDVP ENCODE BOX — PROVISIONING SCRIPT
#  Target: Vultr CPU-Optimized, Ubuntu 24.04 LTS, Dallas
#  Plan:   voc-c-32c-64gb-500s  ($640.00/mo · $0.952/hr)
#          Billing caps at 672 hr/mo, so $0.952 x 672 = $640.00 flat.
#          Predecessor was voc-c-16c-32gb-300s ($320.00/mo · $0.476/hr).
#
#  USAGE:  ./build.sh [hostname]        default: enc
#          Run it from inside an already-cloned /root/build.
#          The app requires its own modules by ABSOLUTE path, so the
#          clone MUST live at /root/build and nowhere else.
#
#  THE BOX IS FURNITURE. THIS FILE IS THE PRODUCT.
#  Any hand change on a running instance must be mirrored here
#  in the same session, or it is lost at teardown.
#
#  Sections are individually guarded and safe to re-run.
# ─────────────────────────────────────────────────────────────
set -euo pipefail

# The canonical box is 'enc'. Pass a name to build a second one alongside
# it (enc2 was built 2026-08-31 while enc was still serving).
BOX="${1:-enc}"

log() { printf '\n\033[1;33m── %s ──\033[0m\n' "$*"; }

# ═════════ 00 · BASE ═════════
log "00 BASE"
hostnamectl set-hostname "$BOX"
timedatectl set-timezone UTC          # server stays UTC; convert for conversation
apt-get update
apt-get -y upgrade
apt-get -y install curl ca-certificates gnupg jq rsync tmux htop \
                   unzip xz-utils bc python3-pip git

# ═════════ 01 · SSH — KEY ONLY ═════════
# ⛔ GATE: refuse to disable passwords if no key can log in.
log "01 SSH HARDENING"
if [ ! -s /root/.ssh/authorized_keys ]; then
  echo "REFUSED: /root/.ssh/authorized_keys is missing or empty."
  echo "Install a public key before running this section, or you will be locked out."
  exit 1
fi
cat > /etc/ssh/sshd_config.d/10-sdvp-hardening.conf << 'EOF'
# Sorts before 50-cloud-init.conf. sshd takes the FIRST value for these
# keywords, so this wins over cloud-init's file without modifying it.
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
EOF
chmod 600 /etc/ssh/sshd_config.d/10-sdvp-hardening.conf
sshd -t && systemctl reload ssh       # -t refuses to reload an unparseable config

# ═════════ 02 · TAILSCALE ═════════
log "02 TAILSCALE"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
systemctl enable --now tailscaled
# Interactive on a fresh box — prints a URL to approve in the browser.
# Deliberately NOT using --ssh: one authentication path, not two.
tailscale status >/dev/null 2>&1 || tailscale up --hostname="$BOX"

# ═════════ 03 · FIREWALL ═════════
# ⛔ ORDER MATTERS: add the tailnet rule BEFORE removing the public one.
log "03 UFW"
ufw allow in on tailscale0 to any port 22 proto tcp comment 'SSH over tailnet'
ufw --force enable
ufw delete allow 22/tcp        2>/dev/null || true
ufw delete allow 22/tcp/v6     2>/dev/null || true

# ═════════ 04 · FFMPEG — PINNED STATIC BUILD ═════════
# NOT the distro package: Ubuntu 24.04 ships 6.1.1, three majors behind, and it
# moves on any unattended upgrade. Preset behaviour and encoder efficiency shift
# between versions; a backlog half-encoded by two different ffmpegs carries no
# marker saying so. Static, so no library upgrade can break it later.
# ⚠ "-latest" means the asset is replaced in place. Pinned to the 9.0 BRANCH,
#   not to bytes. Hashes below are what THIS box got 2026-08-17.
log "04 FFMPEG"
FFASSET=ffmpeg-n9.0-latest-linux64-gpl-9.0.tar.xz
FFURL=https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$FFASSET
# Installed here 2026-08-17:  n9.0.1-4-gb3ef323dd2-20260817
#   ffmpeg  md5 f6b92bd5613ba985737938182ff93cb8   (145856392 bytes)
#   ffprobe md5 1a67d2f3c9d7596fb2fcf0638f4e03fb   (145643400 bytes)
#   archive sha256 c48efa3c37bcafc4c243d5d252fbe941d0dbb9949bf6baac5cca9ac41ae1974a
if ! /usr/local/bin/ffmpeg -version >/dev/null 2>&1; then
  mkdir -p /root/build/ffmpeg-src && cd /root/build/ffmpeg-src
  curl -fL --retry 3 -o "$FFASSET" "$FFURL"
  tar -tJf "$FFASSET" >/dev/null || { echo "ABORT: archive corrupt"; exit 1; }
  tar -xJf "$FFASSET"
  install -m 755 -o root -g root ffmpeg-n9.0-*/bin/ffmpeg \
                                 ffmpeg-n9.0-*/bin/ffprobe \
                                 ffmpeg-n9.0-*/bin/ffplay /usr/local/bin/
fi
# ⛔ GATE: both encoders must ENCODE, not merely appear in -encoders.
#    A binary can list an encoder and fail at runtime. Only an encode catches it.
cd /tmp
ffmpeg -hide_banner -loglevel error -y -f lavfi \
  -i testsrc2=size=640x360:rate=30:duration=1 -c:v libx264 -crf 30 g264.mp4
ffmpeg -hide_banner -loglevel error -y -f lavfi \
  -i testsrc2=size=640x360:rate=30:duration=1 -c:v libx265 -crf 30 g265.mp4
G264=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 g264.mp4)
G265=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 g265.mp4)
/usr/bin/rm -f g264.mp4 g265.mp4
if [ "$G264" != "h264" ] || [ "$G265" != "hevc" ]; then
  echo "REFUSED: encoder gate failed. h264=$G264 hevc=$G265"; exit 1
fi
echo "ffmpeg gate PASSED — $(ffmpeg -version 2>&1 | head -1)"

# ═════════ 05 · NODE — 22 LTS ═════════
# LTS, not current. One long-lived daemon for months; boring is correct.
log "05 NODE"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'console.log("node", process.version, "cpus:", require("os").cpus().length)'

# ═════════ 06 · APP LAYOUT ═════════
# Run from INSIDE the clone. Asserted, not assumed: every internal require in
# this app is an ABSOLUTE path (/root/build/lib/...), so a clone anywhere else
# produces a daemon that dies on its first require.
log "06 APP LAYOUT"
if [ ! -f /root/build/bin/daemon.js ] || [ ! -f /root/build/lib/orchestrator.js ]; then
  echo "REFUSED: not running from a clone at /root/build."
  echo "  git clone git@github.com:showdogvideopros/sdvp-encoder.git /root/build"
  exit 1
fi

# 'held' has NO creator anywhere in the codebase - daemon.js reads from it but
# nothing makes it. [MEASURED 2026-08-31: five mkdirSync calls, none for held.]
# The others are created at runtime; made here so a fresh box is complete.
install -d -m 700 /var/lib/sdvp-encoder
install -d -m 755 /var/lib/sdvp-encoder/scratch \
                  /var/lib/sdvp-encoder/sheets \
                  /var/lib/sdvp-encoder/jobs \
                  /var/lib/sdvp-encoder/held

# Credentials are section 07. This makes the directory, never its contents.
install -d -m 700 /root/config

cat > /etc/systemd/system/sdvp-encoder.service << 'UNITEOF'
[Unit]
Description=SDVP Encoder daemon
After=network-online.target tailscaled.service

[Service]
Type=simple
WorkingDirectory=/root/build
EnvironmentFile=/root/config/encoder.env
Environment=ENCODER_PORT=8099
ExecStart=/usr/bin/node /root/build/bin/daemon.js
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
# ENABLED, NOT STARTED. Without /root/config/encoder.env the daemon has no
# pCloud or Vimeo credentials, and without record.db the run pricing falls
# back to defaults that make the estimate meaningless. Start it in 07.
systemctl enable sdvp-encoder.service
echo "06 done - unit enabled, NOT started. Credentials and record.db next."
# ═════════ 07 · CREDENTIALS   — pending (never stored in this file) ═════════

log "BUILD COMPLETE"
