#!/bin/sh
# Install a Cobblr edge bridge on this machine with a pairing code.
#
#   curl -fsSL @@COBBLR_URL@@/api/v1/edge/install.sh | sh -s -- ABCD-2345
#
# Cobblr shows the code under Configuration > Devices. It works once, for
# fifteen minutes. This script trades it for the bridge's own token (which
# stays on this machine), puts Node and the self-updating bridge loader in
# place, and starts the bridge as a service that comes back after a reboot.
#
# Options (after the code):
#   --system   install for the whole machine (needs root); default is this user
#   --docker   run the bridge in Docker instead of as a service
#
# Linux (x64, arm64, 32-bit Raspberry Pi) and macOS. Nothing here listens on a
# port: the bridge dials out to Cobblr.
set -eu

COBBLR_URL="${COBBLR_URL:-@@COBBLR_URL@@}"
NODE_VERSION="${COBBLR_NODE_VERSION:-22.20.0}"

say() { printf '%s\n' "$*"; }
die() { printf 'cobblr bridge: %s\n' "$*" >&2; exit 1; }

NATIVE_DEFAULT=0
CODE=""; SYSTEM=0; DOCKER=0; MAC_NATIVE=${COBBLR_MAC_NATIVE:-$NATIVE_DEFAULT}; DRY_RUN=0
for a in "$@"; do
  case "$a" in
    --mac-native) MAC_NATIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --system) SYSTEM=1 ;;
    --docker) DOCKER=1 ;;
    -*) die "unknown option $a" ;;
    *) CODE="$a" ;;
  esac
done
MAC_HOME="$HOME/Library/Application Support/Cobblr/bridge"
MAC_PLIST="$HOME/Library/LaunchAgents/xyz.cobblr.edge-bridge.plist"
if [ "$MAC_NATIVE" = 1 ]; then
  [ "${COBBLR_INSTALL_OS:-$(uname -s)}" = Darwin ] || die "this installer needs macOS"
  [ "$SYSTEM" = 0 ] && [ "$DOCKER" = 0 ] || die "the Mac bridge runs as your user"
  case "${COBBLR_INSTALL_ARCH:-$(uname -m)}" in
    arm64) MAC_ARCH=arm64 ;; x86_64) MAC_ARCH=x64 ;; *) die "unsupported Mac architecture" ;;
  esac
  if [ "$CODE" = uninstall ]; then
    launchctl bootout "gui/$(id -u)" "$MAC_PLIST" 2>/dev/null || true
    rm -f "$MAC_PLIST"
    rm -rf "$MAC_HOME"
    say "Bridge removed. Disconnect it in Cobblr to revoke its key. LightBurn pairing is retained."
    exit 0
  fi

fi
[ -n "$CODE" ] || die "give the pairing code Cobblr shows you, e.g.: sh -s -- ABCD-2345"

fetch() { # fetch URL [BEARER] -> stdout
  if command -v curl >/dev/null 2>&1; then
    if [ -n "${2:-}" ]; then curl -fsSL -H "Authorization: Bearer $2" "$1"; else curl -fsSL "$1"; fi
  elif command -v wget >/dev/null 2>&1; then
    if [ -n "${2:-}" ]; then wget -qO- --header="Authorization: Bearer $2" "$1"; else wget -qO- "$1"; fi
  else die "this machine has neither curl nor wget"; fi
}

json_field() { # json_field NAME < json  (flat string fields only)
  sed -n 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1
}

# ── 1. The code becomes this bridge's token ─────────────────────────────────
if [ "$DRY_RUN" = 1 ] && [ "$MAC_NATIVE" = 1 ]; then
  TOKEN=dry-run-key; RELAY_PATH=/api/v1/orgs/dry-run/edge; NAME="Dry run"; BRIDGE_ID=dry-run
else
say "Pairing with $COBBLR_URL ..."
if command -v curl >/dev/null 2>&1; then
  RESP=$(curl -sS -X POST -H 'content-type: application/json' \
    -d "{\"code\":\"$CODE\"}" -w '\n%{http_code}' "$COBBLR_URL/api/v1/edge/pair") || die "could not reach $COBBLR_URL"
else
  RESP=$(wget -qO- --header='content-type: application/json' \
    --post-data "{\"code\":\"$CODE\"}" "$COBBLR_URL/api/v1/edge/pair" 2>&1; printf '\n200') || die "could not reach $COBBLR_URL, or the code was refused"
fi
STATUS=$(printf '%s' "$RESP" | tail -n 1)
BODY=$(printf '%s' "$RESP" | sed '$d')
if [ "$STATUS" != "200" ]; then
  MSG=$(printf '%s' "$BODY" | json_field message)
  die "${MSG:-pairing failed ($STATUS)}"
fi
TOKEN=$(printf '%s' "$BODY" | json_field token)
RELAY_PATH=$(printf '%s' "$BODY" | json_field relay_path)
NAME=$(printf '%s' "$BODY" | json_field name)
BRIDGE_ID=$(printf '%s' "$BODY" | json_field bridge)
[ -n "$TOKEN" ] && [ -n "$RELAY_PATH" ] || die "Cobblr answered, but not with a bridge token"
fi
RELAY_URL="$COBBLR_URL$RELAY_PATH"
HOST_NAME=$(hostname 2>/dev/null || uname -n)
say "Paired as \"$NAME\"."

if [ "$MAC_NATIVE" = 1 ]; then
  umask 077
  mkdir -p "$MAC_HOME/cache" "$(dirname "$MAC_PLIST")"
  if [ "$DRY_RUN" = 0 ]; then
  fetch "$COBBLR_URL/api/v1/desktop/bridge/darwin/$MAC_ARCH" > "$MAC_HOME/cobblr-edge-bridge.tmp" || die "the Mac binary is unavailable; ask the operator to publish bridge downloads"
  [ -s "$MAC_HOME/cobblr-edge-bridge.tmp" ] || die "the Mac binary was empty"
  chmod 700 "$MAC_HOME/cobblr-edge-bridge.tmp"
  mv "$MAC_HOME/cobblr-edge-bridge.tmp" "$MAC_HOME/cobblr-edge-bridge"
  xattr -d com.apple.quarantine "$MAC_HOME/cobblr-edge-bridge" 2>/dev/null || true
  fi
  xml() { printf '%s' "$1" | sed 's/\&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
  {
    echo '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>'
    echo '<key>Label</key><string>xyz.cobblr.edge-bridge</string>'
    printf '<key>ProgramArguments</key><array><string>%s/cobblr-edge-bridge</string></array>\n' "$(xml "$MAC_HOME")"
    echo '<key>EnvironmentVariables</key><dict>'
    for key in BRIDGE_MODE BRIDGE_RELAY_URL BRIDGE_RELAY_TOKEN BRIDGE_ID BRIDGE_CACHE_DIR BRIDGE_HOST_NAME; do
      case "$key" in
        BRIDGE_MODE) value=tunnel ;; BRIDGE_RELAY_URL) value=$RELAY_URL ;; BRIDGE_RELAY_TOKEN) value=$TOKEN ;;
        BRIDGE_ID) value=$BRIDGE_ID ;; BRIDGE_CACHE_DIR) value=$MAC_HOME/cache ;; BRIDGE_HOST_NAME) value=$HOST_NAME ;;
      esac
      printf '<key>%s</key><string>%s</string>\n' "$key" "$(xml "$value")"
    done
    echo '</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
    printf '<key>StandardErrorPath</key><string>%s/bridge.log</string>\n' "$(xml "$MAC_HOME")"
    echo '</dict></plist>'
  } > "$MAC_PLIST"
  chmod 600 "$MAC_PLIST"
  if [ "$DRY_RUN" = 1 ]; then
    say "cobblr-bridge-darwin-$MAC_ARCH: $MAC_HOME/cobblr-edge-bridge"
    say "$MAC_PLIST"
    cat "$MAC_PLIST"
    exit 0
  fi
  launchctl bootout "gui/$(id -u)" "$MAC_PLIST" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$MAC_PLIST" || die "launchd could not start the bridge; check $MAC_HOME/bridge.log"
  say "Bridge installed. Wait for online in Cobblr. Logs: $MAC_HOME/bridge.log"
  say "Pair LightBurn: \"$MAC_HOME/cobblr-edge-bridge\" pair-lightburn 127.0.0.1"
  exit 0
fi

# ── Docker, when asked for ──────────────────────────────────────────────────
if [ "$DOCKER" = "1" ]; then
  command -v docker >/dev/null 2>&1 || die "--docker was given but docker is not installed"
  docker rm -f cobblr-edge-bridge >/dev/null 2>&1 || true  # keeps-volumes: its state is the named cobblr-bridge-data volume
  # shellcheck disable=SC2016 # the $ is for the container's shell
  docker run -d --name cobblr-edge-bridge --restart unless-stopped \
    --hostname "$HOST_NAME" \
    -v cobblr-bridge-data:/data -w /data \
    -e BRIDGE_MODE=tunnel \
    -e BRIDGE_RELAY_URL="$RELAY_URL" \
    -e BRIDGE_RELAY_TOKEN="$TOKEN" \
    ${BRIDGE_ID:+-e BRIDGE_ID="$BRIDGE_ID"} \
    node:22-alpine \
    sh -c 'wget -qO loader.mjs --header "Authorization: Bearer $BRIDGE_RELAY_TOKEN" "$BRIDGE_RELAY_URL/release/loader" || true; node loader.mjs' >/dev/null
  say "Done. \"$NAME\" is starting in Docker and shows as online in Cobblr within a minute."
  exit 0
fi

# ── 2. Where it lives ───────────────────────────────────────────────────────
OS=$(uname -s)
if [ "$SYSTEM" = "1" ]; then
  [ "$(id -u)" = "0" ] || die "--system needs root: run it with sudo, or leave --system off"
  HOME_DIR=/opt/cobblr-bridge; ENV_FILE=/etc/cobblr-bridge.env
else
  HOME_DIR="$HOME/.local/share/cobblr-bridge"; ENV_FILE="$HOME/.config/cobblr-bridge.env"
fi
mkdir -p "$HOME_DIR/cache" "$(dirname "$ENV_FILE")"

# ── 3. Node: the one on this machine if it is new enough, else our own ──────
NODE=""
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] 2>/dev/null && NODE=$(command -v node)
fi
if [ -z "$NODE" ]; then
  case "$OS" in Linux) nos=linux ;; Darwin) nos=darwin ;; *) die "no bridge install for $OS; use --docker" ;; esac
  case "$(uname -m)" in
    x86_64|amd64) narch=x64; base=https://nodejs.org/dist ;;
    aarch64|arm64) narch=arm64; base=https://nodejs.org/dist ;;
    armv7l|armhf) narch=armv7l; base=https://nodejs.org/dist ;;
    # A Pi Zero or Pi 1: nodejs.org stopped building ARMv6, its unofficial
    # builds carry on. The bridge runs there at about 50 MB.
    armv6l) narch=armv6l; base=https://unofficial-builds.nodejs.org/download/release ;;
    *) die "no Node build for $(uname -m); use --docker" ;;
  esac
  say "Fetching Node $NODE_VERSION for $nos-$narch ..."
  mkdir -p "$HOME_DIR/node"
  fetch "$base/v$NODE_VERSION/node-v$NODE_VERSION-$nos-$narch.tar.gz" | tar -xz -C "$HOME_DIR/node" --strip-components=1 \
    || die "could not download Node for $nos-$narch"
  NODE="$HOME_DIR/node/bin/node"
fi

# Node's ARM builds need libatomic, which a minimal Debian or Pi OS image can
# lack; without it Node cannot start at all. Put it in when we can, and say
# exactly what to run when we cannot, rather than install a bridge that never
# runs.
if ! "$NODE" -v >/dev/null 2>&1; then
  if "$NODE" -v 2>&1 | grep -q libatomic; then
    if command -v apt-get >/dev/null 2>&1; then
      AS=""; [ "$(id -u)" = "0" ] || AS="sudo"
      say "Installing libatomic1, which Node needs on this machine ..."
      $AS apt-get install -y -qq libatomic1 >/dev/null 2>&1 || true
    fi
  fi
  "$NODE" -v >/dev/null 2>&1 || die "Node cannot start here: $("$NODE" -v 2>&1 | head -n 1). On Debian or Raspberry Pi OS, run 'sudo apt-get install libatomic1' and run this again with a new code."
fi

# ── 4. The loader, from this Cobblr, with this bridge's token ───────────────
fetch "$RELAY_URL/release/loader" "$TOKEN" > "$HOME_DIR/loader.mjs.tmp" \
  || die "could not download the bridge from $COBBLR_URL"
mv "$HOME_DIR/loader.mjs.tmp" "$HOME_DIR/loader.mjs"

umask 077
{
  echo "BRIDGE_MODE=tunnel"
  echo "BRIDGE_RELAY_URL=$RELAY_URL"
  echo "BRIDGE_RELAY_TOKEN=$TOKEN"
  [ -n "$BRIDGE_ID" ] && echo "BRIDGE_ID=$BRIDGE_ID"
  echo "BRIDGE_CACHE_DIR=$HOME_DIR/cache"
  echo "BRIDGE_HOST_NAME=$HOST_NAME"
} > "$ENV_FILE"
umask 022

# ── 5. A service that restarts it (the loader exits to apply an update) ─────
if [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/xyz.cobblr.bridge.plist"
  [ "$SYSTEM" = "1" ] && PLIST=/Library/LaunchDaemons/xyz.cobblr.bridge.plist
  mkdir -p "$(dirname "$PLIST")"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo '<key>Label</key><string>xyz.cobblr.bridge</string>'
    echo "<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>set -a; . '$ENV_FILE'; exec '$NODE' '$HOME_DIR/loader.mjs'</string></array>"
    echo "<key>WorkingDirectory</key><string>$HOME_DIR</string>"
    echo '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
    echo "<key>StandardErrorPath</key><string>$HOME_DIR/bridge.log</string>"
    echo '</dict></plist>'
  } > "$PLIST"
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  LOGS="tail -f $HOME_DIR/bridge.log"
elif command -v systemctl >/dev/null 2>&1; then
  UNIT="[Unit]
Description=Cobblr edge bridge
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
WorkingDirectory=$HOME_DIR
ExecStart=$NODE $HOME_DIR/loader.mjs
Restart=always
RestartSec=5
"
  if [ "$SYSTEM" = "1" ]; then
    printf '%s\n[Install]\nWantedBy=multi-user.target\n' "$UNIT" > /etc/systemd/system/cobblr-bridge.service
    systemctl daemon-reload
    systemctl enable --now cobblr-bridge.service >/dev/null
    systemctl restart cobblr-bridge.service
    LOGS="journalctl -u cobblr-bridge -f"
  else
    mkdir -p "$HOME/.config/systemd/user"
    printf '%s\n[Install]\nWantedBy=default.target\n' "$UNIT" > "$HOME/.config/systemd/user/cobblr-bridge.service"
    systemctl --user daemon-reload
    systemctl --user enable --now cobblr-bridge.service >/dev/null
    systemctl --user restart cobblr-bridge.service
    # Keep it running when nobody is logged in, and start it at boot.
    loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || say "Note: run 'sudo loginctl enable-linger $(id -un)' so the bridge starts at boot without a login."
    LOGS="journalctl --user -u cobblr-bridge -f"
  fi
else
  # No service manager (a container, a minimal image): run it in the background.
  ( set -a; . "$ENV_FILE"; cd "$HOME_DIR"; nohup "$NODE" "$HOME_DIR/loader.mjs" > "$HOME_DIR/bridge.log" 2>&1 & )
  LOGS="tail -f $HOME_DIR/bridge.log"
fi

# Only say it is running once it is: the loader prints this line when the
# bridge starts, and a bridge that died at once would otherwise read as done.
started=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if [ -f "$HOME_DIR/bridge.log" ] && grep -q '\[loader\] running bridge' "$HOME_DIR/bridge.log" 2>/dev/null; then started=1; break; fi
  if command -v systemctl >/dev/null 2>&1 && [ "$OS" != "Darwin" ]; then
    if [ "$SYSTEM" = "1" ]; then j="journalctl -u cobblr-bridge"; else j="journalctl --user -u cobblr-bridge"; fi
    $j --no-pager -n 50 2>/dev/null | grep -q '\[loader\] running bridge' && { started=1; break; }
  fi
  sleep 2
done
if [ "$started" != "1" ]; then
  die "the bridge was installed but has not started after a minute. See: $LOGS"
fi

say ""
say "Done. \"$NAME\" is running on $HOST_NAME and shows as online in Cobblr within a minute."
say "Logs: $LOGS"
