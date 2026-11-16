#!/usr/bin/env bash
# Start or stop an isolated development gateway and the scripted fake model.
#
#   PROFILE=roster-probe ./dev-gateway.sh start   # writes ~/.openclaw-$PROFILE from the template
#   PROFILE=roster-probe ./dev-gateway.sh stop
#
# The gateway runs under `env -i` with only the variables listed below, so
# provider keys in the caller's shell (OPENAI_API_KEY, ANTHROPIC_*, ...) are
# never visible to it. PIDs and the dev token live in $RUN_DIR.
set -euo pipefail

PROFILE="${PROFILE:-roster-probe}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CHECKOUT="$(cd "$HERE/../../.." && pwd)"
STATE="$HOME/.openclaw-$PROFILE"
RUN_DIR="${RUN_DIR:-${TMPDIR:-/tmp}/openclaw-$PROFILE-run}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$(command -v openclaw)}"
NODE_BIN="${NODE_BIN:-$(command -v node)}"

# exec, so that `(clean_env cmd) &` leaves $! pointing at the real process.
clean_env() {
  exec env -i HOME="$HOME" PATH="/usr/bin:/bin:/usr/sbin:/sbin:$(dirname "$NODE_BIN")" \
    TMPDIR="${TMPDIR:-/tmp}" DO_NOT_TRACK=1 OPENCLAW_DEV_TOKEN="$(cat "$RUN_DIR/token")" "$@"
}

wait_gone() { # pid seconds
  for _ in $(seq 1 "$2"); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done
  return 1
}

case "${1:-}" in
  start)
    mkdir -p "$RUN_DIR" "$STATE"
    [ -s "$RUN_DIR/token" ] || openssl rand -hex 16 > "$RUN_DIR/token"
    chmod 600 "$RUN_DIR/token"
    sed "s#<CHECKOUT>#$CHECKOUT#" "$HERE/openclaw.dev.json" > "$STATE/openclaw.json"
    (clean_env "$NODE_BIN" "$HERE/fake-openai.mjs" --port 19102 > "$RUN_DIR/fake.log" 2>&1) &
    echo $! > "$RUN_DIR/fake.pid"
    (clean_env "$OPENCLAW_BIN" --profile "$PROFILE" config validate)
    (clean_env "$OPENCLAW_BIN" --profile "$PROFILE" gateway run > "$RUN_DIR/gateway.log" 2>&1) &
    echo $! > "$RUN_DIR/gateway.pid"
    for _ in $(seq 1 60); do
      grep -q '\[gateway\] ready' "$RUN_DIR/gateway.log" 2>/dev/null && break
      sleep 1
    done
    grep -q '\[gateway\] ready' "$RUN_DIR/gateway.log" || { echo "gateway did not become ready" >&2; exit 1; }
    echo "gateway ready on ws://127.0.0.1:19101 (pid $(cat "$RUN_DIR/gateway.pid")); token in $RUN_DIR/token"
    ;;
  env)
    # Prints the variable names the gateway is started with, as a check.
    (clean_env /usr/bin/env) | cut -d= -f1 | sort
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
  *)
    echo "usage: PROFILE=<name> $0 start|stop|env" >&2
    exit 2
    ;;
esac
