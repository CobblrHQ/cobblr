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
#   --docker   network-only Linux x64/arm64 bridge; USB needs the native service
#
# Linux (x64, arm64, 32-bit Raspberry Pi) and macOS. Nothing here listens on a
# port: the bridge dials out to Cobblr.
set -eu

COBBLR_URL="${COBBLR_URL:-@@COBBLR_URL@@}"

say() { printf '%s\n' "$*"; }
die() { printf 'cobblr bridge: %s\n' "$*" >&2; exit 1; }

INSTALL_OS=${COBBLR_INSTALL_OS:-$(uname -s)}
INSTALL_ARCH=${COBBLR_INSTALL_ARCH:-$(uname -m)}
NATIVE_DEFAULT=0
[ "$INSTALL_OS" != Darwin ] || NATIVE_DEFAULT=1
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
case "$INSTALL_OS" in Linux) DOWNLOAD_OS=linux ;; Darwin) DOWNLOAD_OS=darwin ;; *) die "use the Windows PowerShell installer on Windows" ;; esac
case "$INSTALL_ARCH" in
  x86_64|amd64) DOWNLOAD_ARCH=x64 ;;
  aarch64|arm64) DOWNLOAD_ARCH=arm64 ;;
  armv7l|armhf) [ "$INSTALL_OS" = Linux ] || die "armv7 needs Linux"; DOWNLOAD_ARCH=armv7 ;;
  *) die "unsupported bridge architecture $INSTALL_ARCH" ;;
esac
DOWNLOAD_URL="$COBBLR_URL/api/v1/desktop/bridge/$DOWNLOAD_OS/$DOWNLOAD_ARCH"
if [ "$DOCKER" = 1 ]; then
  [ "$INSTALL_OS" = Linux ] && [ "$DOWNLOAD_ARCH" != armv7 ] || die "Docker needs Linux x64 or arm64. Use the native installer for this computer."
fi
if [ "$DRY_RUN" = 1 ] && [ "$MAC_NATIVE" = 0 ]; then
  say "$DOWNLOAD_URL"
  if [ "$DOCKER" = 1 ]; then say "Network-only Docker bridge. USB needs the native installer."; else say "Complete USB runtime; starts as a systemd service. No pairing or download in dry run."; fi
  exit 0
fi
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

fetch() { # fetch URL -> stdout
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$1"
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
    say "$DOWNLOAD_URL"
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
  umask 077
  DOCKER_ENV="$HOME/.config/cobblr-bridge-docker.env"
  mkdir -p "$(dirname "$DOCKER_ENV")"
  {
    echo "BRIDGE_MODE=tunnel"
    echo "BRIDGE_NETWORK_ONLY=true"
    echo "BRIDGE_RELAY_URL=$RELAY_URL"
    echo "BRIDGE_RELAY_TOKEN=$TOKEN"
    echo "BRIDGE_ID=$BRIDGE_ID"
    echo "BRIDGE_DOWNLOAD_URL=$DOWNLOAD_URL"
    echo "BRIDGE_CACHE_DIR=/data/cache"
  } > "$DOCKER_ENV"
  docker rm -fv cobblr-edge-bridge >/dev/null 2>&1 || true
  docker run -d --name cobblr-edge-bridge --restart unless-stopped \
    --network host --hostname "$HOST_NAME" --env-file "$DOCKER_ENV" \
    -v cobblr-bridge-data:/data -w /data node:22-bookworm-slim \
    sh -c 'node -e "const fs=require(\"node:fs\");fetch(process.env.BRIDGE_DOWNLOAD_URL).then(async r=>{if(!r.ok)throw Error(\"Bridge download unavailable\");const b=Buffer.from(await r.arrayBuffer());if(!b.length)throw Error(\"Empty bridge download\");fs.writeFileSync(\"/data/cobblr-bridge.tmp\",b,{mode:0o700});fs.renameSync(\"/data/cobblr-bridge.tmp\",\"/data/cobblr-bridge\")}).catch(()=>process.exit(1))" || test -x /data/cobblr-bridge; exec /data/cobblr-bridge' >/dev/null
  say "Done. $NAME is starting as a network-only Docker bridge. USB machines need the native installer."
  exit 0
fi

serial_group() {
  for device in /dev/ttyUSB0 /dev/ttyACM0 /dev/ttyS0 /dev/ttyAMA0; do
    if [ -e "$device" ]; then
      group=$(stat -c %G "$device")
      case "$group" in dialout|uucp) printf '%s\n' "$group"; return ;; esac
    fi
  done
  for group in dialout uucp; do
    getent group "$group" >/dev/null 2>&1 && { printf '%s\n' "$group"; return; }
  done
  printf '%s\n' dialout
}
existing_groups() {
  groups=""
  for group in "$@"; do
    getent group "$group" >/dev/null 2>&1 && groups="$groups $group"
  done
  printf '%s\n' "${groups# }"
}
setup_device_access() {
  SERIAL_GROUP=$(serial_group)
  if [ "$(id -u)" = 0 ]; then PRIV="";
  elif command -v sudo >/dev/null 2>&1; then PRIV=sudo;
  else die "USB access needs an administrator. Install sudo or ask an administrator to run the system installer."; fi
  $PRIV groupadd -f cobblr-usb
  getent group "$SERIAL_GROUP" >/dev/null 2>&1 || $PRIV groupadd "$SERIAL_GROUP"
  if [ "$SYSTEM" = 1 ]; then
    getent passwd cobblr-bridge >/dev/null 2>&1 || $PRIV useradd --system --home-dir "$HOME_DIR" --no-create-home --shell /usr/sbin/nologin --user-group cobblr-bridge
    DEVICE_USER=cobblr-bridge
  else DEVICE_USER=$(id -un); fi
  DEVICE_GROUPS=$(existing_groups "$SERIAL_GROUP" cobblr-usb bluetooth)
  $PRIV usermod -aG "$(printf '%s' "$DEVICE_GROUPS" | tr ' ' ',')" "$DEVICE_USER"
  RULES=$(mktemp)
  cat > "$RULES" <<'RULES'
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="9588", ATTR{idProduct}=="9899", MODE="0660", GROUP="cobblr-usb", TAG+="uaccess"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ATTR{idVendor}=="0b4d", MODE="0660", GROUP="cobblr-usb", TAG+="uaccess"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", IMPORT{builtin}="usb_id"
SUBSYSTEM=="usb", ENV{DEVTYPE}=="usb_device", ENV{ID_USB_INTERFACES}=="*:fe03??:*", MODE="0660", GROUP="cobblr-usb", TAG+="uaccess"
RULES
  $PRIV install -D -m 0644 "$RULES" /etc/udev/rules.d/60-cobblr-bridge.rules
  rm -f "$RULES"
  if command -v udevadm >/dev/null 2>&1; then
    $PRIV udevadm control --reload
    $PRIV udevadm trigger --subsystem-match=usb
  fi
  [ "$SYSTEM" = 1 ] || say "Log out and back in, or reboot, so the bridge picks up its USB and serial groups."
}

# ── 2. Where it lives ───────────────────────────────────────────────────────
OS=$INSTALL_OS
if [ "$SYSTEM" = "1" ]; then
  [ "$(id -u)" = "0" ] || die "--system needs root: run it with sudo, or leave --system off"
  HOME_DIR=/opt/cobblr-bridge; ENV_FILE=/etc/cobblr-bridge.env
else
  HOME_DIR="$HOME/.local/share/cobblr-bridge"; ENV_FILE="$HOME/.config/cobblr-bridge.env"
fi
mkdir -p "$HOME_DIR/cache" "$(dirname "$ENV_FILE")"
[ "$OS" != Linux ] || setup_device_access
if [ "$SYSTEM" = 1 ]; then chmod 0755 "$HOME_DIR"; chown -R cobblr-bridge:cobblr-bridge "$HOME_DIR/cache"; fi

# ── 3. A complete runtime, including native USB access ─────────────────────
umask 077
BRIDGE="$HOME_DIR/cobblr-bridge"
if [ "$DOWNLOAD_ARCH" = armv7 ]; then
  fetch "$DOWNLOAD_URL" > "$HOME_DIR/runtime.tar.gz.tmp" || die "the ARMv7 bridge download is unavailable"
  mkdir -p "$HOME_DIR/runtime.new"
  tar -xzf "$HOME_DIR/runtime.tar.gz.tmp" -C "$HOME_DIR/runtime.new" || die "the ARMv7 bridge archive is invalid"
  [ -x "$HOME_DIR/runtime.new/cobblr-bridge" ] && [ -s "$HOME_DIR/runtime.new/native/usb.node" ] || die "the bridge archive is incomplete"
  rm -rf "$HOME_DIR/runtime.previous"
  [ ! -d "$HOME_DIR/runtime" ] || mv "$HOME_DIR/runtime" "$HOME_DIR/runtime.previous"
  mv "$HOME_DIR/runtime.new" "$HOME_DIR/runtime"
  rm -f "$HOME_DIR/runtime.tar.gz.tmp"
  chmod -R u+rwX,go+rX,go-w "$HOME_DIR/runtime"
  BRIDGE="$HOME_DIR/runtime/cobblr-bridge"
  "$HOME_DIR/runtime/bin/node" --version >/dev/null 2>&1 || die "The ARMv7 runtime cannot start. On Raspberry Pi OS, install libatomic1 and try again."
else
  fetch "$DOWNLOAD_URL" > "$BRIDGE.tmp" || die "the bridge download is unavailable"
  [ -s "$BRIDGE.tmp" ] || die "the bridge download was empty"
  chmod 0755 "$BRIDGE.tmp"
  mv "$BRIDGE.tmp" "$BRIDGE"
fi
"$BRIDGE" --licenses >/dev/null || die "the bridge runtime cannot start. On Raspberry Pi OS, install libatomic1 and try again."

umask 077
{
  echo "BRIDGE_MODE=tunnel"
  echo "BRIDGE_RELAY_URL=$RELAY_URL"
  echo "BRIDGE_RELAY_TOKEN=$TOKEN"
  [ -n "$BRIDGE_ID" ] && echo "BRIDGE_ID=$BRIDGE_ID"
  echo "BRIDGE_CACHE_DIR=$HOME_DIR/cache"
  echo "BRIDGE_HOST_NAME=$HOST_NAME"
} > "$ENV_FILE"
chmod 0600 "$ENV_FILE"
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
    echo "<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>set -a; . '$ENV_FILE'; exec '$BRIDGE'</string></array>"
    echo "<key>WorkingDirectory</key><string>$HOME_DIR</string>"
    echo '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>'
    echo "<key>StandardErrorPath</key><string>$HOME_DIR/bridge.log</string>"
    echo '</dict></plist>'
  } > "$PLIST"
  launchctl unload "$PLIST" >/dev/null 2>&1 || true
  launchctl load "$PLIST"
  LOGS="tail -f $HOME_DIR/bridge.log"
elif command -v systemctl >/dev/null 2>&1; then
  RUN_AS=""
  if [ "$SYSTEM" = 1 ]; then
    RUN_AS="User=cobblr-bridge
Group=cobblr-bridge
SupplementaryGroups=$DEVICE_GROUPS
NoNewPrivileges=true"
  fi
  UNIT="[Unit]
Description=Cobblr edge bridge
After=network-online.target
Wants=network-online.target

[Service]
$RUN_AS
EnvironmentFile=$ENV_FILE
WorkingDirectory=$HOME_DIR
ExecStart="$BRIDGE"
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
  [ "$SYSTEM" = 0 ] || die "--system needs systemd to run the bridge as its dedicated user"
  # No service manager (a container, a minimal image): run it in the background.
  ( set -a; . "$ENV_FILE"; cd "$HOME_DIR"; nohup "$BRIDGE" > "$HOME_DIR/bridge.log" 2>&1 & )
  LOGS="tail -f $HOME_DIR/bridge.log"
fi

# Only say it is running once it is: the loader prints this line when the
# bridge starts, and a bridge that died at once would otherwise read as done.
started=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if [ -f "$HOME_DIR/bridge.log" ] && grep -q '\[loader\] running .*bridge' "$HOME_DIR/bridge.log" 2>/dev/null; then started=1; break; fi
  if command -v systemctl >/dev/null 2>&1 && [ "$OS" != "Darwin" ]; then
    if [ "$SYSTEM" = "1" ]; then j="journalctl -u cobblr-bridge"; else j="journalctl --user -u cobblr-bridge"; fi
    $j --no-pager -n 50 2>/dev/null | grep -q '\[loader\] running .*bridge' && { started=1; break; }
  fi
  sleep 2
done
if [ "$started" != "1" ]; then
  die "the bridge was installed but has not started after a minute. See: $LOGS"
fi

say ""
say "Done. \"$NAME\" is running on $HOST_NAME and shows as online in Cobblr within a minute."
say "Logs: $LOGS"
