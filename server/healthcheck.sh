#!/usr/bin/env bash
#
# healthcheck.sh - verify every moving part of the self-hosted Frameo replacement.
#
#   cd ~/frameo/server && ./healthcheck.sh
#
# Exit codes:
#   0  every check passed (warnings are allowed)
#   1  at least one check FAILED
#   2  the script could not run its checks at all (no docker, etc.)
#
# It is read-only: it starts nothing, stops nothing, restarts nothing. Safe to
# run from cron every few minutes and pipe into ntfy:
#
#   */5 * * * * ~/frameo/server/healthcheck.sh >/tmp/frameo-health.txt 2>&1 \
#        || curl -s -d "@/tmp/frameo-health.txt" https://ntfy.sh/<your-private-topic>
#
# Environment overrides:
#   FRAMEO_ROOT      default ~/frameo
#   FRAME_HOSTNAME   MagicDNS name; auto-detected from tailscale if unset
#   MEM_WARN_PCT     default 80   (per-container % of its own limit)
#   MEM_FAIL_PCT     default 95
#   DISK_MIN_FREE_PCT default 15
#   SKIP_IMMICH=1    treat a missing Immich as a warning instead of a failure

set -uo pipefail

FRAMEO_ROOT="${FRAMEO_ROOT:-$HOME/frameo}"
PROTECTED_CONTAINER="${PROTECTED_CONTAINER:-}"
SIGNALLING_CONTAINER="frameo-signalling"
SIGNALLING_LOCAL_PORT=8080
IMMICH_LOCAL_PORT=2283
MEM_WARN_PCT="${MEM_WARN_PCT:-80}"
MEM_FAIL_PCT="${MEM_FAIL_PCT:-95}"
DISK_MIN_FREE_PCT="${DISK_MIN_FREE_PCT:-15}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'
  C_YEL=$'\033[1;33m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BOLD=''
fi

FAILURES=0
WARNINGS=0
ROWS=()

have() { command -v "$1" >/dev/null 2>&1; }

# record <STATUS> <component> <detail>
record() {
  local status="$1" comp="$2" detail="$3"
  case "$status" in
    PASS) ;;
    WARN) WARNINGS=$((WARNINGS + 1)) ;;
    FAIL) FAILURES=$((FAILURES + 1)) ;;
  esac
  ROWS+=("${status}|${comp}|${detail}")
}

# Integer-ish compare helper for values like "12.34" -> 12, anything else -> 0
as_int() {
  local v="${1:-0}"
  if [[ "$v" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    printf '%.0f' "$v"
  else
    printf '0'
  fi
}

human_bytes() {
  local b="${1:-0}"
  if   (( b >= 1073741824 )); then awk -v b="$b" 'BEGIN{printf "%.2fG", b/1073741824}'
  elif (( b >= 1048576 ));    then awk -v b="$b" 'BEGIN{printf "%.0fM", b/1048576}'
  elif (( b >= 1024 ));       then awk -v b="$b" 'BEGIN{printf "%.0fK", b/1024}'
  else printf '%sB' "$b"
  fi
}

have docker || { echo "docker not found - cannot run health checks" >&2; exit 2; }

printf '%sFrameo stack health - %s on %s%s\n' \
  "$C_BOLD" "$(date '+%Y-%m-%d %H:%M:%S')" "$(hostname)" "$C_RESET"

# ===========================================================================
# 1. frame.slice
# ===========================================================================

if ! have systemctl; then
  record WARN "frame.slice" "systemctl unavailable - cannot verify"
elif systemctl is-active --quiet frame.slice 2>/dev/null; then
  MEM_CUR="$(systemctl show frame.slice -p MemoryCurrent --value 2>/dev/null)"
  MEM_HIGH="$(systemctl show frame.slice -p MemoryHigh --value 2>/dev/null)"
  MEM_MAX="$(systemctl show frame.slice -p MemoryMax --value 2>/dev/null)"
  TASKS_CUR="$(systemctl show frame.slice -p TasksCurrent --value 2>/dev/null)"
  TASKS_MAX="$(systemctl show frame.slice -p TasksMax --value 2>/dev/null)"

  [[ "$MEM_CUR" =~ ^[0-9]+$ ]] || MEM_CUR=0
  DETAIL="mem $(human_bytes "$MEM_CUR")"
  if [[ "$MEM_HIGH" =~ ^[0-9]+$ ]] && (( MEM_HIGH > 0 )); then
    PCT=$(( MEM_CUR * 100 / MEM_HIGH ))
    DETAIL="${DETAIL}/$(human_bytes "$MEM_HIGH") high (${PCT}%)"
  else
    DETAIL="${DETAIL} (MemoryHigh=${MEM_HIGH:-unset})"
    PCT=0
  fi
  [[ "$MEM_MAX" =~ ^[0-9]+$ ]] && DETAIL="${DETAIL}, max $(human_bytes "$MEM_MAX")"
  DETAIL="${DETAIL}, tasks ${TASKS_CUR:-?}/${TASKS_MAX:-?}"

  if (( PCT >= 95 )); then
    record FAIL "frame.slice" "$DETAIL - at the throttle ceiling"
  elif (( PCT >= 85 )); then
    record WARN "frame.slice" "$DETAIL - close to MemoryHigh"
  else
    record PASS "frame.slice" "$DETAIL"
  fi
else
  record FAIL "frame.slice" "not active (sudo systemctl start frame.slice)"
fi

# ===========================================================================
# 2. Containers: running, healthy, and inside their memory limit
# ===========================================================================

# Everything this project owns: our signalling container plus the Immich stack.
mapfile -t OUR_CONTAINERS < <(docker ps -a --format '{{.Names}}' 2>/dev/null \
                              | grep -E '^(frameo[-_]|immich)' | sort)

if [[ ${#OUR_CONTAINERS[@]} -eq 0 ]]; then
  record FAIL "containers" "no frameo/immich containers exist at all"
fi

# One docker stats call for all running containers (cheap, no --stream).
STATS="$(docker stats --no-stream --format '{{.Name}};{{.MemUsage}};{{.MemPerc}}' 2>/dev/null)"

for c in "${OUR_CONTAINERS[@]}"; do
  state="$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null || echo unknown)"
  oomed="$(docker inspect -f '{{.State.OOMKilled}}' "$c" 2>/dev/null || echo false)"
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' "$c" 2>/dev/null || echo -)"
  restarts="$(docker inspect -f '{{.RestartCount}}' "$c" 2>/dev/null || echo 0)"

  if [[ "$state" != "running" ]]; then
    record FAIL "container ${c}" "state=${state} restarts=${restarts}"
    continue
  fi

  line="$(grep -m1 "^${c};" <<<"$STATS")"
  memusage="${line#*;}"; memusage="${memusage%%;*}"
  mempct="${line##*;}"; mempct="${mempct%\%}"
  [[ -z "$line" ]] && { memusage="?"; mempct=0; }
  pct_i="$(as_int "$mempct")"

  detail="mem ${memusage} (${mempct}% of limit)"
  [[ "$health" != "-" ]] && detail="${detail}, health=${health}"
  [[ "$restarts" != "0" ]] && detail="${detail}, restarts=${restarts}"

  if [[ "$oomed" == "true" ]]; then
    record FAIL "container ${c}" "${detail} - WAS OOM-KILLED"
  elif [[ "$health" == "unhealthy" ]]; then
    record FAIL "container ${c}" "$detail"
  elif (( pct_i >= MEM_FAIL_PCT )); then
    record FAIL "container ${c}" "${detail} - over ${MEM_FAIL_PCT}% of its memory limit"
  elif (( pct_i >= MEM_WARN_PCT )); then
    record WARN "container ${c}" "$detail"
  else
    record PASS "container ${c}" "$detail"
  fi
done

# The signalling container specifically must exist.
if ! printf '%s\n' "${OUR_CONTAINERS[@]}" | grep -qx "$SIGNALLING_CONTAINER"; then
  record FAIL "container ${SIGNALLING_CONTAINER}" "container does not exist"
fi

# Verify our containers really landed inside frame.slice (a typo in
# cgroup_parent silently degrades to the default slice and loses containment).
for c in "${OUR_CONTAINERS[@]}"; do
  [[ "$(docker inspect -f '{{.State.Status}}' "$c" 2>/dev/null)" == "running" ]] || continue
  cgparent="$(docker inspect -f '{{.HostConfig.CgroupParent}}' "$c" 2>/dev/null)"
  if [[ "$cgparent" == "frame.slice" ]]; then
    record PASS "cgroup ${c}" "inside frame.slice"
  else
    record WARN "cgroup ${c}" "cgroup_parent='${cgparent:-<default>}' - NOT contained by frame.slice"
  fi
done

# ===========================================================================
# 3. Immich API
# ===========================================================================

immich_present=0
printf '%s\n' "${OUR_CONTAINERS[@]}" | grep -qi '^immich' && immich_present=1

if have curl; then
  if resp="$(curl -fsS --max-time 5 "http://127.0.0.1:${IMMICH_LOCAL_PORT}/api/server/ping" 2>/dev/null)" \
     || resp="$(curl -fsS --max-time 5 "http://127.0.0.1:${IMMICH_LOCAL_PORT}/api/server-info/ping" 2>/dev/null)"; then
    record PASS "immich api :${IMMICH_LOCAL_PORT}" "ping -> ${resp:0:40}"
  elif [[ "$immich_present" -eq 0 || "${SKIP_IMMICH:-0}" == "1" ]]; then
    record WARN "immich api :${IMMICH_LOCAL_PORT}" "not deployed on this host (skipped)"
  else
    record FAIL "immich api :${IMMICH_LOCAL_PORT}" "no response (docker logs immich-server)"
  fi
else
  record WARN "immich api :${IMMICH_LOCAL_PORT}" "curl not installed - cannot check"
fi

# ===========================================================================
# 4. Signalling API (host-local)
# ===========================================================================

if have curl; then
  if resp="$(curl -fsS --max-time 5 "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}/api/health" 2>/dev/null)"; then
    record PASS "signalling :${SIGNALLING_LOCAL_PORT}" "/api/health -> ${resp:0:60}"
  else
    record FAIL "signalling :${SIGNALLING_LOCAL_PORT}" "/api/health no response (docker logs ${SIGNALLING_CONTAINER})"
  fi
else
  record WARN "signalling :${SIGNALLING_LOCAL_PORT}" "curl not installed - cannot check"
fi

# ===========================================================================
# 4b. The photo feed the tablets actually read
# ===========================================================================
# A frame with an empty manifest and a cold cache shows the "repairing itself"
# screen, so this is worth checking explicitly rather than inferring it from
# "Immich is up".

# NOTE: /api/photos is authenticated as of the public-exposure change - an
# anonymous probe now correctly gets 401 and curl -f fails, which used to be
# reported as a hard FAIL even on a perfectly healthy stack. Probe it the same
# way a real tablet does, with the first frame's roster credentials.
_probe_frame_id=""; _probe_frame_token=""
if [[ -r "${FRAMEO_ROOT}/config/roster.json" ]] && have python3; then
  read -r _probe_frame_id _probe_frame_token < <(
    python3 - "${FRAMEO_ROOT}/config/roster.json" <<'PY' 2>/dev/null || true
import json, sys
try:
    peers = json.load(open(sys.argv[1])).get("peers", [])
except Exception:
    sys.exit(0)
for p in peers:
    if p.get("kind") == "frame" and p.get("authToken"):
        print(p["id"], p["authToken"]); break
PY
  )
fi

if have curl; then
  _photos_url="http://127.0.0.1:${SIGNALLING_LOCAL_PORT}/api/photos?limit=1"
  if [[ -n "$_probe_frame_id" && -n "$_probe_frame_token" ]]; then
    _photos_url="${_photos_url}&device=${_probe_frame_id}&token=${_probe_frame_token}"
  fi
  if photos="$(curl -fsS --max-time 8 "$_photos_url" 2>/dev/null)"; then
    total="$(sed -n 's/.*"total":[[:space:]]*\([0-9]*\).*/\1/p' <<<"$photos")"
    perr="$(sed -n 's/.*"error":[[:space:]]*"\([^"]*\)".*/\1/p' <<<"$photos")"
    if [[ -n "$perr" ]]; then
      record WARN "photo feed" "/api/photos -> ${total:-0} photos, error=${perr} (set IMMICH_API_KEY / IMMICH_ALBUM_IDS in .env)"
    elif [[ "${total:-0}" -gt 0 ]]; then
      record PASS "photo feed" "/api/photos -> ${total} photos available to the frames"
    else
      record WARN "photo feed" "/api/photos -> 0 photos (add images to the Immich album)"
    fi
  elif [[ -z "$_probe_frame_id" ]]; then
    record WARN "photo feed" "could not read a frame credential from ${FRAMEO_ROOT}/config/roster.json - cannot probe the authenticated feed"
  else
    record FAIL "photo feed" "/api/photos no response as ${_probe_frame_id} (docker logs ${SIGNALLING_CONTAINER})"
  fi
else
  record WARN "photo feed" "curl not installed - cannot check"
fi

# ===========================================================================
# 5. tailscale serve + the real HTTPS endpoint
# ===========================================================================

detect_ts_hostname() {
  local out
  if have jq; then
    out="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty')"
  else
    out="$(tailscale status --json 2>/dev/null | tr ',' '\n' \
            | sed -n 's/.*"DNSName" *: *"\([^"]*\)".*/\1/p' | head -1)"
  fi
  printf '%s' "${out%.}"
}

if ! have tailscale; then
  record FAIL "tailscale serve" "tailscale CLI not installed"
else
  SERVE_STATUS="$(tailscale serve status 2>/dev/null || sudo -n tailscale serve status 2>/dev/null || true)"
  if [[ -z "$SERVE_STATUS" ]]; then
    record FAIL "tailscale serve" "no serve configuration (run deploy.sh)"
  elif grep -q "127.0.0.1:${SIGNALLING_LOCAL_PORT}\|localhost:${SIGNALLING_LOCAL_PORT}" <<<"$SERVE_STATUS"; then
    record PASS "tailscale serve" "https/443 -> 127.0.0.1:${SIGNALLING_LOCAL_PORT} (auto-renewing cert)"
  else
    record FAIL "tailscale serve" "configured, but not proxying to 127.0.0.1:${SIGNALLING_LOCAL_PORT}"
  fi

  FRAME_HOSTNAME="${FRAME_HOSTNAME:-$(detect_ts_hostname)}"
  if [[ -z "$FRAME_HOSTNAME" ]]; then
    record FAIL "https endpoint" "cannot determine this node's MagicDNS name"
  elif ! have curl; then
    record WARN "https endpoint" "curl not installed - cannot check"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${FRAME_HOSTNAME}/api/health" 2>/dev/null)"
    if [[ "$code" == "200" ]]; then
      # How long is the certificate still valid? An expired cert silently kills
      # getUserMedia (camera) on the tablets, so surface it early.
      exp=""
      if have openssl; then
        exp="$(echo | openssl s_client -connect "${FRAME_HOSTNAME}:443" -servername "$FRAME_HOSTNAME" 2>/dev/null \
               | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
      fi
      record PASS "https endpoint" "https://${FRAME_HOSTNAME}/api/health -> 200${exp:+, cert until ${exp}}"
    else
      record FAIL "https endpoint" "https://${FRAME_HOSTNAME}/api/health -> HTTP ${code:-no-response}"
    fi
  fi
fi

# ===========================================================================
# 6. Disk
# ===========================================================================

DISK_LINE="$(df -P / | awk 'NR==2 {print $5" "$4}')"
USED_PCT="${DISK_LINE%%%*}"
AVAIL_KB="${DISK_LINE##* }"
FREE_PCT=$(( 100 - USED_PCT ))
AVAIL_H="$(df -Ph / | awk 'NR==2 {print $4}')"

if (( FREE_PCT < DISK_MIN_FREE_PCT )); then
  record FAIL "disk /" "${FREE_PCT}% free (${AVAIL_H}) - below the ${DISK_MIN_FREE_PCT}% floor"
elif (( FREE_PCT < DISK_MIN_FREE_PCT + 10 )); then
  record WARN "disk /" "${FREE_PCT}% free (${AVAIL_H}) - approaching the floor"
else
  record PASS "disk /" "${FREE_PCT}% free (${AVAIL_H})"
fi

if [[ -d "${FRAMEO_ROOT}/data" ]]; then
  record PASS "data dir" "${FRAMEO_ROOT}/data uses $(du -sh "${FRAMEO_ROOT}/data" 2>/dev/null | cut -f1 || echo '?')"
else
  record FAIL "data dir" "${FRAMEO_ROOT}/data missing"
fi

# ===========================================================================
# 7. Optional: a neighbouring container (PROTECTED_CONTAINER) must still run
# ===========================================================================

if [[ -n "$PROTECTED_CONTAINER" ]]; then
  px_state="$(docker inspect -f '{{.State.Status}}' "$PROTECTED_CONTAINER" 2>/dev/null || echo missing)"
  if [[ "$px_state" == "running" ]]; then
    px_since="$(docker inspect -f '{{.State.StartedAt}}' "$PROTECTED_CONTAINER" 2>/dev/null)"
    record PASS "${PROTECTED_CONTAINER}" "running since ${px_since}"
  elif [[ "$px_state" == "missing" ]]; then
    record FAIL "${PROTECTED_CONTAINER}" "container is gone - investigate"
  else
    record FAIL "${PROTECTED_CONTAINER}" "state=${px_state} - start it: docker start ${PROTECTED_CONTAINER}"
  fi
fi

# ===========================================================================
# Table
# ===========================================================================

printf '\n'
printf '%-6s  %-28s  %s\n' "STATUS" "COMPONENT" "DETAIL"
printf -- '------  ----------------------------  --------------------------------------------------\n'
for row in "${ROWS[@]}"; do
  st="${row%%|*}"; rest="${row#*|}"
  comp="${rest%%|*}"; detail="${rest#*|}"
  case "$st" in
    PASS) col="$C_GRN" ;;
    WARN) col="$C_YEL" ;;
    *)    col="$C_RED" ;;
  esac
  printf '%s%-6s%s  %-28s  %s\n' "$col" "$st" "$C_RESET" "$comp" "$detail"
done

TOTAL=${#ROWS[@]}
PASSED=$(( TOTAL - FAILURES - WARNINGS ))
printf -- '------  ----------------------------  --------------------------------------------------\n'
printf '%d checks: %s%d passed%s, %s%d warnings%s, %s%d failed%s\n' \
  "$TOTAL" "$C_GRN" "$PASSED" "$C_RESET" "$C_YEL" "$WARNINGS" "$C_RESET" "$C_RED" "$FAILURES" "$C_RESET"

if (( FAILURES > 0 )); then
  printf '\n%sRESULT: FAIL%s\n' "$C_RED" "$C_RESET"
  exit 1
fi
printf '\n%sRESULT: PASS%s\n' "$C_GRN" "$C_RESET"
exit 0
