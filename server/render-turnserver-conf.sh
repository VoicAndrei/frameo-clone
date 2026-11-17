#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# render-turnserver-conf.sh
#
# Renders server/turnserver.conf (the template, in git) into
# ${FRAMEO_ROOT}/config/turnserver.conf (the live file, never in git), with the
# secrets from server/.env substituted in.
#
#   cd ~/frameo/server && ./render-turnserver-conf.sh
#
# Idempotent: rendering twice with the same inputs leaves the file byte-identical
# and does not touch its mtime, so it will not needlessly restart coturn.
#
# Substituted placeholders:
#   ${TS_TAILNET_IP}            required; auto-detected with `tailscale ip -4` if unset
#   ${TURN_STATIC_AUTH_SECRET}  required; from .env
#   ${TURN_REALM}               optional; defaults to the node's MagicDNS name,
#                               else to the tailnet IP
#
# Why a dedicated script and not `envsubst`: envsubst is in gettext, which is not
# installed on a minimal Ubuntu server, and it would happily substitute an EMPTY
# string for a missing variable - producing a syntactically valid coturn config
# with `static-auth-secret=` and no authentication at all. This script refuses.
#
# Environment overrides:
#   FRAMEO_ROOT   default ~/frameo
#   ENV_FILE      default <script dir>/.env
#   OUT_FILE      default ${FRAMEO_ROOT}/config/turnserver.conf
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
FRAMEO_ROOT="${FRAMEO_ROOT:-$HOME/frameo}"
ENV_FILE="${ENV_FILE:-${SCRIPT_DIR}/.env}"
TEMPLATE="${SCRIPT_DIR}/turnserver.conf"
OUT_FILE="${OUT_FILE:-${FRAMEO_ROOT}/config/turnserver.conf}"

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'; C_RED=$'\033[1;31m'; C_GRN=$'\033[1;32m'
  C_YEL=$'\033[1;33m'; C_BLU=$'\033[1;34m'
else
  C_RESET=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''
fi
_ts() { date '+%Y-%m-%d %H:%M:%S'; }
log()  { printf '%s [%sINFO%s ] %s\n' "$(_ts)" "$C_BLU" "$C_RESET" "$*"; }
ok()   { printf '%s [%s OK %s ] %s\n' "$(_ts)" "$C_GRN" "$C_RESET" "$*"; }
warn() { printf '%s [%sWARN%s ] %s\n' "$(_ts)" "$C_YEL" "$C_RESET" "$*" >&2; }
die()  { printf '%s [%sFAIL%s ] %s\n' "$(_ts)" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

[[ -f "$TEMPLATE" ]] || die "Template not found: ${TEMPLATE}"

# --- 1. Load .env without executing it -------------------------------------
# `set -a; . .env` would run any command substitution in the file. Parse instead.
env_get() {
  local key="$1" line value
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$ENV_FILE" | tail -n 1 || true)"
  [[ -n "$line" ]] || return 0
  value="${line#*=}"
  # strip a single layer of matching quotes and any trailing comment on unquoted values
  if [[ "$value" =~ ^\"(.*)\"[[:space:]]*$ ]]; then
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
    value="${BASH_REMATCH[1]}"
  else
    value="${value%%[[:space:]]#*}"
    value="${value%"${value##*[![:space:]]}"}"
  fi
  printf '%s' "$value"
}

TURN_STATIC_AUTH_SECRET="${TURN_STATIC_AUTH_SECRET:-$(env_get TURN_STATIC_AUTH_SECRET)}"
TS_TAILNET_IP="${TS_TAILNET_IP:-$(env_get TS_TAILNET_IP)}"
TURN_REALM="${TURN_REALM:-$(env_get TURN_REALM)}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-$(env_get PUBLIC_ORIGIN)}"

# --- 2. Fill in what can be detected ---------------------------------------
if [[ -z "$TS_TAILNET_IP" ]] && command -v tailscale >/dev/null 2>&1; then
  TS_TAILNET_IP="$(tailscale ip -4 2>/dev/null | head -n 1 || true)"
  [[ -n "$TS_TAILNET_IP" ]] && log "TS_TAILNET_IP auto-detected as ${TS_TAILNET_IP} (add it to .env to pin it)"
fi

if [[ -z "$TURN_REALM" ]]; then
  if [[ -n "$PUBLIC_ORIGIN" ]]; then
    TURN_REALM="${PUBLIC_ORIGIN#*://}"
    TURN_REALM="${TURN_REALM%%/*}"
  elif command -v tailscale >/dev/null 2>&1; then
    TURN_REALM="$(tailscale status --json 2>/dev/null | sed -n 's/.*"DNSName"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
    TURN_REALM="${TURN_REALM%.}"
  fi
fi
[[ -n "$TURN_REALM" ]] || TURN_REALM="$TS_TAILNET_IP"

# --- 3. Validate. Refuse to write a config that would weaken the server. ----
[[ -n "$TURN_STATIC_AUTH_SECRET" ]] \
  || die "TURN_STATIC_AUTH_SECRET is not set (looked in ${ENV_FILE}). Generate one: openssl rand -hex 32"
[[ "${#TURN_STATIC_AUTH_SECRET}" -ge 32 ]] \
  || die "TURN_STATIC_AUTH_SECRET is only ${#TURN_STATIC_AUTH_SECRET} characters. Use at least 32 (openssl rand -hex 32)."
[[ "$TURN_STATIC_AUTH_SECRET" != *' '* ]] \
  || die "TURN_STATIC_AUTH_SECRET contains a space; coturn would read only the part before it."

[[ -n "$TS_TAILNET_IP" ]] \
  || die "TS_TAILNET_IP is not set and could not be detected. Run 'tailscale ip -4' and put the 100.x address in ${ENV_FILE}."
[[ "$TS_TAILNET_IP" =~ ^100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}$ ]] \
  || die "TS_TAILNET_IP='${TS_TAILNET_IP}' is not a tailnet address (100.64.0.0/10). Refusing: coturn would bind the wrong interface."

[[ "$TURN_REALM" =~ ^[A-Za-z0-9._-]+$ ]] \
  || die "TURN_REALM='${TURN_REALM}' contains characters coturn will not accept."

# --- 4. Render -------------------------------------------------------------
mkdir -p "$(dirname "$OUT_FILE")"

rendered="$(
  TS_TAILNET_IP="$TS_TAILNET_IP" \
  TURN_STATIC_AUTH_SECRET="$TURN_STATIC_AUTH_SECRET" \
  TURN_REALM="$TURN_REALM" \
  awk '
    {
      gsub(/\$\{TS_TAILNET_IP\}/,           ENVIRON["TS_TAILNET_IP"]);
      gsub(/\$\{TURN_STATIC_AUTH_SECRET\}/, ENVIRON["TURN_STATIC_AUTH_SECRET"]);
      gsub(/\$\{TURN_REALM\}/,              ENVIRON["TURN_REALM"]);
      print;
    }
  ' "$TEMPLATE"
)"

# Belt and braces: no placeholder may survive into a DIRECTIVE line. (Comment
# lines legitimately mention ${FRAMEO_ROOT} and friends while explaining things.)
if grep -v '^[[:space:]]*#' <<<"$rendered" | grep -q '\${'; then
  die "Unsubstituted \${...} placeholders remain on a directive line. Refusing to write ${OUT_FILE}."
fi

# And the secret must actually be in there, exactly once.
if [[ "$(grep -c '^static-auth-secret=' <<<"$rendered")" != "1" ]]; then
  die "Rendered config does not contain exactly one static-auth-secret line. Refusing to write ${OUT_FILE}."
fi

if [[ -f "$OUT_FILE" ]] && diff -q <(printf '%s\n' "$rendered") "$OUT_FILE" >/dev/null 2>&1; then
  ok "${OUT_FILE} is already up to date (unchanged; coturn does NOT need a restart)."
  CHANGED=0
else
  umask 077
  tmp="${OUT_FILE}.tmp.$$"
  printf '%s\n' "$rendered" >"$tmp"
  chmod 600 "$tmp"
  mv -f "$tmp" "$OUT_FILE"
  ok "Wrote ${OUT_FILE} (0600)."
  warn "coturn must be restarted to pick this up:  docker restart frameo-coturn"
  CHANGED=1
fi

# The container runs as uid 1000 and must be able to READ this file. If it
# cannot, coturn does not fail - it starts with its defaults (0.0.0.0, no auth).
owner_uid="$(stat -c '%u' "$OUT_FILE" 2>/dev/null || stat -f '%u' "$OUT_FILE")"
if [[ "$owner_uid" != "1000" ]]; then
  warn "${OUT_FILE} is owned by uid ${owner_uid}, but the container runs as uid 1000."
  warn "Fix it or coturn will silently start with INSECURE defaults:"
  warn "    sudo chown 1000:1000 ${OUT_FILE}"
fi

log "realm=${TURN_REALM}  listening/relay ip=${TS_TAILNET_IP}  secret=<${#TURN_STATIC_AUTH_SECRET} chars, not printed>"
log "changed=${CHANGED}"
exit 0
