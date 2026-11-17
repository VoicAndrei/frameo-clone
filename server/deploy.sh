#!/usr/bin/env bash
#
# deploy.sh - idempotent deployment of the self-hosted Frameo replacement.
#
# RUN THIS ON THE SERVER (any 24/7 Linux box with Docker), as the user that
# should own the data, from the repo's server/ directory:
#
#     cd ~/frameo/server && ./deploy.sh
#
# It is safe to re-run any number of times. Every step checks the desired state
# first and does nothing if it is already satisfied.
#
# ---------------------------------------------------------------------------
# SHARING THE BOX WITH OTHER SERVICES
# ---------------------------------------------------------------------------
# The stack is designed to live next to unrelated containers without
# disturbing them:
#
#   * We NEVER restart, reload or otherwise poke the Docker daemon.
#   * We NEVER write /etc/docker/daemon.json (that is what would force a
#     daemon restart). Containment is done with per-service
#     `cgroup_parent: frame.slice` inside the compose files instead.
#   * We NEVER run `docker system prune`, `docker volume prune`,
#     `docker network prune`, `docker image prune -a` or `compose down
#     --remove-orphans` - each of those can reach outside our own stacks.
#   * Optionally, set PROTECTED_CONTAINER to the name of a container you care
#     about. Its id + PID + start time are snapshotted BEFORE doing anything
#     and re-verified on every exit path, including failures and Ctrl-C. Any
#     change is a loud, non-zero-exit failure. The Docker daemon PID is always
#     checked the same way.
#
# ---------------------------------------------------------------------------
# Environment overrides (all optional):
#   FRAMEO_USER      owner of the data directories; default: the invoking user
#                    (or $SUDO_USER when run through sudo)
#   FRAMEO_ROOT      default <FRAMEO_USER's home>/frameo
#   FRAME_HOSTNAME   MagicDNS name; auto-detected from tailscale if unset
#   SKIP_TAILSCALE=1 skip the `tailscale serve` step
#   SKIP_IMMICH=1    skip the Immich stack even if its compose file exists
#   PROTECTED_CONTAINER=name
#                    a neighbouring container this deploy must not disturb
#   ALLOW_PROTECTED_DOWN=1
#                    proceed even if PROTECTED_CONTAINER is not running
# ---------------------------------------------------------------------------

set -euo pipefail

# --------------------------------------------------------------------------
# 0. Constants and small helpers
# --------------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Exported: docker compose interpolates ${FRAMEO_ROOT} in the signalling stack's
# bind mounts, and a plain (non-exported) shell variable would not reach it.
FRAMEO_USER="${FRAMEO_USER:-${SUDO_USER:-$(id -un)}}"
FRAMEO_HOME="$(getent passwd "$FRAMEO_USER" | cut -d: -f6)"
[[ -n "$FRAMEO_HOME" ]] || { echo "FRAMEO_USER '${FRAMEO_USER}' does not exist." >&2; exit 1; }
export FRAMEO_ROOT="${FRAMEO_ROOT:-${FRAMEO_HOME}/frameo}"
# Exported for the compose files: the containers run as this uid/gid so the
# bind-mounted config and log directories are writable without chmod 777.
export FRAMEO_UID="$(id -u "$FRAMEO_USER")"
export FRAMEO_GID="$(id -g "$FRAMEO_USER")"
FRAMEO_NETWORK="frameo"
PROTECTED_CONTAINER="${PROTECTED_CONTAINER:-}"

COMPOSE_SIGNALLING="${SCRIPT_DIR}/docker-compose.signalling.yml"
COMPOSE_IMMICH="${SCRIPT_DIR}/docker-compose.immich.yml"
SLICE_SRC="${SCRIPT_DIR}/frame.slice"
SLICE_DST="/etc/systemd/system/frame.slice"

SIGNALLING_LOCAL_PORT=8080
IMMICH_LOCAL_PORT=2283

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'
  C_YEL=$'\033[1;33m'; C_BLU=$'\033[1;34m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_BOLD=''
fi

_ts() { date '+%Y-%m-%d %H:%M:%S'; }
log()   { printf '%s [%sINFO%s ] %s\n'  "$(_ts)" "$C_BLU" "$C_RESET" "$*"; }
ok()    { printf '%s [%s OK %s ] %s\n'  "$(_ts)" "$C_GRN" "$C_RESET" "$*"; }
warn()  { printf '%s [%sWARN%s ] %s\n'  "$(_ts)" "$C_YEL" "$C_RESET" "$*" >&2; }
err()   { printf '%s [%sFAIL%s ] %s\n'  "$(_ts)" "$C_RED" "$C_RESET" "$*" >&2; }
step()  { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_RESET"; }
die()   { err "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# sudo wrapper: no-op when already root, hard failure when sudo is missing.
if [[ "$(id -u)" -eq 0 ]]; then
  SUDO=""
else
  have sudo || die "This script needs sudo for the systemd slice install, and sudo was not found."
  SUDO="sudo"
fi

# Privileged-op wrapper for things we USUALLY already have permission to do.
#
# chown/chmod under ${FRAMEO_ROOT} normally succeed unprivileged, because the
# project user already owns that tree. Calling `sudo` unconditionally makes the
# whole deploy require a TTY for a password prompt even when nothing actually
# needs root -- which breaks non-interactive/remote runs. So: attempt the
# operation as ourselves first and only escalate if it genuinely fails.
#
# Note this is deliberately NOT used for the operations that truly require root
# (installing the unit into /etc/systemd/system, systemctl, tailscale serve) --
# those still call $SUDO directly and will still prompt, as they must.
maybe_sudo() {
  if "$@" 2>/dev/null; then
    return 0
  fi
  $SUDO "$@"
}

# Run a command as the project user, whether we are root, that user, or someone
# else with sudo. (`$SUDO -u user ...` would break when $SUDO is empty.)
as_frameo_user() {
  if [[ "$(id -un)" == "${FRAMEO_USER}" ]]; then
    "$@"
  else
    sudo -u "${FRAMEO_USER}" "$@"
  fi
}

# --------------------------------------------------------------------------
# 1. THE OPTIONAL SAFETY GUARD around PROTECTED_CONTAINER
# --------------------------------------------------------------------------
# A single opaque string that changes if the container is restarted, recreated,
# stopped or replaced. Comparing it before/after is the whole check.

protected_snapshot() {
  [[ -n "$PROTECTED_CONTAINER" ]] || { echo "NONE"; return; }
  docker inspect \
    --format '{{.Id}}|{{.State.Running}}|{{.State.Pid}}|{{.State.StartedAt}}|{{.RestartCount}}' \
    "$PROTECTED_CONTAINER" 2>/dev/null || echo "MISSING"
}

dockerd_pid() {
  systemctl show docker.service -p MainPID --value 2>/dev/null || echo "unknown"
}

PROTECTED_BEFORE=""
DOCKERD_PID_BEFORE=""
GUARD_ARMED=0

guard_banner_fail() {
  printf '\n%s' "$C_RED"
  printf '################################################################\n'
  printf '#  DEPLOY SAFETY VIOLATION - PROTECTED CONTAINER WAS AFFECTED  #\n'
  printf '################################################################%s\n' "$C_RESET"
}

verify_protected_container() {
  local phase="$1" now
  now="$(protected_snapshot)"

  if [[ "$now" == "NONE" ]]; then
    :   # no PROTECTED_CONTAINER configured; only the daemon PID is checked below
  elif [[ "$now" == "MISSING" ]]; then
    guard_banner_fail
    err "Container '${PROTECTED_CONTAINER}' no longer exists (checked ${phase})."
    err "  before: ${PROTECTED_BEFORE:-<not captured>}"
    err "  now   : ${now}"
    err "This deploy must be treated as having broken production. Investigate now."
    return 1
  fi

  if [[ -n "$PROTECTED_BEFORE" && "$now" != "$PROTECTED_BEFORE" ]]; then
    guard_banner_fail
    err "Container '${PROTECTED_CONTAINER}' CHANGED during the deploy (checked ${phase})."
    err "  before: ${PROTECTED_BEFORE}"
    err "  now   : ${now}"
    err "Fields are: Id|Running|Pid|StartedAt|RestartCount."
    err "If it is stopped, bring it back with:  docker start ${PROTECTED_CONTAINER}"
    err "Then find out what restarted it BEFORE running this script again."
    return 1
  fi

  local running
  running="$(cut -d'|' -f2 <<<"$now")"
  if [[ "$now" != "NONE" && "$running" != "true" ]]; then
    guard_banner_fail
    err "Container '${PROTECTED_CONTAINER}' is not running (checked ${phase})."
    return 1
  fi

  local dpid_now
  dpid_now="$(dockerd_pid)"
  if [[ -n "$DOCKERD_PID_BEFORE" && "$dpid_now" != "$DOCKERD_PID_BEFORE" ]]; then
    guard_banner_fail
    err "The Docker daemon was restarted during this deploy (MainPID ${DOCKERD_PID_BEFORE} -> ${dpid_now})."
    err "Nothing in this script does that. Something else on the box did - investigate."
    return 1
  fi

  if [[ -n "$PROTECTED_CONTAINER" ]]; then
    ok "Protected container '${PROTECTED_CONTAINER}' untouched (${phase}); dockerd PID ${dpid_now} unchanged."
  else
    ok "dockerd PID ${dpid_now} unchanged (${phase})."
  fi
  return 0
}

# Runs on EVERY exit path: success, error (set -e), or Ctrl-C.
GUARD_RESULT=0
on_exit() {
  local rc=$?
  if [[ "$GUARD_ARMED" -eq 1 ]]; then
    printf '\n'
    step "FINAL SAFETY CHECK"
    if ! verify_protected_container "after deploy"; then
      GUARD_RESULT=1
    fi
  fi
  if [[ "$GUARD_RESULT" -ne 0 ]]; then
    exit 90
  fi
  exit "$rc"
}
trap on_exit EXIT

# --------------------------------------------------------------------------
# 2. Preflight
# --------------------------------------------------------------------------

step "Preflight"

have docker || die "docker not found in PATH."
docker compose version >/dev/null 2>&1 || die "'docker compose' (v2) plugin not available."
docker info >/dev/null 2>&1 || die "Cannot talk to the Docker daemon (is your user in the 'docker' group?)."
ok "docker $(docker --version | awk '{print $3}' | tr -d ,) / compose $(docker compose version --short)"

[[ -f "$SLICE_SRC" ]]          || die "Missing ${SLICE_SRC}"
[[ -f "$COMPOSE_SIGNALLING" ]] || die "Missing ${COMPOSE_SIGNALLING}"
[[ -d "${SCRIPT_DIR}/signalling" ]] || die "Missing build context ${SCRIPT_DIR}/signalling"

if ! systemctl is-system-running --quiet 2>/dev/null; then
  warn "systemd reports a degraded/starting system state ($(systemctl is-system-running 2>/dev/null || true)); continuing."
fi

# cgroup v2 is required for MemoryHigh / IOWeight to mean anything.
if [[ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown)" != "cgroup2fs" ]]; then
  warn "/sys/fs/cgroup is not cgroup2fs - MemoryHigh/IOWeight in frame.slice may be ignored."
else
  ok "cgroup v2 (cgroup2fs) confirmed."
fi

step "SAFETY CHECK (before)"
DOCKERD_PID_BEFORE="$(dockerd_pid)"
PROTECTED_BEFORE="$(protected_snapshot)"

if [[ "$PROTECTED_BEFORE" == "NONE" ]]; then
  ok "No PROTECTED_CONTAINER set; only the Docker daemon PID will be re-checked."
  ok "Docker daemon MainPID: ${DOCKERD_PID_BEFORE} (must be identical afterwards)"
elif [[ "$PROTECTED_BEFORE" == "MISSING" ]]; then
  if [[ "${ALLOW_PROTECTED_DOWN:-0}" == "1" ]]; then
    warn "'${PROTECTED_CONTAINER}' does not exist, but ALLOW_PROTECTED_DOWN=1 was set."
    warn "THE PRODUCTION SAFETY GUARD IS DISABLED FOR THIS RUN. You are on your own."
    PROTECTED_BEFORE=""
  else
    die "Protected container '${PROTECTED_CONTAINER}' does not exist. Refusing to deploy: with no known-good baseline this script cannot prove it did not break production. Start it first, or re-run with ALLOW_PROTECTED_DOWN=1 if you are certain."
  fi
elif [[ "$(cut -d'|' -f2 <<<"$PROTECTED_BEFORE")" != "true" ]]; then
  if [[ "${ALLOW_PROTECTED_DOWN:-0}" == "1" ]]; then
    warn "'${PROTECTED_CONTAINER}' is already stopped; ALLOW_PROTECTED_DOWN=1 set."
    warn "THE PRODUCTION SAFETY GUARD IS DISABLED FOR THIS RUN. You are on your own."
    PROTECTED_BEFORE=""
  else
    die "Protected container '${PROTECTED_CONTAINER}' exists but is NOT running. Fix that first (docker start ${PROTECTED_CONTAINER}) so this deploy has a clean baseline, or re-run with ALLOW_PROTECTED_DOWN=1."
  fi
else
  ok "Baseline captured: ${PROTECTED_BEFORE}"
  ok "Docker daemon MainPID: ${DOCKERD_PID_BEFORE} (must be identical afterwards)"
fi

# Arm the exit-trap guard only when we actually have a baseline to compare to.
if [[ -n "$PROTECTED_BEFORE" ]]; then
  GUARD_ARMED=1
fi

# Assert we are not about to fight over a port that is already taken by
# something else (the stack needs 127.0.0.1:2283 and 127.0.0.1:8080).
port_owner_is_ours() {
  # $1 = port, $2..= container names that are allowed to own it
  local port="$1"; shift
  local holder
  holder="$( (ss -ltnp 2>/dev/null || true) | awk -v p=":${port}$" '$4 ~ p {print $0}' )"
  if [[ -z "$holder" ]]; then
    return 0   # nobody is listening; the port is free
  fi
  local name
  for name in "$@"; do
    if docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -q "^${name} .*:${port}->"; then
      return 0
    fi
  done
  warn "Port ${port} is already bound by: ${holder}"
  return 1
}

if ! port_owner_is_ours "$SIGNALLING_LOCAL_PORT" frameo-signalling; then
  die "Port ${SIGNALLING_LOCAL_PORT} is in use by something that is not our signalling container. Refusing to continue."
fi

if [[ "${SKIP_IMMICH:-0}" != "1" ]] && ! port_owner_is_ours "$IMMICH_LOCAL_PORT" immich-server; then
  die "Port ${IMMICH_LOCAL_PORT} is in use by something that is not immich-server. Refusing to continue (re-run with SKIP_IMMICH=1 to deploy signalling only)."
fi

# --------------------------------------------------------------------------
# 3. Directory layout
# --------------------------------------------------------------------------

step "Directories under ${FRAMEO_ROOT}"

for d in data config logs; do
  target="${FRAMEO_ROOT}/${d}"
  if [[ -d "$target" ]]; then
    ok "exists: ${target}"
  else
    log "creating ${target}"
    $SUDO mkdir -p "$target"
  fi
done

# Ownership: the directories themselves are owned by FRAMEO_USER, whose uid/gid
# the signalling and TURN containers also run as (FRAMEO_UID/FRAMEO_GID), so
# bind mounts are writable without any chmod 777.
#
# NOTE the deliberate absence of `chown -R`. Recursing would rewrite the
# ownership of ${FRAMEO_ROOT}/data/postgres, whose files must belong to the
# postgres uid *inside* the Immich database container. Postgres refuses to start
# on a data directory with "invalid ownership", so a well-meaning recursive
# chown on a re-run would take the whole photo backend down. We only ever touch
# the four directories we create and the two files we seed.
for target in "${FRAMEO_ROOT}" "${FRAMEO_ROOT}/data" "${FRAMEO_ROOT}/config" "${FRAMEO_ROOT}/logs"; do
  CURRENT_OWNER="$(stat -c '%U:%G' "$target" 2>/dev/null || echo '')"
  if [[ "$CURRENT_OWNER" != "${FRAMEO_USER}:${FRAMEO_USER}" ]]; then
    log "chown ${FRAMEO_USER}:${FRAMEO_USER} ${target} (non-recursive)"
    maybe_sudo chown "${FRAMEO_USER}:${FRAMEO_USER}" "$target"
  fi
done
maybe_sudo chmod 0755 "${FRAMEO_ROOT}" "${FRAMEO_ROOT}/data" "${FRAMEO_ROOT}/logs"
# config holds the roster and its auth tokens -> not world readable.
maybe_sudo chmod 0750 "${FRAMEO_ROOT}/config"
ok "ownership ${FRAMEO_USER}:${FRAMEO_USER} (non-recursive), config mode 0750"

# The roster is the whitelist the signalling server enforces. It refuses to
# start on an empty or unparseable roster, so seed it from the shipped example
# on a first deploy. An existing roster is NEVER overwritten.
ROSTER="${FRAMEO_ROOT}/config/roster.json"
ROSTER_EXAMPLE="${SCRIPT_DIR}/signalling/roster.example.json"

if [[ -d "$ROSTER" ]]; then
  die "${ROSTER} is a directory (Docker created it from an older single-file bind mount). Remove it: sudo rmdir '${ROSTER}' - then re-run."
fi
if [[ ! -f "$ROSTER" ]]; then
  [[ -f "$ROSTER_EXAMPLE" ]] || die "No roster at ${ROSTER} and no template at ${ROSTER_EXAMPLE}."
  log "seeding roster from $(basename "$ROSTER_EXAMPLE") with freshly generated authTokens"
  have openssl || die "openssl is needed to generate the roster's authTokens."
  as_frameo_user cp "$ROSTER_EXAMPLE" "$ROSTER"
  # Replace every placeholder token with its own random secret. The server
  # refuses to start while any 'replace-me' token is left.
  while grep -q '"replace-me[^"]*"' "$ROSTER"; do
    as_frameo_user sed -i "0,/\"replace-me[^\"]*\"/s//\"$(openssl rand -hex 24)\"/" "$ROSTER"
  done
  maybe_sudo chmod 0640 "$ROSTER"
  maybe_sudo chown "${FRAMEO_USER}:${FRAMEO_USER}" "$ROSTER"
else
  ok "roster present: ${ROSTER}"
fi

# Placeholder auth tokens are public (they are in this repo); the server refuses them.
if grep -q '"authToken"[[:space:]]*:[[:space:]]*"replace-me' "$ROSTER" 2>/dev/null; then
  die "${ROSTER} still contains placeholder authToken values ('replace-me...'). Generate real ones with 'openssl rand -hex 24' (one per peer), edit the file, and re-run."
fi

# JSONL audit trail, written by the container (running as FRAMEO_UID) into /data.
CALL_LOG="${FRAMEO_ROOT}/logs/calls.jsonl"
if [[ ! -e "$CALL_LOG" ]]; then
  as_frameo_user touch "$CALL_LOG"
  maybe_sudo chmod 0640 "$CALL_LOG"
fi
ok "call log: ${CALL_LOG}"

# .env for compose variable substitution. Never overwrite an existing one.
ENV_FILE="${SCRIPT_DIR}/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "${SCRIPT_DIR}/.env.example" ]]; then
    log "creating ${ENV_FILE} from .env.example"
    cp "${SCRIPT_DIR}/.env.example" "$ENV_FILE"
    sed -i -e "s#/home/youruser/frameo#${FRAMEO_ROOT}#g" \
           -e "s#^FRAMEO_UID=.*#FRAMEO_UID=${FRAMEO_UID}#" \
           -e "s#^FRAMEO_GID=.*#FRAMEO_GID=${FRAMEO_GID}#" "$ENV_FILE"
    maybe_sudo chown "${FRAMEO_USER}:${FRAMEO_USER}" "$ENV_FILE"
    maybe_sudo chmod 0600 "$ENV_FILE"
    warn "A fresh ${ENV_FILE} was created from the template. Fill in the secrets before continuing."
  else
    warn "No ${ENV_FILE} and no .env.example - compose will use built-in defaults only."
  fi
else
  # It holds DB_PASSWORD and CONTROL_TOKEN; keep it owner-only regardless of
  # how it was created.
  maybe_sudo chmod 0600 "$ENV_FILE"
  ok "env file: ${ENV_FILE}"
fi

# Placeholder secrets are a hard problem for Postgres specifically: DB_PASSWORD
# is baked into the data directory on FIRST start, so booting Immich with the
# template value is not something you can simply undo by editing .env later.
ENV_HAS_PLACEHOLDER=0
if [[ -f "$ENV_FILE" ]] && grep -qE '^[A-Z_]+=.*CHANGEME' "$ENV_FILE"; then
  ENV_HAS_PLACEHOLDER=1
fi

# The signalling control API (the ring trigger) is disabled without a token.
if [[ -f "$ENV_FILE" ]] && ! grep -qE '^CONTROL_TOKEN=.+' "$ENV_FILE"; then
  warn "CONTROL_TOKEN is unset in ${ENV_FILE} - the signalling POST /api/* control endpoints"
  warn "will be disabled, which means the laptop cannot push a ring to the tablets."
  warn "Generate one:  openssl rand -hex 32   then add CONTROL_TOKEN=... to ${ENV_FILE}"
fi

# --------------------------------------------------------------------------
# 4. frame.slice
# --------------------------------------------------------------------------

step "systemd slice: frame.slice"

INSTALL_SLICE=1
if [[ -f "$SLICE_DST" ]] && cmp -s "$SLICE_SRC" "$SLICE_DST"; then
  INSTALL_SLICE=0
  ok "${SLICE_DST} already up to date"
fi

if [[ "$INSTALL_SLICE" -eq 1 ]]; then
  log "installing ${SLICE_DST}"
  $SUDO install -m 0644 -o root -g root "$SLICE_SRC" "$SLICE_DST"
  log "systemctl daemon-reload"
  $SUDO systemctl daemon-reload
fi

# `enable` makes it exist at boot; `--now` starts it immediately. Starting an
# (empty) slice is cheap and does not touch anything already running.
if ! systemctl is-enabled --quiet frame.slice 2>/dev/null; then
  log "systemctl enable frame.slice"
  $SUDO systemctl enable frame.slice >/dev/null
fi
if ! systemctl is-active --quiet frame.slice 2>/dev/null; then
  log "systemctl start frame.slice"
  $SUDO systemctl start frame.slice
fi

SLICE_HIGH="$(systemctl show frame.slice -p MemoryHigh --value 2>/dev/null || echo '?')"
SLICE_MAX="$(systemctl show frame.slice -p MemoryMax --value 2>/dev/null || echo '?')"
SLICE_TASKS="$(systemctl show frame.slice -p TasksMax --value 2>/dev/null || echo '?')"
ok "frame.slice active (MemoryHigh=${SLICE_HIGH} MemoryMax=${SLICE_MAX} TasksMax=${SLICE_TASKS})"

# --------------------------------------------------------------------------
# 5. Docker network
# --------------------------------------------------------------------------

step "Docker network '${FRAMEO_NETWORK}'"

if docker network inspect "$FRAMEO_NETWORK" >/dev/null 2>&1; then
  ok "network '${FRAMEO_NETWORK}' already exists"
else
  log "creating network '${FRAMEO_NETWORK}'"
  # A plain user-defined bridge. No custom subnet: letting Docker pick avoids
  # any chance of colliding with the tailnet (100.64.0.0/10) or the LAN.
  docker network create --driver bridge "$FRAMEO_NETWORK" >/dev/null
  ok "network '${FRAMEO_NETWORK}' created"
fi

# --------------------------------------------------------------------------
# 6. Compose stacks
# --------------------------------------------------------------------------
# NOTE the flags we deliberately do NOT pass:
#   --remove-orphans  -> can delete containers outside our stack
#   --force-recreate  -> pointless churn on a re-run
# and the commands we never run: `compose down`, any `prune`.
#
# Caveat worth knowing: the image BUILD runs inside the Docker daemon, i.e.
# outside frame.slice - only the resulting containers are contained. Our build
# is a single `npm install` of one dependency, so this is a non-issue here; do
# not add heavy build steps without reconsidering it.

compose_up() {
  local file="$1" label="$2"
  step "Compose stack: ${label}"
  log "docker compose -f $(basename "$file") up -d --build"
  ( cd "$SCRIPT_DIR" && docker compose -f "$file" up -d --build )
  ok "${label} up"
}

compose_up "$COMPOSE_SIGNALLING" "signalling"

if [[ "${SKIP_IMMICH:-0}" == "1" ]]; then
  warn "SKIP_IMMICH=1 - not touching the Immich stack."
elif [[ ! -f "$COMPOSE_IMMICH" ]]; then
  warn "No ${COMPOSE_IMMICH} found - skipping the photo stack. (Add it, then re-run.)"
elif [[ "$ENV_HAS_PLACEHOLDER" -eq 1 ]]; then
  warn "REFUSING to start Immich: ${ENV_FILE} still contains a CHANGEME placeholder."
  warn "DB_PASSWORD is written into the Postgres data directory on its very first start,"
  warn "so booting with the template password is not something you can fix by editing .env"
  warn "afterwards - you would have to ALTER USER inside the database or wipe it."
  warn "Fix it now:"
  warn "  tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 40; echo    # generate"
  warn "  \${EDITOR:-nano} ${ENV_FILE}                              # set DB_PASSWORD"
  warn "  ./deploy.sh                                             # re-run; everything else is already done"
else
  compose_up "$COMPOSE_IMMICH" "immich"
fi

# Give the containers a moment to bind their ports before we probe them.
step "Waiting for services to answer"

wait_http() {
  local url="$1" name="$2" tries="${3:-30}" i
  for ((i = 1; i <= tries; i++)); do
    if curl -fsS --max-time 3 -o /dev/null "$url"; then
      ok "${name} responding at ${url}"
      return 0
    fi
    sleep 2
  done
  warn "${name} did not respond at ${url} after $((tries * 2))s - check: docker logs <container>"
  return 1
}

wait_http "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}/api/health" "signalling" 30 || true

if docker ps --format '{{.Names}}' | grep -qi '^immich'; then
  wait_http "http://127.0.0.1:${IMMICH_LOCAL_PORT}/api/server/ping" "immich" 45 \
    || wait_http "http://127.0.0.1:${IMMICH_LOCAL_PORT}/api/server-info/ping" "immich (legacy path)" 5 \
    || true
fi

# --------------------------------------------------------------------------
# 7. HTTPS via `tailscale serve`
# --------------------------------------------------------------------------
# WHY `tailscale serve` AND NOT `tailscale cert`
# ----------------------------------------------
# Both can give you a real, publicly-trusted Let's Encrypt certificate for
# <host>.<tailnet>.ts.net. The difference is renewal:
#
#   * `tailscale cert` writes a cert/key PAIR TO DISK, ONCE. It does NOT renew
#     them. Let's Encrypt certs are valid ~90 days. You would have to remember
#     to re-run it and reload whatever server is holding the files - forever.
#
#   * `tailscale serve` makes tailscaled itself the TLS terminator. It fetches
#     the certificate, keeps it in its state, and RENEWS IT AUTOMATICALLY in
#     the background. It also re-arms itself after a reboot or a tailscaled
#     restart (that is what --bg means: persistent, not a foreground session).
#
# Why that difference is fatal here rather than merely annoying: the tablets
# use getUserMedia() for camera and microphone. Browsers only grant that on a
# SECURE CONTEXT. The day an unrenewed certificate expires, the page stops
# being a valid secure origin and the camera silently stops working - no error
# the grandparents can see, no obvious cause, ~90 days after everything "just
# worked". `tailscale serve` removes that failure mode entirely.
#
# Corollary rules, for the same reason:
#   * The tablets MUST load https://<magicdns-name>/ . A raw 100.x.y.z Tailscale
#     IP is not a secure origin -> camera fails just as silently.
#   * This step uses `serve` (tailnet-only). Going public through Funnel is a
#     separate, deliberate step: ./expose-public.sh.

step "HTTPS via tailscale serve"

detect_ts_hostname() {
  local out
  # ${TS:-tailscale} so this works whether or not the CLI needed sudo.
  if have jq; then
    out="$(${TS:-tailscale} status --json 2>/dev/null | jq -r '.Self.DNSName // empty')"
  else
    # Self appears before Peer in the JSON, so the first DNSName is ours.
    out="$(${TS:-tailscale} status --json 2>/dev/null \
            | tr ',' '\n' \
            | sed -n 's/.*"DNSName" *: *"\([^"]*\)".*/\1/p' | head -1)"
  fi
  printf '%s' "${out%.}"   # strip the trailing dot of the FQDN
}

if [[ "${SKIP_TAILSCALE:-0}" == "1" ]]; then
  warn "SKIP_TAILSCALE=1 - not configuring tailscale serve."
  FRAME_HOSTNAME="${FRAME_HOSTNAME:-your-machine.your-tailnet.ts.net}"
elif ! have tailscale; then
  warn "tailscale CLI not found - skipping HTTPS setup. The call page will NOT work without it."
  FRAME_HOSTNAME="${FRAME_HOSTNAME:-your-machine.your-tailnet.ts.net}"
else
  # `tailscale serve` needs root or an operator-mapped user. Try unprivileged
  # first, fall back to sudo, so the script works either way.
  TS="tailscale"
  if ! tailscale serve status >/dev/null 2>&1; then
    if $SUDO tailscale serve status >/dev/null 2>&1; then
      TS="$SUDO tailscale"
      log "using sudo for the tailscale CLI (tip: 'sudo tailscale set --operator=${FRAMEO_USER}' makes this unnecessary)"
    else
      warn "Cannot query 'tailscale serve status' with or without sudo. Is tailscaled up and this node logged in?"
    fi
  fi

  FRAME_HOSTNAME="${FRAME_HOSTNAME:-$(detect_ts_hostname)}"
  if [[ -z "$FRAME_HOSTNAME" ]]; then
    FRAME_HOSTNAME="your-machine.your-tailnet.ts.net"
    warn "Could not auto-detect the MagicDNS name; assuming ${FRAME_HOSTNAME}"
  fi
  ok "MagicDNS name: ${FRAME_HOSTNAME}"

  SERVE_STATUS="$($TS serve status 2>/dev/null || true)"
  if grep -q "127.0.0.1:${SIGNALLING_LOCAL_PORT}\|localhost:${SIGNALLING_LOCAL_PORT}" <<<"$SERVE_STATUS"; then
    ok "tailscale serve already proxies https/443 -> 127.0.0.1:${SIGNALLING_LOCAL_PORT}"
  else
    log "configuring: tailscale serve --bg --https=443 http://127.0.0.1:${SIGNALLING_LOCAL_PORT}"
    # --bg  : run persistently in the background (survives reboot / tailscaled restart)
    # --https=443 : terminate TLS on the standard port with an auto-renewed LE cert
    # --yes : no interactive confirmation (newer CLIs); retried without it for older ones
    if ! $TS serve --bg --yes --https=443 "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}" 2>/tmp/frameo-serve.err; then
      if ! $TS serve --bg --https=443 "http://127.0.0.1:${SIGNALLING_LOCAL_PORT}" 2>>/tmp/frameo-serve.err; then
        err "tailscale serve failed:"
        sed 's/^/        /' /tmp/frameo-serve.err >&2 || true
        err "Most common cause: HTTPS Certificates are not enabled for this tailnet."
        err "Fix in the admin console -> DNS -> HTTPS Certificates -> Enable, then re-run this script."
        die "Aborting: without HTTPS there is no secure origin and the camera will not work."
      fi
    fi
    ok "tailscale serve configured (background, auto-renewing certificate)"
  fi

  # First cert issuance can take a few seconds.
  if ! curl -fsS --max-time 20 -o /dev/null "https://${FRAME_HOSTNAME}/api/health"; then
    sleep 5
    curl -fsS --max-time 20 -o /dev/null "https://${FRAME_HOSTNAME}/api/health" \
      && ok "HTTPS endpoint healthy" \
      || warn "https://${FRAME_HOSTNAME}/api/health not answering yet (certificate may still be issuing). Re-check with ./healthcheck.sh"
  else
    ok "HTTPS endpoint healthy"
  fi
fi

# --------------------------------------------------------------------------
# 8. Summary
# --------------------------------------------------------------------------

step "Summary"

printf '\n%sURLs%s\n' "$C_BOLD" "$C_RESET"
printf '  Call / frame page (tablets):  https://%s/\n' "$FRAME_HOSTNAME"
printf '  Signalling health:            https://%s/api/health\n' "$FRAME_HOSTNAME"
printf '  Signalling (host-local only): http://127.0.0.1:%s/api/health\n' "$SIGNALLING_LOCAL_PORT"
if docker ps --format '{{.Names}}' | grep -qi '^immich'; then
  # Immich is published on 127.0.0.1 ONLY, so it is not reachable at
  # <magicdns>:2283. Reach it from another machine over an SSH tunnel, or add a
  # second `tailscale serve` mapping on a different port if you want it on the
  # tailnet. Do NOT widen the port binding to 0.0.0.0.
  printf '  Immich web UI (host-local only): http://127.0.0.1:%s/\n' "$IMMICH_LOCAL_PORT"
  printf '    from another machine:           ssh -L %s:127.0.0.1:%s %s@%s\n' \
         "$IMMICH_LOCAL_PORT" "$IMMICH_LOCAL_PORT" "$FRAMEO_USER" "$FRAME_HOSTNAME"
fi

printf '\n%sPaths%s\n' "$C_BOLD" "$C_RESET"
printf '  Photos / app data:  %s/data\n'   "$FRAMEO_ROOT"
printf '  Roster (whitelist): %s\n'        "$ROSTER"
printf '  Logs + call log:    %s/logs\n'   "$FRAMEO_ROOT"
printf '  Compose + scripts:  %s\n'        "$SCRIPT_DIR"

printf '\n%sContainment%s\n' "$C_BOLD" "$C_RESET"
printf '  frame.slice: MemoryHigh=%s MemoryMax=%s TasksMax=%s CPUWeight=50 IOWeight=50\n' \
       "$SLICE_HIGH" "$SLICE_MAX" "$SLICE_TASKS"
printf '  Live usage:  systemctl show frame.slice -p MemoryCurrent -p TasksCurrent\n'
printf '  Tree:        systemd-cgls /frame.slice\n'

printf '\n%sNext steps%s\n' "$C_BOLD" "$C_RESET"
printf '  1. Add the family to %s with real authTokens (openssl rand -hex 24).\n' "$ROSTER"
printf '     The server hot-reloads it within ~15s; no restart needed.\n'
printf '  2. Create the Immich albums ("Bunici A", "Bunici B", "Toti"), then an Immich API\n'
printf '     key (Account Settings -> API Keys) and put it in %s as\n' "$ENV_FILE"
printf '     IMMICH_API_KEY=... plus IMMICH_ALBUM_IDS=<album-id>[,<album-id>]. Re-run this\n'
printf '     script afterwards. WITHOUT THAT KEY THE FRAMES HAVE NO PHOTOS.\n'
printf '  3. Run ./healthcheck.sh - it must print all PASS.\n'
printf '  4. Provision each tablet ONCE with its own identity, then let the kiosk keep the\n'
printf '     short URL (the pair is stored in localStorage):\n'
printf '       https://%s/?device=frame-a&token=<that peer authToken>\n' "$FRAME_HOSTNAME"
printf '     Always the MagicDNS name, never an IP: an IP is not a secure origin and the\n'
printf '     camera fails silently.\n'
printf '  5. Set up the restic backup to USB (see README-ops.md).\n'
printf '  6. Add ./healthcheck.sh to cron/systemd-timer and wire it to ntfy alerting.\n'

ok "Deploy finished."
