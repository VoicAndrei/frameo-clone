#!/usr/bin/env bash
#
# install-watchdog.sh - install the Tailscale watchdog on a photo-frame tablet
# from a macOS or Linux computer, over adb. Run this from server/tablet/.
# The tablet must already be provisioned as a frame (see docs/TABLET.md).
#
#   ./install-watchdog.sh --frame-id frame-a --token <authToken>
#
# It is idempotent: re-running it upgrades the script and the config in place and
# restarts the watchdog. It never touches FreeKiosk's own configuration, never
# uninstalls anything, and never reboots the tablet unless you ask with --reboot.
#
# What it does, in order:
#   1. check adb + exactly one device
#   2. download Termux and Termux:Boot from F-Droid (skipped if already present)
#   3. install them (only if missing - never reinstalls over your data)
#   4. push the watchdog + boot launcher into Termux's private storage
#   5. write ~/.frameo/watchdog.env with the identity you passed
#   6. grant the permissions the watchdog needs (battery optimisation exemption,
#      Display over other apps)
#   7. install curl + termux-am-socket inside Termux
#   8. run the self-test and start the watchdog
#
# Read README-watchdog.md for the manual version of every step and for what to do
# when a step fails.

set -uo pipefail

FRAME_ID=""
FRAME_TOKEN=""
SERIAL=""
DO_REBOOT=0
SKIP_APKS=0
SERVER_HOST="${SERVER_HOST:-your-machine.your-tailnet.ts.net}"
TAILNET_IP="${TAILNET_IP:-}"
PUBLIC_URL="${PUBLIC_URL:-https://$SERVER_HOST}"

# Pinned F-Droid builds. Verified reachable at the time of writing; the version
# codes are in the filenames, so an upgrade is a one-line edit here.
TERMUX_APK_URL="https://f-droid.org/repo/com.termux_1022.apk"          # 0.119.0-beta.3
TERMUX_BOOT_APK_URL="https://f-droid.org/repo/com.termux.boot_1000.apk" # 0.8.1

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="${TMPDIR:-/tmp}/frameo-apks"
TERMUX_HOME="/data/data/com.termux/files/home"
STAGE="/sdcard/Download/frameo"

usage() {
  cat <<EOF
usage: $0 --frame-id <roster id> --token <authToken> [options]

  --frame-id ID     roster id of this tablet (frame-a | frame-b)
  --token TOKEN     that peer's authToken from roster.json
  --serial S        adb serial, if more than one device is attached
  --server-host H   MagicDNS name  (default $SERVER_HOST)
  --tailnet-ip IP   server's tailnet address, from 'tailscale ip -4' on the server
                    (default $TAILNET_IP)
  --public-url URL  Funnel origin   (default $PUBLIC_URL)
  --skip-apks       assume Termux and Termux:Boot are already installed
  --reboot          reboot the tablet at the end to prove boot-start works
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --frame-id)    FRAME_ID="${2:-}"; shift 2 ;;
    --token)       FRAME_TOKEN="${2:-}"; shift 2 ;;
    --serial)      SERIAL="${2:-}"; shift 2 ;;
    --server-host) SERVER_HOST="${2:-}"; PUBLIC_URL="https://${2:-}"; shift 2 ;;
    --tailnet-ip)  TAILNET_IP="${2:-}"; shift 2 ;;
    --public-url)  PUBLIC_URL="${2:-}"; shift 2 ;;
    --skip-apks)   SKIP_APKS=1; shift ;;
    --reboot)      DO_REBOOT=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$FRAME_ID" ] || [ -z "$FRAME_TOKEN" ] || [ -z "$TAILNET_IP" ]; then
  echo "ERROR: --frame-id, --token and --tailnet-ip (the server's 'tailscale ip -4') are required" >&2
  usage
  exit 2
fi

command -v adb >/dev/null 2>&1 || {
  echo "ERROR: adb not found. macOS: brew install --cask android-platform-tools; Debian/Ubuntu: apt install adb" >&2
  exit 2
}

ADB=(adb)
[ -n "$SERIAL" ] && ADB=(adb -s "$SERIAL")

step() { printf '\n=== %s ===\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# --------------------------------------------------------------------------
step "1/8 device"
# --------------------------------------------------------------------------
"${ADB[@]}" wait-for-device || die "no device. Enable USB debugging and accept the RSA prompt on the tablet."
DEVICES=$(adb devices | grep -c "device$")
if [ -z "$SERIAL" ] && [ "$DEVICES" -gt 1 ]; then
  adb devices
  die "more than one device attached - pass --serial"
fi
MODEL=$("${ADB[@]}" shell getprop ro.product.model | tr -d '\r')
RELEASE=$("${ADB[@]}" shell getprop ro.build.version.release | tr -d '\r')
echo "device: $MODEL  Android $RELEASE"

# --------------------------------------------------------------------------
step "2/8 APKs"
# --------------------------------------------------------------------------
have_pkg() { "${ADB[@]}" shell pm list packages 2>/dev/null | tr -d '\r' | grep -qx "package:$1"; }

if [ "$SKIP_APKS" -eq 1 ]; then
  echo "skipped (--skip-apks)"
else
  mkdir -p "$CACHE"
  for entry in "com.termux $TERMUX_APK_URL" "com.termux.boot $TERMUX_BOOT_APK_URL"; do
    pkg="${entry%% *}"; url="${entry##* }"; file="$CACHE/$(basename "$url")"
    if have_pkg "$pkg"; then
      echo "$pkg already installed - leaving it alone"
      continue
    fi
    if [ ! -s "$file" ]; then
      echo "downloading $url"
      curl -fL --progress-bar -o "$file" "$url" || die "download failed: $url"
    fi
    echo "installing $pkg"
    # -g grants the manifest permissions up front; -r allows a same-signature
    # upgrade. Both APKs come from f-droid.org, so their signatures match, which
    # is what makes Termux:Boot able to talk to Termux at all.
    "${ADB[@]}" install -r -g "$file" || die "install failed for $pkg"
  done
fi

have_pkg com.termux      || die "com.termux is not installed"
have_pkg com.termux.boot || die "com.termux.boot is not installed"
have_pkg com.tailscale.ipn || echo "WARNING: com.tailscale.ipn is not installed on this tablet"

# --------------------------------------------------------------------------
step "3/8 first run of Termux and Termux:Boot"
# --------------------------------------------------------------------------
# Termux:Boot does nothing at all until it has been opened once - that first
# launch is what registers its BOOT_COMPLETED receiver with the system.
"${ADB[@]}" shell monkey -p com.termux -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 6
"${ADB[@]}" shell monkey -p com.termux.boot -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
sleep 4
echo "both apps launched once"

# --------------------------------------------------------------------------
step "4/8 permissions"
# --------------------------------------------------------------------------
# Battery optimisation exemption: without it Android freezes the watchdog loop
# during Doze and the 60s check becomes whatever the OS feels like.
"${ADB[@]}" shell dumpsys deviceidle whitelist +com.termux >/dev/null 2>&1 \
  && echo "deviceidle whitelist: com.termux" \
  || echo "WARNING: could not whitelist com.termux from deviceidle"

# Display over other apps. This is what lets Termux start the Tailscale ACTIVITY
# from the background; without it only the CONNECT_VPN broadcast path works.
"${ADB[@]}" shell appops set com.termux SYSTEM_ALERT_WINDOW allow >/dev/null 2>&1 \
  && echo "appops: com.termux SYSTEM_ALERT_WINDOW allow" \
  || echo "WARNING: could not grant SYSTEM_ALERT_WINDOW - grant it by hand in Settings > Apps > Termux > Display over other apps"

# Keep Termux running in the background on One UI, which is more aggressive than
# stock Android about killing background processes.
"${ADB[@]}" shell appops set com.termux RUN_IN_BACKGROUND allow >/dev/null 2>&1
"${ADB[@]}" shell appops set com.termux RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1
"${ADB[@]}" shell cmd appops set com.termux.boot RUN_IN_BACKGROUND allow >/dev/null 2>&1
echo "background execution allowed for com.termux"

# --------------------------------------------------------------------------
step "5/8 pushing files"
# --------------------------------------------------------------------------
# adb cannot write into /data/data/com.termux directly on a non-rooted device, so
# everything is staged on shared storage and copied in by Termux itself.
[ -f "$HERE/tailscale-watchdog.sh" ]   || die "tailscale-watchdog.sh not found next to this script"
[ -f "$HERE/termux-boot-launcher.sh" ] || die "termux-boot-launcher.sh not found next to this script"

ENVTMP="$(mktemp)"
trap 'rm -f "$ENVTMP"' EXIT
cat > "$ENVTMP" <<EOF
# generated by install-watchdog.sh on $(date '+%Y-%m-%d %H:%M:%S %z')
FRAME_ID=$FRAME_ID
FRAME_TOKEN=$FRAME_TOKEN
SERVER_HOST=$SERVER_HOST
TAILNET_IP=$TAILNET_IP
PUBLIC_URL=$PUBLIC_URL
CHECK_INTERVAL=60
BACKOFF_INTERVAL=300
BOOT_DELAY=45
EOF

"${ADB[@]}" shell mkdir -p "$STAGE" >/dev/null 2>&1
"${ADB[@]}" push "$HERE/tailscale-watchdog.sh"   "$STAGE/tailscale-watchdog.sh"   >/dev/null || die "push failed"
"${ADB[@]}" push "$HERE/termux-boot-launcher.sh" "$STAGE/10-frameo-watchdog.sh"   >/dev/null || die "push failed"
"${ADB[@]}" push "$ENVTMP"                       "$STAGE/watchdog.env"            >/dev/null || die "push failed"
echo "staged in $STAGE"

# run-as works on Termux because F-Droid builds are debuggable=false... but the
# reliable path on a locked device is to let Termux copy the files itself.
run_in_termux() {
  # RUN_COMMAND needs com.termux.permission.RUN_COMMAND, which `adb shell am`
  # holds as the shell user. Output goes to the Termux session, so we keep the
  # commands short and verify their effects afterwards instead.
  "${ADB[@]}" shell am startservice \
    --user 0 \
    -n com.termux/com.termux.app.RunCommandService \
    -a com.termux.RUN_COMMAND \
    --es com.termux.RUN_COMMAND_PATH "/data/data/com.termux/files/usr/bin/bash" \
    --esa com.termux.RUN_COMMAND_ARGUMENTS "-c,$1" \
    --ez com.termux.RUN_COMMAND_BACKGROUND "${2:-true}" \
    --es com.termux.RUN_COMMAND_SESSION_ACTION "0" >/dev/null 2>&1
}

INSTALL_CMD="mkdir -p \$HOME/.frameo \$HOME/.termux/boot; \
cp $STAGE/tailscale-watchdog.sh \$HOME/.frameo/tailscale-watchdog.sh; \
cp $STAGE/10-frameo-watchdog.sh \$HOME/.termux/boot/10-frameo-watchdog.sh; \
cp $STAGE/watchdog.env \$HOME/.frameo/watchdog.env; \
chmod 700 \$HOME/.frameo/tailscale-watchdog.sh \$HOME/.termux/boot/10-frameo-watchdog.sh; \
chmod 600 \$HOME/.frameo/watchdog.env; \
touch \$HOME/.frameo/installed"

run_in_termux "$INSTALL_CMD"
sleep 8

if "${ADB[@]}" shell "run-as com.termux ls files/home/.frameo/installed" >/dev/null 2>&1; then
  echo "files copied into Termux home"
else
  echo "NOTE: could not verify the copy from here (run-as is blocked on release builds)."
  echo "      Verify on the tablet, or in a Termux session run:"
  echo "        ls -l ~/.frameo ~/.termux/boot"
fi

# --------------------------------------------------------------------------
step "6/8 Termux packages (curl, termux-am-socket)"
# --------------------------------------------------------------------------
# termux-am-socket is what gives Termux a working `am`; /system/bin/am only works
# for the shell user, not for an app.
run_in_termux "yes | pkg install -y curl termux-am-socket termux-tools >/dev/null 2>&1; touch \$HOME/.frameo/pkgs-done"
echo "package install requested - this needs network on the tablet and takes ~30s"
sleep 45

# --------------------------------------------------------------------------
step "7/8 self-test"
# --------------------------------------------------------------------------
run_in_termux "\$HOME/.frameo/tailscale-watchdog.sh --test > \$HOME/.frameo/selftest.txt 2>&1"
sleep 20
"${ADB[@]}" shell "run-as com.termux cat files/home/.frameo/selftest.txt" 2>/dev/null \
  || echo "NOTE: read the self-test on the tablet: cat ~/.frameo/selftest.txt"

# --------------------------------------------------------------------------
step "8/8 start"
# --------------------------------------------------------------------------
run_in_termux "\$HOME/.termux/boot/10-frameo-watchdog.sh"
sleep 5
echo "watchdog started"

cat <<EOF

Done. Verify from the SERVER (not from here):

  jq . ~/frameo/logs/frame-heartbeats.json
  ~/frameo/server/frame-heartbeat-alert.sh

The frame should appear within ~60s and the alert script should print OK. Then:

  $( [ "$DO_REBOOT" -eq 1 ] && echo "rebooting now..." || echo "adb${SERIAL:+ -s $SERIAL} reboot   # then watch .frames again for 5 minutes" )
EOF

if [ "$DO_REBOOT" -eq 1 ]; then
  "${ADB[@]}" reboot
fi
