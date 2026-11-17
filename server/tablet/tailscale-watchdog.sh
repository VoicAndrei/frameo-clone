#!/data/data/com.termux/files/usr/bin/bash
#
# tailscale-watchdog.sh - keep the photo frame's tailnet path alive on an
# Android tablet locked down with FreeKiosk as Device Owner. Tested on a Samsung
# Galaxy Tab A9+ (SM-X210, Android 16 / One UI 8).
#
# WHY THIS EXISTS
#   The Tailscale Android app does not reliably start itself after a reboot.
#   `settings put global always_on_vpn_app`, the deviceidle whitelist and
#   FreeKiosk's "Launch on Boot" / "Keep Alive" all fail to fix it; launching the
#   app by hand fixes it in seconds. Upstream: tailscale/tailscale#10013, #9428,
#   #2481, #11432, #8260, #16935 and - the one that matters on Android 16 -
#   #18847 ("Background start not allowed: service Intent", and a single
#   CONNECT_VPN broadcast being insufficient).
#
#   This script runs on the tablet under Termux:Boot. Every cycle it asks one
#   question: "can I reach the server over the tailnet?" If not - and the tablet
#   does have general internet - it escalates through three increasingly rude
#   ways of waking Tailscale up, then backs off.
#
# WHAT IT DELIBERATELY DOES NOT DO
#   - It never restarts Tailscale because Wi-Fi is down. No internet means no
#     tailnet either; force-stopping the VPN would only burn battery.
#   - It never spins. Healthy cycles cost one HTTPS HEAD-ish request each, the
#     log stays silent, and repeated failure widens the interval instead of
#     tightening it.
#   - It never force-stops more than FORCE_STOP_MAX_PER_HOUR times an hour.
#
# MODES
#   tailscale-watchdog.sh --loop      run forever (this is what Termux:Boot runs)
#   tailscale-watchdog.sh --once      run a single cycle and exit (exit 0 healthy)
#   tailscale-watchdog.sh --status    print current state, touch nothing
#   tailscale-watchdog.sh --test      verify the environment (am, curl, config)
#
# CONFIGURATION
#   Everything below is overridden by ~/.frameo/watchdog.env - see
#   watchdog.env.example. No secret is ever written into this file.
#
# See README-watchdog.md for the exact adb install sequence.

set -u

WATCHDOG_VERSION="1.1.0"

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

FRAMEO_DIR="${FRAMEO_DIR:-$HOME/.frameo}"
CONFIG_FILE="${CONFIG_FILE:-$FRAMEO_DIR/watchdog.env}"

# shellcheck source=/dev/null
[ -r "$CONFIG_FILE" ] && . "$CONFIG_FILE"

# --- identity --------------------------------------------------------------
# The roster id and authToken of THIS frame, exactly as they appear in
# ~/frameo/config/roster.json and in the kiosk URL.
FRAME_ID="${FRAME_ID:-}"
FRAME_TOKEN="${FRAME_TOKEN:-}"

# --- where the server is ---------------------------------------------------
# MagicDNS name of the server. This is the name the Let's Encrypt certificate
# is issued for, over both the tailnet and the public Funnel.
SERVER_HOST="${SERVER_HOST:-your-machine.your-tailnet.ts.net}"
# Tailnet (100.x) address of the same machine; set it in watchdog.env (find it
# with `tailscale ip -4` on the server). Used with curl --resolve so the
# tailnet probe never depends on MagicDNS resolution working.
TAILNET_IP="${TAILNET_IP:-100.64.0.1}"   # placeholder; the env file sets the real one
# Scheme/port of the tailnet probe. These are 443/https because Funnel (and,
# before it, `tailscale serve`) terminates TLS on 443 and proxies to
# 127.0.0.1:8080; they are variables only so a staging box can be probed without
# editing this file.
TAILNET_SCHEME="${TAILNET_SCHEME:-https}"
TAILNET_PORT="${TAILNET_PORT:-443}"
# Public origin, served by `tailscale funnel --https=443`. Reachable WITHOUT
# Tailscale on this tablet, which is why the heartbeat goes here.
PUBLIC_URL="${PUBLIC_URL:-https://$SERVER_HOST}"
HEALTH_PATH="${HEALTH_PATH:-/api/health}"
HEARTBEAT_PATH="${HEARTBEAT_PATH:-/api/frame-heartbeat}"

# --- packages --------------------------------------------------------------
TS_PACKAGE="${TS_PACKAGE:-com.tailscale.ipn}"
TS_ACTIVITY="${TS_ACTIVITY:-com.tailscale.ipn/.IPNActivity}"
TS_RECEIVER="${TS_RECEIVER:-com.tailscale.ipn/.IPNReceiver}"
TS_CONNECT_ACTION="${TS_CONNECT_ACTION:-com.tailscale.ipn.CONNECT_VPN}"
# FreeKiosk. Empty KIOSK_COMPONENT means "bring the kiosk back with a HOME
# intent", which works because FreeKiosk in Device Owner lock-task mode is the
# home activity. Set the explicit component if your setup differs.
KIOSK_PACKAGE="${KIOSK_PACKAGE:-com.freekiosk}"
KIOSK_COMPONENT="${KIOSK_COMPONENT:-}"
REFOCUS_KIOSK="${REFOCUS_KIOSK:-1}"

# --- timing (seconds) ------------------------------------------------------
CHECK_INTERVAL="${CHECK_INTERVAL:-60}"        # healthy cadence
BACKOFF_INTERVAL="${BACKOFF_INTERVAL:-300}"   # cadence after BACKOFF_AFTER failures
BACKOFF_AFTER="${BACKOFF_AFTER:-5}"
BOOT_DELAY="${BOOT_DELAY:-45}"                # let Wi-Fi and Tailscale try on their own first
GRACE_AFTER_NUDGE="${GRACE_AFTER_NUDGE:-25}"  # how long a nudge gets before we judge it
KIOSK_REFOCUS_DELAY="${KIOSK_REFOCUS_DELAY:-12}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-6}"
CURL_MAX_TIME="${CURL_MAX_TIME:-12}"
FORCE_STOP_MAX_PER_HOUR="${FORCE_STOP_MAX_PER_HOUR:-4}"
HEALTHY_LOG_EVERY="${HEALTHY_LOG_EVERY:-30}"  # log a healthy line once per N cycles

# --- logging ---------------------------------------------------------------
LOG_FILE="${LOG_FILE:-$FRAMEO_DIR/watchdog.log}"
LOG_MAX_BYTES="${LOG_MAX_BYTES:-262144}"      # 256 KiB per file
LOG_KEEP="${LOG_KEEP:-3}"
STATE_FILE="${STATE_FILE:-$FRAMEO_DIR/watchdog.state}"
LOCK_DIR="${LOCK_DIR:-$FRAMEO_DIR/watchdog.lock}"

# Internet probe that is not our own server, for the "is it the tailnet or is it
# the Wi-Fi?" question. 204-no-content, no payload, no redirect.
INTERNET_PROBE_URL="${INTERNET_PROBE_URL:-http://connectivitycheck.gstatic.com/generate_204}"

mkdir -p "$FRAMEO_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Logging with rotation
# ---------------------------------------------------------------------------

file_size() {
  # stat(1) from coreutils is present in Termux; wc keeps this honest elsewhere.
  stat -c %s "$1" 2>/dev/null || wc -c < "$1" 2>/dev/null || echo 0
}

rotate_log() {
  [ -f "$LOG_FILE" ] || return 0
  local size
  size=$(file_size "$LOG_FILE")
  [ -z "$size" ] && size=0
  [ "$size" -le "$LOG_MAX_BYTES" ] 2>/dev/null && return 0
  local i=$LOG_KEEP
  while [ "$i" -gt 1 ]; do
    mv -f "$LOG_FILE.$((i - 1))" "$LOG_FILE.$i" 2>/dev/null || true
    i=$((i - 1))
  done
  mv -f "$LOG_FILE" "$LOG_FILE.1" 2>/dev/null || true
  : > "$LOG_FILE"
}

log() {
  local level="$1"; shift
  rotate_log
  printf '%s %-5s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$level" "$*" >> "$LOG_FILE" 2>/dev/null
  # When run interactively (--once/--test from an adb shell) also say it out loud.
  [ -t 1 ] && printf '%-5s %s\n' "$level" "$*"
  return 0
}

# ---------------------------------------------------------------------------
# Single instance
# ---------------------------------------------------------------------------
# mkdir is atomic on every filesystem Android gives us. A lock whose recorded PID
# is gone is stale (Android kills background processes without warning) and is
# reclaimed rather than blocking the watchdog forever.

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo $$ > "$LOCK_DIR/pid"
    return 0
  fi
  local other
  other=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    return 1
  fi
  log WARN "reclaiming stale lock (pid ${other:-unknown} is gone)"
  rm -rf "$LOCK_DIR" 2>/dev/null
  mkdir "$LOCK_DIR" 2>/dev/null || return 1
  echo $$ > "$LOCK_DIR/pid"
  return 0
}

release_lock() { rm -rf "$LOCK_DIR" 2>/dev/null || true; }

# ---------------------------------------------------------------------------
# Persistent counters
# ---------------------------------------------------------------------------

CONSECUTIVE_FAILURES=0
TOTAL_RESTARTS=0
FORCE_STOPS_THIS_HOUR=0
FORCE_STOP_WINDOW_START=0
HEALTHY_CYCLES=0
LAST_STATE="unknown"
LAST_ACTION="none"

load_state() {
  [ -r "$STATE_FILE" ] || return 0
  # shellcheck source=/dev/null
  . "$STATE_FILE" 2>/dev/null || true
}

save_state() {
  cat > "$STATE_FILE.tmp" 2>/dev/null <<EOF
CONSECUTIVE_FAILURES=$CONSECUTIVE_FAILURES
TOTAL_RESTARTS=$TOTAL_RESTARTS
FORCE_STOPS_THIS_HOUR=$FORCE_STOPS_THIS_HOUR
FORCE_STOP_WINDOW_START=$FORCE_STOP_WINDOW_START
HEALTHY_CYCLES=$HEALTHY_CYCLES
LAST_STATE=$LAST_STATE
LAST_ACTION=$LAST_ACTION
EOF
  mv -f "$STATE_FILE.tmp" "$STATE_FILE" 2>/dev/null || true
}

now_epoch() { date +%s; }

# ---------------------------------------------------------------------------
# Probes
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

# Reachability of the server over the TAILNET.
#
# --resolve pins the MagicDNS name to the tailnet IP, so this proves three things
# at once and depends on none of them separately: the tun interface is up, the
# peer is routable, and TLS to the real certificate works. It does NOT depend on
# MagicDNS being the system resolver, which is itself a thing that breaks when
# the app is half-started.
tailnet_ok() {
  curl -fsS -o /dev/null \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    --resolve "$SERVER_HOST:$TAILNET_PORT:$TAILNET_IP" \
    "$TAILNET_SCHEME://$SERVER_HOST:$TAILNET_PORT$HEALTH_PATH" 2>/dev/null && return 0

  # Fallback: a bare TCP handshake against the tailnet IP. If this works but the
  # request above did not, the tunnel is fine and the server is the problem -
  # which is emphatically not something to fix by restarting the VPN.
  if have timeout; then
    timeout 5 bash -c "exec 3<>/dev/tcp/$TAILNET_IP/$TAILNET_PORT" 2>/dev/null && return 0
  fi
  return 1
}

# General internet, deliberately NOT via our own server.
internet_ok() {
  curl -fsS -o /dev/null \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    "$PUBLIC_URL$HEALTH_PATH" 2>/dev/null && return 0
  curl -fsS -o /dev/null \
    --connect-timeout 5 --max-time 8 \
    "$INTERNET_PROBE_URL" 2>/dev/null && return 0
  return 1
}

battery_level() {
  local pct=""
  [ -r /sys/class/power_supply/battery/capacity ] \
    && pct=$(cat /sys/class/power_supply/battery/capacity 2>/dev/null)
  if [ -z "$pct" ] && have termux-battery-status; then
    pct=$(termux-battery-status 2>/dev/null | sed -n 's/.*"percentage"[: ]*\([0-9]*\).*/\1/p' | head -1)
  fi
  case "$pct" in
    ''|*[!0-9]*) echo "" ;;
    *) echo "$pct" ;;
  esac
}

device_uptime() {
  local u
  u=$(cut -d' ' -f1 /proc/uptime 2>/dev/null)
  case "$u" in
    ''|*[!0-9.]*) echo 0 ;;
    *) echo "${u%%.*}" ;;
  esac
}

# ---------------------------------------------------------------------------
# Waking Tailscale up
# ---------------------------------------------------------------------------
#
# Three escalating mechanisms, cheapest and least disruptive first:
#
#  1. BROADCAST com.tailscale.ipn.CONNECT_VPN to the exported IPNReceiver.
#     This is Tailscale's own documented automation entry point. It needs no
#     activity launch, so it is immune both to Android's background-activity-
#     start restrictions and to FreeKiosk's lock-task allowlist. Sent twice,
#     ~2s apart, because a single one is documented as insufficient on
#     Android 16 / targetSdk 35 (tailscale/tailscale#18847).
#
#  2. START THE ACTIVITY. This is what works when you do it by hand. It briefly
#     covers the photo frame, so we bring the kiosk back afterwards. Requires
#     Termux to hold "Display over other apps", and requires com.tailscale.ipn
#     to be allowed by FreeKiosk if lock task mode is on.
#
#  3. FORCE-STOP, then start the activity. The sledgehammer, rate limited.
#     Note the -f 32 (FLAG_INCLUDE_STOPPED_PACKAGES) on any broadcast after a
#     force-stop: a force-stopped package is in the "stopped" state and does not
#     receive ordinary broadcasts at all.

am_cmd() {
  # Termux ships `am` via the termux-am-socket package: the intent is dispatched
  # by the Termux app itself, under Termux's uid. /system/bin/am is the fallback
  # and only works when this runs from an adb shell.
  if have am; then
    am "$@" >/dev/null 2>&1
  elif [ -x /system/bin/am ]; then
    /system/bin/am "$@" >/dev/null 2>&1
  else
    return 127
  fi
}

nudge_broadcast() {
  local extra_flags="${1:-}"
  # shellcheck disable=SC2086
  am_cmd broadcast $extra_flags -a "$TS_CONNECT_ACTION" -n "$TS_RECEIVER"
  local rc=$?
  sleep 2
  # shellcheck disable=SC2086
  am_cmd broadcast $extra_flags -a "$TS_CONNECT_ACTION" -n "$TS_RECEIVER"
  return $rc
}

start_activity() {
  am_cmd start -n "$TS_ACTIVITY"
}

refocus_kiosk() {
  [ "$REFOCUS_KIOSK" = "1" ] || return 0
  sleep "$KIOSK_REFOCUS_DELAY"
  if [ -n "$KIOSK_COMPONENT" ]; then
    am_cmd start -n "$KIOSK_COMPONENT" && return 0
  fi
  # FreeKiosk as Device Owner is the home activity, so HOME puts the frame back
  # on screen without needing to know its component name.
  am_cmd start -a android.intent.action.MAIN -c android.intent.category.HOME
}

force_stop_allowed() {
  local now window_age
  now=$(now_epoch)
  window_age=$((now - FORCE_STOP_WINDOW_START))
  if [ "$FORCE_STOP_WINDOW_START" -eq 0 ] || [ "$window_age" -ge 3600 ]; then
    FORCE_STOP_WINDOW_START=$now
    FORCE_STOPS_THIS_HOUR=0
  fi
  [ "$FORCE_STOPS_THIS_HOUR" -lt "$FORCE_STOP_MAX_PER_HOUR" ]
}

# ---------------------------------------------------------------------------
# Heartbeat
# ---------------------------------------------------------------------------
#
# Posted to the PUBLIC Funnel origin on purpose: it must keep arriving while the
# tailnet path is broken, because "heartbeat present, tailnetOk=false" is the
# signature of the bug this whole script exists for, and "no heartbeat at all"
# means the tablet is off or off the network. Authenticated with this frame's own
# roster token - the same one already in the kiosk URL - never with CONTROL_TOKEN.

HEARTBEAT_ENDPOINT_MISSING=0

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

send_heartbeat() {
  local tailnet="$1" internet="$2" action="$3" note="${4:-}"
  [ -n "$FRAME_ID" ] && [ -n "$FRAME_TOKEN" ] || return 0
  [ "$internet" = "true" ] || return 0
  [ "$HEARTBEAT_ENDPOINT_MISSING" = "1" ] && return 0

  local battery uptime body code
  battery=$(battery_level)
  uptime=$(device_uptime)

  body="{\"id\":\"$(json_escape "$FRAME_ID")\""
  body="$body,\"tailnetOk\":$tailnet,\"internetOk\":$internet"
  body="$body,\"action\":\"$(json_escape "$action")\""
  body="$body,\"restarts\":$TOTAL_RESTARTS,\"uptimeSeconds\":$uptime"
  body="$body,\"via\":\"funnel\",\"watchdogVersion\":\"$WATCHDOG_VERSION\""
  [ -n "$battery" ] && body="$body,\"battery\":$battery"
  [ -n "$note" ] && body="$body,\"note\":\"$(json_escape "$note")\""
  body="$body}"

  code=$(curl -s -o /dev/null -w '%{http_code}' \
    --connect-timeout "$CURL_CONNECT_TIMEOUT" --max-time "$CURL_MAX_TIME" \
    -X POST "$PUBLIC_URL$HEARTBEAT_PATH" \
    -H 'content-type: application/json' \
    -H "Authorization: Bearer $FRAME_TOKEN" \
    --data-binary "$body" 2>/dev/null)

  case "$code" in
    200) return 0 ;;
    404)
      # An older server build. Say so once, then stop wasting requests on it.
      HEARTBEAT_ENDPOINT_MISSING=1
      log WARN "heartbeat endpoint missing on the server (HTTP 404) - deploy a signalling build with POST $HEARTBEAT_PATH; disabling heartbeats for this run"
      ;;
    403)
      log ERROR "heartbeat rejected (HTTP 403) - FRAME_ID/FRAME_TOKEN do not match roster.json, or this id is not kind=frame"
      ;;
    000|'')
      : # network hiccup, already reflected by the internet probe
      ;;
    *)
      log WARN "heartbeat unexpected HTTP $code"
      ;;
  esac
  return 1
}

# ---------------------------------------------------------------------------
# One cycle
# ---------------------------------------------------------------------------
#
# Returns 0 when the tailnet path is healthy at the end of the cycle.

run_cycle() {
  local action="none" note="" internet="false" tailnet="false" rc=1

  if tailnet_ok; then
    tailnet="true"; internet="true"
  elif internet_ok; then
    internet="true"
  fi

  if [ "$tailnet" = "true" ]; then
    if [ "$LAST_STATE" != "healthy" ]; then
      log INFO "tailnet reachable again (after $CONSECUTIVE_FAILURES failed check(s), $TOTAL_RESTARTS restart(s) total)"
      HEALTHY_CYCLES=0
    fi
    CONSECUTIVE_FAILURES=0
    LAST_STATE="healthy"
    HEALTHY_CYCLES=$((HEALTHY_CYCLES + 1))
    # Quiet when healthy: one line every HEALTHY_LOG_EVERY cycles, so the log is
    # proof of life without being noise.
    if [ "$HEALTHY_LOG_EVERY" -gt 0 ] && [ $((HEALTHY_CYCLES % HEALTHY_LOG_EVERY)) -eq 0 ]; then
      local batt
      batt=$(battery_level)
      log INFO "healthy ($HEALTHY_CYCLES cycles${batt:+, battery ${batt}%})"
    fi
    rc=0

  elif [ "$internet" != "true" ]; then
    # No internet: a Wi-Fi flap, a reboot mid-associate, or the router. Restarting
    # Tailscale here would be pure superstition, so we only note the transition.
    if [ "$LAST_STATE" != "offline" ]; then
      log WARN "no internet - not touching Tailscale (Wi-Fi down?)"
    fi
    LAST_STATE="offline"
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    action="none"; note="no internet"

  else
    # Internet works, the tailnet does not. This is the bug. Escalate.
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    LAST_STATE="tailnet-down"
    log WARN "tailnet unreachable but internet is up (failure #$CONSECUTIVE_FAILURES)"

    if [ "$CONSECUTIVE_FAILURES" -le 1 ]; then
      action="broadcast"
      log INFO "sending CONNECT_VPN broadcast x2"
      nudge_broadcast || log WARN "am broadcast failed (rc=$?) - is termux-am-socket installed?"

    elif [ "$CONSECUTIVE_FAILURES" -eq 2 ]; then
      action="activity-start"
      log INFO "starting the Tailscale activity"
      if start_activity; then
        refocus_kiosk
      else
        log WARN "am start failed - grant Termux 'Display over other apps', and allow com.tailscale.ipn in FreeKiosk's lock-task list"
      fi

    else
      if force_stop_allowed; then
        action="force-restart"
        FORCE_STOPS_THIS_HOUR=$((FORCE_STOPS_THIS_HOUR + 1))
        TOTAL_RESTARTS=$((TOTAL_RESTARTS + 1))
        log WARN "force-stopping $TS_PACKAGE and restarting it (restart #$TOTAL_RESTARTS, $FORCE_STOPS_THIS_HOUR this hour)"
        am_cmd force-stop "$TS_PACKAGE"
        sleep 3
        start_activity || log WARN "am start after force-stop failed"
        sleep 3
        # A force-stopped package is in the stopped state and ignores ordinary
        # broadcasts; FLAG_INCLUDE_STOPPED_PACKAGES (32) is what gets through.
        nudge_broadcast "-f 32"
        refocus_kiosk
      else
        action="rate-limited"
        note="force-stop budget exhausted"
        log ERROR "tailnet still down but the force-stop budget for this hour is used up ($FORCE_STOPS_THIS_HOUR/$FORCE_STOP_MAX_PER_HOUR) - the frame keeps working over the public Funnel URL"
      fi
    fi

    # Give whatever we just did a chance before the next full cycle, and re-check
    # once so a successful nudge is reported as such instead of as a failure.
    if [ "$action" != "none" ] && [ "$action" != "rate-limited" ]; then
      sleep "$GRACE_AFTER_NUDGE"
      if tailnet_ok; then
        log INFO "recovered after $action"
        tailnet="true"
        CONSECUTIVE_FAILURES=0
        LAST_STATE="healthy"
        HEALTHY_CYCLES=1
        rc=0
      fi
    fi
  fi

  LAST_ACTION="$action"
  save_state
  send_heartbeat "$tailnet" "$internet" "$action" "$note" || true
  return $rc
}

current_interval() {
  if [ "$CONSECUTIVE_FAILURES" -ge "$BACKOFF_AFTER" ]; then
    echo "$BACKOFF_INTERVAL"
  else
    echo "$CHECK_INTERVAL"
  fi
}

# ---------------------------------------------------------------------------
# Environment self-test
# ---------------------------------------------------------------------------

run_test() {
  local problems=0
  echo "frameo tailscale-watchdog $WATCHDOG_VERSION"
  echo "config file      : $CONFIG_FILE $([ -r "$CONFIG_FILE" ] && echo '(found)' || echo '(MISSING)')"
  echo "frame id         : ${FRAME_ID:-<unset>}"
  echo "token            : $([ -n "$FRAME_TOKEN" ] && echo 'set' || echo 'UNSET')"
  echo "server host      : $SERVER_HOST"
  echo "tailnet ip       : $TAILNET_IP"
  echo "public url       : $PUBLIC_URL"
  echo "log file         : $LOG_FILE"

  [ -n "$FRAME_ID" ]    || { echo "FAIL: FRAME_ID is not set";    problems=$((problems + 1)); }
  [ -n "$FRAME_TOKEN" ] || { echo "FAIL: FRAME_TOKEN is not set"; problems=$((problems + 1)); }

  if have curl; then echo "curl             : $(curl --version 2>/dev/null | head -1)"
  else echo "FAIL: curl is missing - run: pkg install curl"; problems=$((problems + 1)); fi

  if have am; then
    echo "am               : $(command -v am)"
  elif [ -x /system/bin/am ]; then
    echo "am               : /system/bin/am (works only from an adb shell)"
    echo "WARN: install the Termux one - pkg install termux-am-socket"
  else
    echo "FAIL: no am command - run: pkg install termux-am-socket"
    problems=$((problems + 1))
  fi

  if internet_ok; then echo "internet         : OK"
  else echo "FAIL: no internet"; problems=$((problems + 1)); fi

  if tailnet_ok; then echo "tailnet          : OK ($TAILNET_IP reachable)"
  else echo "WARN: tailnet unreachable right now - that is what the watchdog fixes"; fi

  if [ -n "$FRAME_ID" ] && [ -n "$FRAME_TOKEN" ]; then
    if send_heartbeat "false" "true" "selftest" "watchdog --test"; then
      echo "heartbeat        : accepted by $PUBLIC_URL$HEARTBEAT_PATH"
    else
      echo "FAIL: heartbeat was not accepted - see the log above"
      problems=$((problems + 1))
    fi
  fi

  if have pm; then
    if pm list packages 2>/dev/null | grep -q "$TS_PACKAGE"; then
      echo "$TS_PACKAGE     : installed"
    else
      echo "FAIL: $TS_PACKAGE is not installed on this device"
      problems=$((problems + 1))
    fi
  else
    echo "$TS_PACKAGE     : cannot check (no pm on PATH)"
  fi
  [ "$problems" -eq 0 ] && echo "RESULT: ready" || echo "RESULT: $problems problem(s)"
  return "$problems"
}

run_status() {
  load_state
  echo "state            : $LAST_STATE"
  echo "last action      : $LAST_ACTION"
  echo "consecutive fails: $CONSECUTIVE_FAILURES"
  echo "restarts total   : $TOTAL_RESTARTS"
  echo "force-stops/hour : $FORCE_STOPS_THIS_HOUR/$FORCE_STOP_MAX_PER_HOUR"
  echo "healthy cycles   : $HEALTHY_CYCLES"
  echo "next interval    : $(current_interval)s"
  echo "--- last 20 log lines ---"
  tail -20 "$LOG_FILE" 2>/dev/null || echo "(no log yet)"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

MODE="${1:---loop}"

case "$MODE" in
  --status) run_status; exit 0 ;;
  --test)   run_test; exit $? ;;
  --once)
    acquire_lock || { echo "another watchdog instance is running" >&2; exit 3; }
    trap 'release_lock' EXIT INT TERM
    load_state
    run_cycle
    exit $?
    ;;
  --loop) ;;
  *) echo "usage: $0 [--loop|--once|--status|--test]" >&2; exit 2 ;;
esac

acquire_lock || { log WARN "another watchdog instance is already running - exiting"; exit 3; }
trap 'log INFO "watchdog stopping"; release_lock; exit 0' INT TERM
trap 'release_lock' EXIT

load_state
# A fresh boot resets the escalation ladder: whatever happened before the reboot
# is not evidence about what is happening now.
CONSECUTIVE_FAILURES=0
HEALTHY_CYCLES=0
LAST_STATE="unknown"

log INFO "watchdog $WATCHDOG_VERSION starting (frame=${FRAME_ID:-unset} interval=${CHECK_INTERVAL}s server=$SERVER_HOST tailnet=$TAILNET_IP)"

if [ -z "$FRAME_ID" ] || [ -z "$FRAME_TOKEN" ]; then
  log ERROR "FRAME_ID/FRAME_TOKEN are not set in $CONFIG_FILE - the watchdog will still restart Tailscale but cannot report a heartbeat"
fi

# Termux:Boot fires us early, while Wi-Fi is often still associating. Judging
# Tailscale before the network exists would guarantee a pointless restart on
# every single boot.
if [ "$BOOT_DELAY" -gt 0 ]; then
  uptime_now=$(device_uptime)
  if [ "$uptime_now" -lt 300 ]; then
    log INFO "fresh boot (uptime ${uptime_now}s) - waiting ${BOOT_DELAY}s before the first check"
    sleep "$BOOT_DELAY"
  fi
fi

while true; do
  run_cycle || true
  sleep "$(current_interval)"
done
