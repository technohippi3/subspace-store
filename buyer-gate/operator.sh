#!/usr/bin/env bash
# The buyer gate's test operator (docs/BUYER-GATE.md, P2), on mainnet, on
# the workspace_owner's own machine.
#
# spaced v0.5.0 and subs at 4dcc923, the pinned builds in regtest/.cache/bin
# (regtest/fetch.sh), run inside their own unprivileged user, network and
# mount namespaces. slirp4netns gives that namespace outbound access only:
# nothing outside it can connect in, it can't reach the host's loopback
# (--disable-host-loopback), and no port is forwarded. That is what confines
# subs, which binds every interface (finding R7). No host firewall, system
# or security setting is changed.
#
# State lives outside the repository, in $SUBSPACE_TEST_OPERATOR_DIR
# (default ~/.local/share/subspace-store-test-operator, mode 700):
#   bitcoin-rpc-url   the mainnet Bitcoin RPC URL, written by the
#                     workspace_owner, mode 600; passed to spaced through
#                     its environment, never on a command line;
#   spaced/ subs/     data directories; logs/ and run/.
#
# Usage:
#   buyer-gate/operator.sh start         start the namespace and spaced
#   buyer-gate/operator.sh start-subs    start subs (needs the operator wallet)
#   buyer-gate/operator.sh status        processes and spaced's sync height
#   buyer-gate/operator.sh cli ARGS...   space-cli inside the namespace
#   buyer-gate/operator.sh stop          stop everything
#
# The operator wallet is created by the workspace_owner in a terminal
# outside the Claude app, never through an agent session, the app's shell
# input or its Terminal panel, because createwallet prints its recovery
# phrase and anything shown there becomes part of the session:
#   buyer-gate/operator.sh cli --wallet "$SUBSPACE_TEST_OPERATOR_WALLET" createwallet
# $SUBSPACE_TEST_OPERATOR_WALLET names the wallet subs uses (default
# operator-2: the first `operator` wallet's phrase was shown in a session
# on 2026-11-08, so it is exposed and never used).
#
# Nothing here signs or broadcasts. Every mainnet transaction in the buyer
# gate is a separate, authorized step.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/regtest/.cache/bin"
DIR="${SUBSPACE_TEST_OPERATOR_DIR:-$HOME/.local/share/subspace-store-test-operator}"
RUN="$DIR/run"
LOGS="$DIR/logs"
SPACED_PORT=7225
SUBS_PORT=7777
WALLET="${SUBSPACE_TEST_OPERATOR_WALLET:-operator-2}"
[ "$WALLET" = operator ] && die_early=1 || die_early=0

die() { echo "operator: $*" >&2; exit 1; }
[ "$die_early" = 1 ] && die "the wallet named operator is exposed (its phrase was shown in a session); use another name"

ns_pid() { [ -f "$RUN/ns.pid" ] && kill -0 "$(cat "$RUN/ns.pid")" 2>/dev/null && cat "$RUN/ns.pid"; }

in_ns() {
  local pid; pid="$(ns_pid)" || die "not running; use: $0 start"
  nsenter --target "$pid" --user --net --mount --preserve-credentials -- "$@"
}

cookie() { in_ns sh -c "find '$DIR/spaced' -name .cookie | head -1"; }

prepare() {
  [ -d "$DIR" ] || mkdir -m 700 -p "$DIR"
  [ "$(stat -c %a "$DIR")" = 700 ] || die "$DIR must be mode 700"
  [ -s "$DIR/bitcoin-rpc-url" ] || die "write the Bitcoin RPC URL to $DIR/bitcoin-rpc-url (mode 600) first"
  [ "$(stat -c %a "$DIR/bitcoin-rpc-url")" = 600 ] || die "$DIR/bitcoin-rpc-url must be mode 600"
  for b in spaced space-cli subs; do [ -x "$BIN/$b" ] || die "missing $BIN/$b; run regtest/fetch.sh"; done
  mkdir -m 700 -p "$DIR/spaced" "$DIR/subs" "$RUN" "$LOGS"
  echo "nameserver 10.0.2.3" > "$RUN/resolv.conf"
}

start() {
  prepare
  ns_pid >/dev/null && die "already running (namespace pid $(cat "$RUN/ns.pid"))"
  # The namespace's first process waits for slirp4netns to bring up tap0,
  # points DNS at slirp4netns' resolver, then runs spaced on loopback.
  SPACED_BITCOIN_RPC_URL="$(cat "$DIR/bitcoin-rpc-url")" \
  setsid unshare --user --map-root-user --net --mount --fork -- bash -c '
    set -e
    mount --bind "$1/resolv.conf" /etc/resolv.conf
    ip link set lo up
    for _ in $(seq 60); do ip -4 addr show tap0 2>/dev/null | grep -q inet && break; sleep 0.5; done
    ip -4 addr show tap0 | grep -q inet || { echo "tap0 never came up" >&2; exit 1; }
    exec "$2/spaced" --chain mainnet --data-dir "$3/spaced" --jobs 1 \
      --block-index-full --rpc-bind 127.0.0.1 --rpc-port "$4"
  ' ns "$RUN" "$BIN" "$DIR" "$SPACED_PORT" >>"$LOGS/spaced.log" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$RUN/ns.pid"
  sleep 0.5
  setsid slirp4netns --configure --mtu=65520 --disable-host-loopback "$pid" tap0 \
    >>"$LOGS/slirp4netns.log" 2>&1 < /dev/null &
  echo $! > "$RUN/slirp.pid"
  echo "started: namespace pid $pid; spaced log $LOGS/spaced.log"
}

start_subs() {
  ns_pid >/dev/null || die "not running; use: $0 start"
  in_ns "$BIN/space-cli" --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$(cookie)" \
    --wallet "$WALLET" getwalletinfo >/dev/null 2>&1 \
    || die "no '$WALLET' wallet yet; the workspace_owner creates it: $0 cli --wallet $WALLET createwallet"
  local c; c="$(cookie)"
  in_ns setsid "$BIN/subs" --port "$SUBS_PORT" --data-dir "$DIR/subs" --wallet "$WALLET" \
    --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$c" \
    >>"$LOGS/subs.log" 2>&1 < /dev/null &
  echo "subs started inside the namespace on port $SUBS_PORT; log $LOGS/subs.log"
}

status() {
  local pid; pid="$(ns_pid)" || { echo "not running"; return 0; }
  echo "namespace pid $pid"
  in_ns sh -c 'ps -o pid=,comm= -e' | grep -E "spaced|subs" || true
  in_ns "$BIN/space-cli" --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$(cookie)" \
    getserverinfo 2>&1 | head -5 || true
}

cli() {
  in_ns "$BIN/space-cli" --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$(cookie)" "$@"
}

stop() {
  local pid
  if pid="$(ns_pid)"; then
    in_ns sh -c 'kill -TERM $(pgrep -x subs) 2>/dev/null; kill -TERM $(pgrep -x spaced) 2>/dev/null' || true
    for _ in $(seq 60); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    kill -TERM "$pid" 2>/dev/null || true
  fi
  [ -f "$RUN/slirp.pid" ] && kill -TERM "$(cat "$RUN/slirp.pid")" 2>/dev/null || true
  rm -f "$RUN/ns.pid" "$RUN/slirp.pid"
  echo "stopped"
}

case "${1:-}" in
  start) start ;;
  start-subs) start_subs ;;
  status) status ;;
  cli) shift; cli "$@" ;;
  stop) stop ;;
  *) sed -n '2,38p' "$0"; exit 2 ;;
esac
