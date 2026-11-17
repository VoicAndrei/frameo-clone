#!/usr/bin/env bash
#
# frame-heartbeat-alert.sh - warn when a photo frame stops reporting.
#
#   */5 * * * * ~/frameo/server/frame-heartbeat-alert.sh
#
# Each frame tablet runs tablet/tailscale-watchdog.sh under Termux:Boot and POSTs
# /api/frame-heartbeat once a minute over the PUBLIC Funnel URL. That deliberate
# choice is what makes this script able to tell three states apart:
#
#   HEALTHY   heartbeat recent, tailnetOk=true         nothing to say
#   DEGRADED  heartbeat recent, tailnetOk=false        the tablet is alive and on
#             the internet, but its Tailscale is dead - the known
#             tailscale-android autostart bug. The frame still works over the
#             Funnel; remote admin over the tailnet does not.
#   DOWN      no heartbeat for FRAME_STALE_MINUTES     tablet off, unplugged, or
#             off the network entirely.
#
# It is read-only: it starts nothing, restarts nothing, and never touches docker.
# Safe to run every five minutes forever.
#
# Exit codes
#   0  every frame healthy (or only informational notes)
#   1  at least one frame is DOWN or DEGRADED
#   2  the script could not perform its check at all (no state, no API)
#
# Environment overrides
#   FRAMEO_ROOT           default $HOME/frameo
#   HEARTBEAT_STATE       default ${FRAMEO_ROOT}/logs/frame-heartbeats.json
#   SIGNALLING_URL        default http://127.0.0.1:8080   (fallback source)
#   FRAME_STALE_MINUTES   default 15
#   ALERT_URL             ntfy-style endpoint to POST the alert text to,
#                         e.g. https://ntfy.sh/<your-private-topic>. Unset or
#                         empty = print only.
#   ALERT_REPEAT_MINUTES  do not re-send the same alert more often than this
#                         (default 60), so a frame that is off for a week does
#                         not produce 2000 notifications.
#   STATE_DIR             where the de-duplication stamps live
#                         (default ${FRAMEO_ROOT}/logs/alert-state)
#   QUIET_HOURS           e.g. "23-7": suppress SENDING between these hours;
#                         the check still runs and still exits non-zero.

set -uo pipefail

FRAMEO_ROOT="${FRAMEO_ROOT:-$HOME/frameo}"
HEARTBEAT_STATE="${HEARTBEAT_STATE:-${FRAMEO_ROOT}/logs/frame-heartbeats.json}"
SIGNALLING_URL="${SIGNALLING_URL:-http://127.0.0.1:8080}"
FRAME_STALE_MINUTES="${FRAME_STALE_MINUTES:-15}"
ALERT_URL="${ALERT_URL:-}"
ALERT_REPEAT_MINUTES="${ALERT_REPEAT_MINUTES:-60}"
STATE_DIR="${STATE_DIR:-${FRAMEO_ROOT}/logs/alert-state}"
QUIET_HOURS="${QUIET_HOURS:-}"

STALE_SECONDS=$((FRAME_STALE_MINUTES * 60))

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'; C_YEL=$'\033[1;33m'
else
  C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''
fi

have() { command -v "$1" >/dev/null 2>&1; }
have python3 || { echo "python3 is required" >&2; exit 2; }

mkdir -p "$STATE_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Source the data
# ---------------------------------------------------------------------------
# Preferred source is the state file the signalling server writes, because it
# survives a container restart and needs no token. If it is missing or stale on
# disk we fall back to the live /api/health, which carries the same numbers.

PAYLOAD=""
SOURCE=""

if [[ -r "$HEARTBEAT_STATE" ]]; then
  PAYLOAD="$(cat "$HEARTBEAT_STATE" 2>/dev/null)"
  SOURCE="$HEARTBEAT_STATE"
fi

if [[ -z "$PAYLOAD" ]]; then
  if have curl; then
    PAYLOAD="$(curl -fsS --max-time 8 "${SIGNALLING_URL}/api/health" 2>/dev/null || true)"
    SOURCE="${SIGNALLING_URL}/api/health"
  fi
fi

if [[ -z "$PAYLOAD" ]]; then
  echo "${C_RED}CANNOT CHECK${C_RESET}: no ${HEARTBEAT_STATE} and ${SIGNALLING_URL}/api/health did not answer." >&2
  echo "The signalling container is probably down - that is what healthcheck.sh is for." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Evaluate
# ---------------------------------------------------------------------------
# One python pass produces machine-readable lines:  STATUS|id|name|age_s|detail
# It accepts either shape: the state file ({frames:[...]}) or /api/health
# ({frames:{list:[...]}}).

REPORT="$(
  STALE_SECONDS="$STALE_SECONDS" python3 - "$PAYLOAD" <<'PY'
import json, os, sys, time

raw = sys.argv[1]
stale = int(os.environ["STALE_SECONDS"])

try:
    doc = json.loads(raw)
except Exception as exc:
    print("ERROR|-|-|0|unparseable payload: %s" % exc)
    sys.exit(0)

frames = doc.get("frames")
never_seen = []
if isinstance(frames, dict):          # /api/health shape
    never_seen = frames.get("neverSeen") or []
    items = frames.get("list") or []
elif isinstance(frames, list):        # state-file shape
    items = frames
else:
    # No `frames` key at all. Since the login gate landed, GET /api/health answers
    # an anonymous caller with a bare {"ok": true} and keeps the detail for
    # authenticated ones - so this is "I could not look", not "no frames exist".
    # Reporting it as an outage here would be crying wolf.
    print("NOCHECK|-|-|0|the payload carries no frame data (an auth-gated /api/health answers {\"ok\":true}); read the state file instead")
    sys.exit(0)

now = time.time()

def age_of(f):
    # The state file carries epoch ms; /api/health carries a relative age.
    if isinstance(f.get("lastSeen"), (int, float)):
        return max(0, now - f["lastSeen"] / 1000.0)
    if isinstance(f.get("lastSeenSecondsAgo"), (int, float)):
        return max(0, float(f["lastSeenSecondsAgo"]))
    return None

if not items and not never_seen:
    print("EMPTY|-|-|0|no frame has ever reported a heartbeat")
    sys.exit(0)

for fid in never_seen:
    print("NEVER|%s|%s|0|in the roster but has never sent a heartbeat" % (fid, fid))

for f in items:
    fid = str(f.get("id", "?"))
    name = str(f.get("displayName") or fid)
    age = age_of(f)
    if age is None:
        print("ERROR|%s|%s|0|heartbeat record has no timestamp" % (fid, name))
        continue
    age = int(age)
    tail = f.get("tailnetOk")
    net = f.get("internetOk")
    batt = f.get("battery")
    restarts = f.get("restarts")
    action = f.get("lastAction") or "none"

    bits = []
    if batt not in (None, ""):
        bits.append("battery %s%%" % batt)
    if restarts not in (None, "") and restarts:
        bits.append("%s tailscale restart(s)" % restarts)
    if action not in ("none", None, ""):
        bits.append("last action: %s" % action)
    extra = (" [" + ", ".join(bits) + "]") if bits else ""

    if age > stale:
        print("DOWN|%s|%s|%d|no heartbeat for %d min%s" % (fid, name, age, age // 60, extra))
    elif tail is False:
        print("DEGRADED|%s|%s|%d|reporting (%ds ago) but the tailnet is unreachable from the tablet%s"
              % (fid, name, age, age, extra))
    elif net is False:
        print("DEGRADED|%s|%s|%d|reporting but says it has no internet%s" % (fid, name, age, extra))
    else:
        print("OK|%s|%s|%d|seen %ds ago%s" % (fid, name, age, age, extra))
PY
)"

# ---------------------------------------------------------------------------
# Render + decide
# ---------------------------------------------------------------------------

PROBLEMS=0
NOCHECK=0
ALERT_LINES=()
NOW_EPOCH=$(date +%s)

while IFS='|' read -r status fid name age detail; do
  [[ -z "${status:-}" ]] && continue
  case "$status" in
    NOCHECK)
      printf '%sCANNOT CHECK%s %s\n' "$C_RED" "$C_RESET" "$detail" >&2
      NOCHECK=1
      ;;
    OK)
      printf '%sOK%s        %-18s %s\n' "$C_GRN" "$C_RESET" "$name" "$detail"
      # A frame that recovered clears its stamp, so the next outage alerts at once.
      rm -f "${STATE_DIR}/${fid}.alert" 2>/dev/null
      ;;
    DEGRADED)
      printf '%sDEGRADED%s  %-18s %s\n' "$C_YEL" "$C_RESET" "$name" "$detail"
      PROBLEMS=$((PROBLEMS + 1))
      ALERT_LINES+=("DEGRADED  ${name} (${fid}): ${detail}")
      ;;
    DOWN|NEVER|EMPTY|ERROR)
      printf '%s%-9s%s %-18s %s\n' "$C_RED" "$status" "$C_RESET" "$name" "$detail"
      PROBLEMS=$((PROBLEMS + 1))
      ALERT_LINES+=("${status}  ${name} (${fid}): ${detail}")
      ;;
  esac
done <<< "$REPORT"

echo "source: ${SOURCE}  threshold: ${FRAME_STALE_MINUTES} min"

if [[ "$NOCHECK" -eq 1 ]]; then
  cat >&2 <<EOF
This script wants ${HEARTBEAT_STATE}, which the signalling server writes on its own
(FRAME_HEARTBEAT_PATH, default /data/frame-heartbeats.json inside the container =
\${FRAMEO_ROOT}/logs/frame-heartbeats.json on the host). If that file is missing:
  - the container may predate POST /api/frame-heartbeat, or
  - no tablet has ever reported - see tablet/README-watchdog.md.
EOF
  exit 2
fi

if [[ "$PROBLEMS" -eq 0 ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Notify, with de-duplication and optional quiet hours
# ---------------------------------------------------------------------------

in_quiet_hours() {
  [[ -z "$QUIET_HOURS" ]] && return 1
  local from="${QUIET_HOURS%%-*}" to="${QUIET_HOURS##*-}" hour
  hour=$(date +%-H)
  [[ "$from" =~ ^[0-9]+$ && "$to" =~ ^[0-9]+$ ]] || return 1
  if (( from <= to )); then
    (( hour >= from && hour < to ))
  else
    (( hour >= from || hour < to ))   # window wraps midnight
  fi
}

# One stamp per distinct problem set: if the situation changes, alert immediately
# even inside the repeat window.
FINGERPRINT=$(printf '%s\n' "${ALERT_LINES[@]}" | cut -d: -f1 | sort | md5sum 2>/dev/null | cut -c1-16)
[[ -z "$FINGERPRINT" ]] && FINGERPRINT=$(printf '%s\n' "${ALERT_LINES[@]}" | cut -d: -f1 | sort | cksum | tr -d ' ')
STAMP="${STATE_DIR}/last-alert.${FINGERPRINT}"

SHOULD_SEND=1
if [[ -f "$STAMP" ]]; then
  LAST=$(cat "$STAMP" 2>/dev/null || echo 0)
  [[ "$LAST" =~ ^[0-9]+$ ]] || LAST=0
  if (( NOW_EPOCH - LAST < ALERT_REPEAT_MINUTES * 60 )); then
    SHOULD_SEND=0
    echo "(same alert already sent $(( (NOW_EPOCH - LAST) / 60 )) min ago - not repeating within ${ALERT_REPEAT_MINUTES} min)"
  fi
fi

if in_quiet_hours; then
  SHOULD_SEND=0
  echo "(quiet hours ${QUIET_HOURS} - not sending)"
fi

if [[ "$SHOULD_SEND" -eq 1 && -n "$ALERT_URL" ]]; then
  BODY=$(printf 'Frameo: %d frame problem(s) at %s\n\n%s\n\nFix: the frame keeps working over the public Funnel URL even when the tailnet is down.\nCheck the tablet watchdog log over adb or in Termux: tail -40 ~/.frameo/watchdog.log\n' \
    "$PROBLEMS" "$(date '+%Y-%m-%d %H:%M')" "$(printf '%s\n' "${ALERT_LINES[@]}")")
  if have curl && curl -fsS --max-time 10 \
      -H "Title: Frameo frame offline" \
      -H "Priority: high" \
      -H "Tags: warning" \
      -d "$BODY" "$ALERT_URL" >/dev/null 2>&1; then
    echo "$NOW_EPOCH" > "$STAMP"
    echo "alert sent to ${ALERT_URL}"
  else
    echo "WARNING: could not deliver the alert to ${ALERT_URL}" >&2
  fi
fi

exit 1
