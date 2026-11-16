#!/usr/bin/env bash
# Start, check, stop or reset an isolated development gateway and the scripted
# fake model.
#
#   PROFILE=roster-probe ./dev-gateway.sh start      # fresh profile from the template
#   PROFILE=roster-probe ./dev-gateway.sh check-env  # variable names the running gateway sees
#   PROFILE=roster-probe ./dev-gateway.sh stop
#   PROFILE=roster-probe ./dev-gateway.sh reset      # delete a profile this script created
#
# Safety rules, all enforced before any file is touched:
#   - PROFILE must match ^[a-z0-9]+(-[a-z0-9]+)*-(dev|probe)$ and must not be
#     "default" in any letter case. "dev" alone is rejected too, so the
#     builder's --dev profile is out of reach.
#   - The state and config locations are resolved once, here, and passed to
#     OpenClaw explicitly (OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH,
#     OPENCLAW_PROFILE, plus --profile), so script and CLI cannot disagree.
#   - The state folder must not exist, or must carry this script's marker file
#     and contain no .env file and no credentials. Otherwise the script refuses.
#   - Everything runs under `env -i` with five variables. `check-env` asks the
#     running gateway itself, through the probe plugin, which variable names it has.
set -euo pipefail

PROFILE="${PROFILE:-}"
PROFILE_RE='^[a-z0-9]+(-[a-z0-9]+)*-(dev|probe)$'
lower="$(printf '%s' "$PROFILE" | tr '[:upper:]' '[:lower:]')"
if [ "$lower" = "default" ] || [ "$lower" = "dev" ] || ! [[ "$PROFILE" =~ $PROFILE_RE ]]; then
  echo "refusing PROFILE='$PROFILE': must match $PROFILE_RE (and never 'default')" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKOUT="$(cd "$HERE/../../.." && pwd)"
[ -n "${HOME:-}" ] && [ -d "$HOME" ] || { echo "HOME must be an existing directory" >&2; exit 2; }
STATE="$HOME/.openclaw-$PROFILE"          # same rule as OpenClaw's resolveProfileStateDir
CONFIG="$STATE/openclaw.json"
MARKER="$STATE/.clawtrate-dev-gateway"
RUN_DIR="${RUN_DIR:-${TMPDIR:-/tmp}/openclaw-$PROFILE-run}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PORT=19101
# Names the launcher passes, plus names that appear without carrying anything
# in: OpenClaw sets OPENCLAW_CLI, OPENCLAW_GATEWAY_PORT and
# OPENCLAW_PATH_BOOTSTRAPPED itself; bash (the openclaw wrapper script) sets
# PWD and SHLVL; macOS sets __CF_USER_TEXT_ENCODING. Anything else fails.
ALLOWED_ENV="DO_NOT_TRACK HOME OPENCLAW_CONFIG_PATH OPENCLAW_DEV_TOKEN OPENCLAW_PROFILE OPENCLAW_STATE_DIR PATH TMPDIR OPENCLAW_CLI OPENCLAW_GATEWAY_PORT OPENCLAW_PATH_BOOTSTRAPPED PWD SHLVL __CF_USER_TEXT_ENCODING"

# exec, so that `(clean_env cmd) &` leaves $! pointing at the real process.
clean_env() {
  exec env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE_BIN")" \
    TMPDIR="${TMPDIR:-/tmp}" DO_NOT_TRACK=1 OPENCLAW_DEV_TOKEN="$(cat "$RUN_DIR/token")" \
    OPENCLAW_PROFILE="$PROFILE" OPENCLAW_STATE_DIR="$STATE" OPENCLAW_CONFIG_PATH="$CONFIG" "$@"
}
oc() { (clean_env "$OPENCLAW_BIN" --profile "$PROFILE" "$@"); }

# Refuse state we did not create, or state that could hold credentials.
check_state() {
  if [ -L "$STATE" ]; then echo "refusing: $STATE is a symlink" >&2; exit 3; fi
  [ -e "$STATE" ] || return 0
  if [ ! -f "$MARKER" ]; then
    echo "refusing: $STATE exists and was not created by this script (no marker)" >&2; exit 3
  fi
  local found
  found="$(find "$STATE" -maxdepth 4 \( -name '.env' -o -name '*.env' -o -name 'auth-profiles*.json' \
    -o -path "$STATE/credentials/*" \) -print 2>/dev/null | head -5)"
  if [ -n "$found" ]; then
    echo "refusing: $STATE holds env or credential files:" >&2; echo "$found" >&2; exit 3
  fi
}

wait_gone() { # pid seconds
  for _ in $(seq 1 "$2"); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done
  return 1
}

case "${1:-}" in
  start)
    check_state
    mkdir -p "$RUN_DIR"
    [ -s "$RUN_DIR/token" ] || openssl rand -hex 16 > "$RUN_DIR/token"
    chmod 600 "$RUN_DIR/token"
    mkdir -p "$STATE"
    chmod 700 "$STATE"
    : > "$MARKER"
    sed -e "s#<CHECKOUT>#$CHECKOUT#g" "$HERE/openclaw.dev.json" > "$CONFIG"
    (clean_env "$NODE_BIN" "$HERE/fake-openai.mjs" --port 19102 > "$RUN_DIR/fake.log" 2>&1) &
    echo $! > "$RUN_DIR/fake.pid"
    oc config validate
    (clean_env "$OPENCLAW_BIN" --profile "$PROFILE" gateway run --port "$PORT" > "$RUN_DIR/gateway.log" 2>&1) &
    echo $! > "$RUN_DIR/gateway.pid"
    for _ in $(seq 1 90); do
      grep -q '\[gateway\] ready' "$RUN_DIR/gateway.log" 2>/dev/null && break
      sleep 1
    done
    grep -q '\[gateway\] ready' "$RUN_DIR/gateway.log" || { echo "gateway did not become ready" >&2; exit 1; }
    echo "gateway ready on ws://127.0.0.1:$PORT (pid $(cat "$RUN_DIR/gateway.pid")); state $STATE; token in $RUN_DIR/token"
    ;;
  check-env)
    # The probe plugin reports Object.keys(process.env) from inside the gateway,
    # that is, after OpenClaw's own .env and config loaders have run.
    out="$(oc gateway call clawtrate-probe.envNames --json --params '{}' --expect-url "ws://127.0.0.1:$PORT" 2>&1)" || { echo "$out" >&2; exit 1; }
    names="$(printf '%s' "$out" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s.slice(s.indexOf("{")));console.log((j.names??j.result?.names??[]).join("\n"))})')"
    echo "$names"
    extra="$(printf '%s\n' "$names" | grep -v -x -F -f <(printf '%s\n' $ALLOWED_ENV) || true)"
    if [ -n "$extra" ]; then echo "UNEXPECTED variables in the gateway: $extra" >&2; exit 4; fi
    echo "ok: the gateway sees only the launcher's variables"
    ;;
  stop)
    for name in gateway fake; do
      pidfile="$RUN_DIR/$name.pid"
      [ -f "$pidfile" ] || continue
      pid="$(cat "$pidfile")"
      children="$(pgrep -P "$pid" || true)"
      kill -TERM "$pid" 2>/dev/null || true
      # The gateway can outlive SIGTERM while plugin services dispose.
      wait_gone "$pid" 60 || { kill -KILL "$pid" 2>/dev/null || true; wait_gone "$pid" 5 || true; }
      for c in $children; do kill -0 "$c" 2>/dev/null && kill -TERM "$c" 2>/dev/null || true; done
      rm -f "$pidfile"
    done
    echo "stopped"
    ;;
  reset)
    [ -f "$RUN_DIR/gateway.pid" ] && { echo "stop the gateway first" >&2; exit 3; }
    [ -e "$STATE" ] || { echo "nothing to reset"; exit 0; }
    [ -f "$MARKER" ] && [ ! -L "$STATE" ] || { echo "refusing: $STATE has no launcher marker" >&2; exit 3; }
    rm -rf "$STATE"
    echo "removed $STATE"
    ;;
  *)
    echo "usage: PROFILE=<name>-dev|<name>-probe $0 start|check-env|stop|reset" >&2
    exit 2
    ;;
esac
