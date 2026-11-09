#!/bin/sh
# Make It Right container entrypoint: runs the app as an unprivileged user, with its secrets from our vault.
#
# 1. Started as root (the image has no USER line, so a volume mounted at MIR_DATA_DIR can be any owner): the data
#    directory is given to user `node`, and this script starts again as `node`. The app never runs as root.
# 2. SECRETS_SOURCE=infisical (the image's default): the secrets of this service are read from Infisical when the
#    container starts and handed to the app by `infisical run`, for the life of the process only; nothing is written
#    to disk. Required:
#      INFISICAL_API_URL                       the vault's API address
#      INFISICAL_PROJECT_ID                    the vault project of this service
#      INFISICAL_SECRET_PATH                   the folder of this service, e.g. /make-it-right
#      INFISICAL_UNIVERSAL_AUTH_CLIENT_ID      a machine identity that can read only that folder
#      INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET  its secret
#    Optional: INFISICAL_ENV (default prod).
#    The CLI reads the API address and the identity from the environment, so no credential appears on a command line.
#    SECRETS_SOURCE=platform runs the app with the environment as it is (local runs only; refused with MIR_PUBLIC_DEMO=1).
#
# The start stops (exit 1) on anything missing: an unset variable, a failed login, a secret set that cannot be read,
# is empty, or lacks the PayPal sandbox credentials or has them empty. There is no fallback to other values. Only
# variable NAMES and a COUNT are ever logged, never a value. The machine identity's own credentials are removed from the
# environment before the app starts: the token from the login is all `infisical run` needs, and the app is started
# without that token too.

set -eu

log() { echo "[entrypoint] $*" >&2; }
die() {
    log "FATAL: $*"
    exit 1
}

APP_USER=node

if [ "$(id -u)" = "0" ]; then
    data="${MIR_DATA_DIR:-/data}"
    mkdir -p "$data" || die "cannot create the data directory ${data}"
    chown -R "$APP_USER:$APP_USER" "$data" || die "cannot give the data directory ${data} to user ${APP_USER}"
    command -v setpriv >/dev/null 2>&1 || die "setpriv not found; the app will not run as root"
    log "data directory ${data} belongs to ${APP_USER}; starting again as ${APP_USER}"
    exec env HOME="/home/$APP_USER" setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups -- "$0" "$@"
fi

SECRETS_SOURCE="${SECRETS_SOURCE:-infisical}"
case "$SECRETS_SOURCE" in
    infisical) ;;
    platform)
        case "${MIR_PUBLIC_DEMO:-}" in
            1 | true) die "SECRETS_SOURCE=platform is for local runs; the public demo (MIR_PUBLIC_DEMO=${MIR_PUBLIC_DEMO}) takes its secrets from the vault" ;;
        esac
        log "SECRETS_SOURCE=platform: the app runs with the environment as it is"
        exec "$@"
        ;;
    *) die "SECRETS_SOURCE must be infisical or platform, not '${SECRETS_SOURCE}'" ;;
esac

INFISICAL_ENV="${INFISICAL_ENV:-prod}"

missing=""
for name in INFISICAL_API_URL INFISICAL_PROJECT_ID INFISICAL_SECRET_PATH INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET; do
    if [ -z "$(printenv "$name" 2>/dev/null || true)" ]; then missing="${missing} ${name}"; fi
done
[ -z "$missing" ] || die "SECRETS_SOURCE=infisical needs these variables, which are unset or empty:${missing}"

command -v infisical >/dev/null 2>&1 || die "the infisical CLI is not on PATH"

# The only token allowed is the one this identity gets now; one inherited from the host is dropped.
unset INFISICAL_TOKEN || true
export INFISICAL_DISABLE_UPDATE_CHECK=true

log "logging in to ${INFISICAL_API_URL} as the service's machine identity"
INFISICAL_TOKEN="$(infisical login --method=universal-auth --silent --plain 2>/dev/null)" || die "login to ${INFISICAL_API_URL} failed: wrong identity, or the vault cannot be reached"
[ -n "$INFISICAL_TOKEN" ] || die "login to ${INFISICAL_API_URL} gave an empty token"
export INFISICAL_TOKEN

# What this identity sees in the folder: the export is a JSON list of {key, value, ...}. The values go straight into
# node, which prints only the count, the names, and the names of required credentials that are absent or empty (it
# looks at a value's length and never prints it); a different shape stops the start.
summary="$(
    infisical export --format=json --projectId="$INFISICAL_PROJECT_ID" --env="$INFISICAL_ENV" --path="$INFISICAL_SECRET_PATH" 2>/dev/null |
        node -e '
let text = "";
process.stdin.on("data", (d) => { text += d; }).on("end", () => {
  let list;
  try { list = JSON.parse(text); } catch { process.exit(2); }
  if (!Array.isArray(list)) process.exit(2);
  const nameOf = (s) => String((s && (s.key ?? s.Key ?? s.secretKey)) ?? "");
  const names = list.map(nameOf).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)).sort();
  if (names.length !== list.length) process.exit(2);
  const filled = (n) => list.some((s) => { const v = nameOf(s) === n ? (s.value ?? s.Value ?? s.secretValue) : undefined; return typeof v === "string" && v.trim().length > 0; });
  const required = ["PAYPAL_SANDBOX_CLIENT_ID", "PAYPAL_SANDBOX_CLIENT_SECRET"];
  const absent = required.filter((n) => !names.includes(n));
  const empty = required.filter((n) => names.includes(n) && !filled(n));
  console.log(`${list.length}\t${names.join(", ")}\t${absent.join(", ")}\t${empty.join(", ")}`);
});' 2>/dev/null
)" || summary=""

count="$(printf '%s' "$summary" | cut -f1)"
names="$(printf '%s' "$summary" | cut -f2)"
absent="$(printf '%s' "$summary" | cut -f3)"
empty="$(printf '%s' "$summary" | cut -f4)"
case "$count" in
    "" | *[!0-9]*) die "could not read the secrets at ${INFISICAL_SECRET_PATH} (env ${INFISICAL_ENV}): the read failed, the token was refused, or the answer had an unexpected shape" ;;
esac
[ "$count" -gt 0 ] || die "no secrets at ${INFISICAL_SECRET_PATH} (env ${INFISICAL_ENV}); refusing to start without them"
[ -z "$absent" ] || die "the secrets at ${INFISICAL_SECRET_PATH} (env ${INFISICAL_ENV}) lack: ${absent}"
[ -z "$empty" ] || die "these secrets at ${INFISICAL_SECRET_PATH} (env ${INFISICAL_ENV}) are empty: ${empty}"

log "${count} secrets at ${INFISICAL_SECRET_PATH} (env ${INFISICAL_ENV}): ${names}; starting the app"
unset INFISICAL_UNIVERSAL_AUTH_CLIENT_ID INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET
# The CLI needs the token to read the secrets; the app does not get it
exec infisical run --projectId="$INFISICAL_PROJECT_ID" --env="$INFISICAL_ENV" --path="$INFISICAL_SECRET_PATH" -- env -u INFISICAL_TOKEN "$@"
