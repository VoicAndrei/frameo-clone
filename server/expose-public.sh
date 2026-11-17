#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# expose-public.sh  --  publish the frameo stack on the public internet with
#                       Tailscale Funnel, and publish coturn beside it.
#
#   cd ~/frameo/server && ./expose-public.sh
#
# It configures exactly two ingress mappings and nothing else:
#
#   https://<node>.<tailnet>.ts.net/            (TCP 443)
#        -> tailscaled terminates TLS -> http://127.0.0.1:8080   (signalling + web app)
#
#   turns:<node>.<tailnet>.ts.net:10000?transport=tcp
#        -> tailscaled terminates TLS -> tcp://127.0.0.1:3478    (coturn)
#
# No router configuration. No port forwarding. No second TLS terminator. No
# certificate files on disk: tailscaled owns the Let's Encrypt certificate and
# renews it by itself, which is why README-ops.md's "never run tailscale cert"
# rule still stands.
#
# IDEMPOTENT. Re-running it on an already-configured node is a no-op that
# re-verifies and re-prints the URLs. Safe to run at 3am when you cannot
# remember whether you already ran it.
#
# Usage:
#   ./expose-public.sh              enable both mappings, verify, print URLs
#   ./expose-public.sh --status     show what is configured, change nothing
#   ./expose-public.sh --off        remove both mappings and restore the
#                                   tailnet-only `tailscale serve` on 443
#   ./expose-public.sh --skip-turn  configure only the 443 web mapping
#   ./expose-public.sh --force-turn configure 10000 even if coturn is not
#                                   answering on 127.0.0.1:3478 yet
#
# Environment overrides:
#   FRAME_HOSTNAME          MagicDNS name; auto-detected when unset
#   SIGNALLING_LOCAL_PORT   default 8080
#   TURN_LOCAL_PORT         default 3478
#   FUNNEL_TURN_PORT        default 10000   (Funnel allows only 443/8443/10000)
#   PROTECTED_CONTAINER=name  optional neighbouring container to check before/after
#   ALLOW_PROTECTED_DOWN=1  proceed even though PROTECTED_CONTAINER is not running
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

SIGNALLING_LOCAL_PORT="${SIGNALLING_LOCAL_PORT:-8080}"
TURN_LOCAL_PORT="${TURN_LOCAL_PORT:-3478}"
FUNNEL_WEB_PORT=443
FUNNEL_TURN_PORT="${FUNNEL_TURN_PORT:-10000}"
PROTECTED_CONTAINER="${PROTECTED_CONTAINER:-}"
COTURN_CONTAINER="frameo-coturn"

MODE="enable"
SKIP_TURN=0
FORCE_TURN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status)     MODE="status" ;;
    --off)        MODE="off" ;;
    --skip-turn)  SKIP_TURN=1 ;;
    --force-turn) FORCE_TURN=1 ;;
    -h|--help)    sed -n '3,39p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            printf 'Unknown argument: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

# --------------------------------------------------------------------------
# 0. Output helpers  (same shape as deploy.sh so the logs read alike)
# --------------------------------------------------------------------------

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'
  C_YEL=$'\033[1;33m'; C_BLU=$'\033[1;34m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BOLD=''
fi

_ts()  { date '+%Y-%m-%d %H:%M:%S'; }
log()  { printf '%s [%sINFO%s ] %s\n' "$(_ts)" "$C_BLU" "$C_RESET" "$*"; }
ok()   { printf '%s [%s OK %s ] %s\n' "$(_ts)" "$C_GRN" "$C_RESET" "$*"; }
warn() { printf '%s [%sWARN%s ] %s\n' "$(_ts)" "$C_YEL" "$C_RESET" "$*" >&2; }
err()  { printf '%s [%sFAIL%s ] %s\n' "$(_ts)" "$C_RED" "$C_RESET" "$*" >&2; }
step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
die()  { err "$*"; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --------------------------------------------------------------------------
# 1. The optional safety guard around PROTECTED_CONTAINER
# --------------------------------------------------------------------------
# This script runs no docker commands at all - it only talks to the tailscale
# CLI - so it has no mechanism by which it could disturb another container. The
# guard is here anyway (when PROTECTED_CONTAINER is set), for two reasons: every
# script in this directory gives the same contract, and if that container HAS
# gone away, that is news worth stopping for before making the box reachable
# from the internet.

protected_snapshot() {
  docker inspect \
    --format '{{.Id}}|{{.State.Running}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.RestartCount}}' \
    "$PROTECTED_CONTAINER" 2>/dev/null || echo "MISSING"
}
dockerd_pid() { systemctl show docker.service -p MainPID --value 2>/dev/null || echo "unknown"; }

PROTECTED_BEFORE=""
DOCKERD_PID_BEFORE=""
GUARD_ARMED=0

verify_protected_container() {
  local phase="$1" now running dpid_now
  now="$(protected_snapshot)"

  if [[ "$now" == "MISSING" ]]; then
    err "Container '${PROTECTED_CONTAINER}' does not exist (checked ${phase})."
    return 1
  fi
  if [[ -n "$PROTECTED_BEFORE" && "$now" != "$PROTECTED_BEFORE" ]]; then
    printf '\n%s' "$C_RED"
    printf '################################################################\n'
    printf '#  SAFETY VIOLATION - PROTECTED CONTAINER WAS AFFECTED         #\n'
    printf '################################################################%s\n' "$C_RESET"
    err "Container '${PROTECTED_CONTAINER}' CHANGED while this script ran (${phase})."
    err "  before: ${PROTECTED_BEFORE}"
    err "  now   : ${now}"
    err "Fields are: Id|Running|Pid|StartedAt|RestartCount."
    err "Nothing in this script touches docker, so something ELSE did it. Investigate."
    return 1
  fi
  running="$(cut -d'|' -f2 <<<"$now")"
  if [[ "$running" != "true" ]]; then
    err "Container '${PROTECTED_CONTAINER}' is not running (checked ${phase})."
    return 1
  fi
  dpid_now="$(dockerd_pid)"
  if [[ -n "$DOCKERD_PID_BEFORE" && "$dpid_now" != "$DOCKERD_PID_BEFORE" ]]; then
    err "The Docker daemon restarted while this script ran (MainPID ${DOCKERD_PID_BEFORE} -> ${dpid_now})."
    return 1
  fi
  return 0
}

GUARD_RESULT=0
on_exit() {
  local rc=$?
  if [[ "$GUARD_ARMED" -eq 1 ]]; then
    if ! verify_protected_container "after"; then
      GUARD_RESULT=1
    else
      ok "Protected container '${PROTECTED_CONTAINER}' untouched."
    fi
  fi
  [[ "$GUARD_RESULT" -ne 0 ]] && exit 90
  exit "$rc"
}

step "Safety guard"
if [[ -z "$PROTECTED_CONTAINER" ]]; then
  ok "No PROTECTED_CONTAINER set; skipping the neighbour check."
elif ! have docker; then
  warn "docker CLI not found - cannot check on '${PROTECTED_CONTAINER}'. Continuing (this script does not use docker)."
else
  PROTECTED_BEFORE="$(protected_snapshot)"
  DOCKERD_PID_BEFORE="$(dockerd_pid)"
  if ! verify_protected_container "before"; then
    if [[ "${ALLOW_PROTECTED_DOWN:-0}" == "1" ]]; then
      warn "ALLOW_PROTECTED_DOWN=1 - continuing with the guard DISABLED."
      PROTECTED_BEFORE=""
    else
      err ""
      err "Refusing to run. Bring it back with:  docker start ${PROTECTED_CONTAINER}"
      err "If you stopped it on purpose, re-run as:  ALLOW_PROTECTED_DOWN=1 $0"
      exit 1
    fi
  else
    ok "'${PROTECTED_CONTAINER}' running and healthy; dockerd MainPID ${DOCKERD_PID_BEFORE}."
    GUARD_ARMED=1
    trap on_exit EXIT
  fi
fi

# --------------------------------------------------------------------------
# 2. Tailscale preflight
# --------------------------------------------------------------------------

step "Tailscale preflight"

have tailscale || die "The tailscale CLI is not installed. Funnel is the ONLY public ingress this design has."

# `tailscale serve`/`funnel` need root, or a user mapped with
# `tailscale set --operator=<user>`. Try unprivileged first so a normal run
# does not demand a password it does not need.
TS="tailscale"
if ! tailscale serve status >/dev/null 2>&1; then
  if [[ "$(id -u)" -ne 0 ]] && have sudo && sudo -n true 2>/dev/null && sudo tailscale serve status >/dev/null 2>&1; then
    TS="sudo tailscale"
    log "using sudo for the tailscale CLI"
  elif [[ "$(id -u)" -ne 0 ]] && have sudo && sudo tailscale serve status >/dev/null 2>&1; then
    TS="sudo tailscale"
    log "using sudo for the tailscale CLI (tip: 'sudo tailscale set --operator=\$USER' removes the prompt)"
  else
    die "Cannot run 'tailscale serve status'. Is tailscaled running and this node logged in? Try: sudo tailscale status"
  fi
fi

BACKEND_STATE="$(tailscale status --json 2>/dev/null | sed -n 's/.*"BackendState"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
[[ -z "$BACKEND_STATE" || "$BACKEND_STATE" == "Running" ]] \
  || die "tailscaled BackendState is '${BACKEND_STATE}', not 'Running'. Fix the tailnet first."

detect_hostname() {
  local out
  if have jq; then
    out="$(tailscale status --json 2>/dev/null | jq -r '.Self.DNSName // empty')"
  fi
  if [[ -z "${out:-}" ]]; then
    out="$(tailscale status --json 2>/dev/null \
            | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  fi
  printf '%s' "${out%.}"
}

FRAME_HOSTNAME="${FRAME_HOSTNAME:-$(detect_hostname)}"
[[ -n "$FRAME_HOSTNAME" ]] \
  || die "Could not determine this node's MagicDNS name. Set FRAME_HOSTNAME=... and re-run."
[[ "$FRAME_HOSTNAME" == *.ts.net ]] \
  || die "FRAME_HOSTNAME='${FRAME_HOSTNAME}' is not a *.ts.net name. Funnel can only serve names in the tailnet's own domain."

TS_TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"

ok "node: ${FRAME_HOSTNAME}${TS_TAILNET_IP:+  (tailnet IPv4 ${TS_TAILNET_IP})}"

PUBLIC_URL="https://${FRAME_HOSTNAME}"
TURN_URL="turns:${FRAME_HOSTNAME}:${FUNNEL_TURN_PORT}?transport=tcp"

# --------------------------------------------------------------------------
# 3. Status view (used by --status, and printed at the end of every run)
# --------------------------------------------------------------------------

serve_json() { $TS serve status --json 2>/dev/null || echo '{}'; }

# Is Funnel already on for <host>:<port>?
funnel_on_for() {
  local port="$1" json
  json="$(serve_json)"
  if have jq; then
    [[ "$(jq -r --arg k "${FRAME_HOSTNAME}:${port}" '.AllowFunnel[$k] // false' <<<"$json")" == "true" ]]
  else
    grep -q "\"${FRAME_HOSTNAME}:${port}\"[[:space:]]*:[[:space:]]*true" <<<"$json"
  fi
}

print_status() {
  step "Current ingress configuration"
  printf '%s--- tailscale serve status ---%s\n' "$C_BOLD" "$C_RESET"
  $TS serve status 2>&1 | sed 's/^/    /' || true
  printf '%s--- tailscale funnel status ---%s\n' "$C_BOLD" "$C_RESET"
  $TS funnel status 2>&1 | sed 's/^/    /' || true
}

if [[ "$MODE" == "status" ]]; then
  print_status
  step "Summary"
  funnel_on_for "$FUNNEL_WEB_PORT"  && ok "web  443   : PUBLIC"   || warn "web  443   : not funnelled"
  funnel_on_for "$FUNNEL_TURN_PORT" && ok "turn ${FUNNEL_TURN_PORT} : PUBLIC" || warn "turn ${FUNNEL_TURN_PORT} : not funnelled"
  exit 0
fi

# --------------------------------------------------------------------------
# 4. --off : take it back off the internet
# --------------------------------------------------------------------------

if [[ "$MODE" == "off" ]]; then
  step "Removing public ingress"

  # Funnel mappings are removed with the same command plus a trailing `off`.
  $TS funnel --https="${FUNNEL_WEB_PORT}" "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}" off >/dev/null 2>&1 \
    && ok "funnel https/${FUNNEL_WEB_PORT} removed" \
    || warn "funnel https/${FUNNEL_WEB_PORT} was not configured (or the CLI refused); continuing"

  $TS funnel --tls-terminated-tcp="${FUNNEL_TURN_PORT}" "tcp://127.0.0.1:${TURN_LOCAL_PORT}" off >/dev/null 2>&1 \
    && ok "funnel tcp/${FUNNEL_TURN_PORT} removed" \
    || warn "funnel tcp/${FUNNEL_TURN_PORT} was not configured (or the CLI refused); continuing"

  step "Restoring tailnet-only HTTPS on 443"
  # Without this the tablets lose their URL entirely, which is a far worse
  # outage than being publicly reachable.
  if $TS serve --bg --yes --https="${FUNNEL_WEB_PORT}" "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}" >/dev/null 2>&1 \
     || $TS serve --bg --https="${FUNNEL_WEB_PORT}" "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}" >/dev/null 2>&1; then
    ok "tailscale serve --bg --https=443 -> 127.0.0.1:${SIGNALLING_LOCAL_PORT}  (tailnet only)"
  else
    err "Could not restore 'tailscale serve' on 443. The tablets are now WITHOUT a URL."
    err "Run this by hand and do not go to bed until it succeeds:"
    err "    sudo tailscale serve --bg --https=443 http://127.0.0.1:${SIGNALLING_LOCAL_PORT}"
    exit 1
  fi

  print_status
  step "Done"
  ok "The stack is back to tailnet-only. Phones on mobile data can no longer reach it."
  log "coturn is still running and still reachable from the tailnet; that is harmless."
  log "To also stop it:  docker compose -f ${SCRIPT_DIR}/docker-compose.turn.yml down"
  exit 0
fi

# --------------------------------------------------------------------------
# 5. Backend preflight - never funnel a dead port
# --------------------------------------------------------------------------
# A Funnel mapping to a port nothing is listening on does not fail loudly; it
# produces a TLS endpoint that accepts connections and then hangs. That is the
# single most confusing failure mode available here, so we check first.

step "Backend preflight"

tcp_open() {
  local host="$1" port="$2"
  timeout 3 bash -c "exec 3<>/dev/tcp/${host}/${port}" 2>/dev/null
}

if tcp_open 127.0.0.1 "$SIGNALLING_LOCAL_PORT"; then
  ok "signalling server is listening on 127.0.0.1:${SIGNALLING_LOCAL_PORT}"
else
  die "Nothing is listening on 127.0.0.1:${SIGNALLING_LOCAL_PORT}. Start it first: ./deploy.sh"
fi

TURN_READY=0
if tcp_open 127.0.0.1 "$TURN_LOCAL_PORT"; then
  TURN_READY=1
  ok "coturn is listening on 127.0.0.1:${TURN_LOCAL_PORT}"
elif [[ "$SKIP_TURN" -eq 1 ]]; then
  log "coturn not reachable, and --skip-turn was given anyway."
elif [[ "$FORCE_TURN" -eq 1 ]]; then
  warn "coturn is NOT listening on 127.0.0.1:${TURN_LOCAL_PORT}, but --force-turn was given."
else
  err "coturn is not listening on 127.0.0.1:${TURN_LOCAL_PORT}."
  err "Start it first:"
  err "    ${SCRIPT_DIR}/render-turnserver-conf.sh"
  err "    docker compose -f ${SCRIPT_DIR}/docker-compose.turn.yml up -d"
  err "    docker logs ${COTURN_CONTAINER} 2>&1 | grep -i 'listener opened'"
  err "Then re-run this script. (Or run it with --skip-turn to publish only the web app,"
  err "which means calls work only when ICE finds a direct path.)"
  exit 1
fi

# --------------------------------------------------------------------------
# 6. Enable Funnel
# --------------------------------------------------------------------------

acl_help() {
  cat >&2 <<EOF

${C_BOLD}Funnel is not enabled on this tailnet.${C_RESET}

The CLI flag cannot grant it: the capability comes from the tailnet policy file.
Open  https://login.tailscale.com/admin/acls  and add the ${C_BOLD}nodeAttrs${C_RESET} block below
(append to the existing "nodeAttrs" array if there already is one):

    "nodeAttrs": [
      {
        "target": ["autogroup:member"],
        "attr":   ["funnel"]
      }
    ]

The admin console also has a one-click version: Access controls -> Funnel ->
"Add Funnel to policy", which inserts exactly that.

Two other prerequisites, both already true on this node but worth knowing:
  * DNS -> HTTPS Certificates must be enabled for the tailnet.
  * MagicDNS must be on.

Save the policy file, then re-run this script. Nothing has been changed.
EOF
}

run_funnel() {
  # $1 = human label, rest = arguments after `tailscale funnel`
  local label="$1"; shift
  local errfile out rc
  errfile="$(mktemp)"
  set +e
  out="$($TS funnel "$@" 2>"$errfile")"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    if grep -qiE 'funnel (is )?not (enabled|available)|node attribute|nodeattrs|not allowed to use funnel|HTTPS is disabled' "$errfile"; then
      err "${label}: refused by the tailnet policy."
      acl_help
      rm -f "$errfile"
      exit 1
    fi
    err "${label} failed:"
    sed 's/^/        /' "$errfile" >&2
    rm -f "$errfile"
    exit 1
  fi
  [[ -n "$out" ]] && printf '%s\n' "$out" | sed 's/^/    /'
  rm -f "$errfile"
  ok "$label"
}

step "Publishing the web app on https://${FRAME_HOSTNAME}/ (TCP ${FUNNEL_WEB_PORT})"

# Serve and Funnel cannot both own a port. Remove the tailnet-only mapping
# first; it is not an error if it was never there.
if $TS serve --https="${FUNNEL_WEB_PORT}" "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}" off >/dev/null 2>&1; then
  log "removed the previous tailnet-only 'serve' mapping on ${FUNNEL_WEB_PORT}"
else
  log "no tailnet-only 'serve' mapping on ${FUNNEL_WEB_PORT} to remove"
fi

# --bg  : persist into tailscaled's state, so it survives reboots
# --yes : skip the interactive first-run consent prompt (the ACL attribute is
#         still required; --yes does not grant anything)
run_funnel "funnel https/${FUNNEL_WEB_PORT} -> http://127.0.0.1:${SIGNALLING_LOCAL_PORT}" \
  --bg --yes --https="${FUNNEL_WEB_PORT}" "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}"

if [[ "$SKIP_TURN" -eq 0 ]]; then
  step "Publishing coturn on ${TURN_URL} (TCP ${FUNNEL_TURN_PORT})"
  # --tls-terminated-tcp, NOT --tcp: tailscaled terminates TLS with the node's
  # certificate and hands coturn plain TCP, so coturn needs no certificate of
  # its own and no renewal mechanism.
  #
  # Do NOT add --proxy-protocol here. coturn does not speak the PROXY protocol
  # and would read the header as a malformed STUN message.
  run_funnel "funnel tls-terminated-tcp/${FUNNEL_TURN_PORT} -> tcp://127.0.0.1:${TURN_LOCAL_PORT}" \
    --bg --yes --tls-terminated-tcp="${FUNNEL_TURN_PORT}" "tcp://127.0.0.1:${TURN_LOCAL_PORT}"
else
  warn "--skip-turn: coturn is NOT published. Calls will work only over a direct ICE path."
fi

# --------------------------------------------------------------------------
# 7. Verify
# --------------------------------------------------------------------------

step "Verification"

VERIFY_FAILED=0

if funnel_on_for "$FUNNEL_WEB_PORT"; then
  ok "AllowFunnel is set for ${FRAME_HOSTNAME}:${FUNNEL_WEB_PORT}"
else
  warn "Could not confirm AllowFunnel for ${FRAME_HOSTNAME}:${FUNNEL_WEB_PORT} from 'serve status --json'."
  VERIFY_FAILED=1
fi

if [[ "$SKIP_TURN" -eq 0 ]]; then
  if funnel_on_for "$FUNNEL_TURN_PORT"; then
    ok "AllowFunnel is set for ${FRAME_HOSTNAME}:${FUNNEL_TURN_PORT}"
  else
    warn "Could not confirm AllowFunnel for ${FRAME_HOSTNAME}:${FUNNEL_TURN_PORT}."
    VERIFY_FAILED=1
  fi
fi

# The certificate can take ~30s to be issued the very first time.
if have curl; then
  for attempt in 1 2 3 4 5 6; do
    if curl -fsS --max-time 10 "${PUBLIC_URL}/api/health" >/dev/null 2>&1; then
      ok "GET ${PUBLIC_URL}/api/health answered over TLS"
      break
    fi
    if [[ $attempt -eq 6 ]]; then
      warn "${PUBLIC_URL}/api/health did not answer after 6 tries."
      warn "The first request also triggers certificate issuance; give it a minute and retry."
      VERIFY_FAILED=1
    else
      sleep 10
    fi
  done
else
  warn "curl not installed - skipping the HTTPS check."
fi

if [[ "$SKIP_TURN" -eq 0 && "$TURN_READY" -eq 1 ]] && have openssl; then
  if openssl s_client -connect "${FRAME_HOSTNAME}:${FUNNEL_TURN_PORT}" \
        -servername "${FRAME_HOSTNAME}" -verify_return_error </dev/null 2>/dev/null \
        | grep -q 'Verify return code: 0'; then
    ok "TLS handshake to ${FRAME_HOSTNAME}:${FUNNEL_TURN_PORT} succeeded with a valid certificate"
  else
    warn "TLS handshake to ${FRAME_HOSTNAME}:${FUNNEL_TURN_PORT} did not verify."
    warn "If 443 works, this is usually just the ingress needing a moment. Retry:"
    warn "    openssl s_client -connect ${FRAME_HOSTNAME}:${FUNNEL_TURN_PORT} -servername ${FRAME_HOSTNAME}"
    VERIFY_FAILED=1
  fi
fi

print_status

# --------------------------------------------------------------------------
# 8. Tell the operator exactly what to do next
# --------------------------------------------------------------------------

step "Public URLs"
printf '\n'
printf '  %sWeb app  %s %s/\n' "$C_BOLD" "$C_RESET" "$PUBLIC_URL"
printf '  %sLogin    %s %s/login\n' "$C_BOLD" "$C_RESET" "$PUBLIC_URL"
printf '  %sWebSocket%s wss://%s/ws\n' "$C_BOLD" "$C_RESET" "$FRAME_HOSTNAME"
if [[ "$SKIP_TURN" -eq 0 ]]; then
  printf '  %sTURN     %s %s\n' "$C_BOLD" "$C_RESET" "$TURN_URL"
fi
printf '\n'
printf '  These work from ANY network. The tablets keep using the same URL and stay on\n'
printf '  the tailnet path, so their traffic does not go through the public ingress.\n'
printf '\n'

step "Put these in ${SCRIPT_DIR}/.env (then restart frameo-signalling)"
printf '\n'
printf '    PUBLIC_ORIGIN=%s\n' "$PUBLIC_URL"
printf '    TURN_PUBLIC_URL=%s\n' "$TURN_URL"
if [[ -n "$TS_TAILNET_IP" ]]; then
  printf '    TURN_TAILNET_URL=turn:%s:%s?transport=udp,turn:%s:%s?transport=tcp\n' \
    "$TS_TAILNET_IP" "$TURN_LOCAL_PORT" "$TS_TAILNET_IP" "$TURN_LOCAL_PORT"
  printf '    TS_TAILNET_IP=%s\n' "$TS_TAILNET_IP"
fi
printf '\n'
printf '  The signalling server hands these to clients from GET /api/ice; it does not\n'
printf '  read the tailscale CLI, so a stale value here means broken calls with a\n'
printf '  perfectly healthy funnel.\n'
printf '\n'

step "Verify from a phone on MOBILE DATA (not the home Wi-Fi, not the tailnet)"
cat <<EOF

    1.  ${PUBLIC_URL}/                  -> the login page, NOT the photo app
    2.  ${PUBLIC_URL}/api/photos        -> 401
    3.  ${PUBLIC_URL}/api/health        -> {"ok":true} and nothing else
    4.  log in, then GET /api/ice       -> two iceServers entries
    5.  paste the turns: URL and the minted username/credential into
        https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
        and confirm a candidate of type "relay" appears.

To take all of this back off the internet:

    ${SCRIPT_DIR}/expose-public.sh --off

EOF

if [[ "$VERIFY_FAILED" -ne 0 ]]; then
  warn "One or more verification steps did not pass - read the warnings above before walking away."
  exit 3
fi

ok "Public exposure configured."
