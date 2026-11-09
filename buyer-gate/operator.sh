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
# There is no PID namespace: the launcher's processes share the host's
# process list, so the launcher never finds a process by its name. When it
# starts a process it records that process's identity: its pid, its start
# time (field 22 of /proc/PID/stat, which a reused pid doesn't share), its
# executable, and for the namespace's first process the network namespace
# it created (run/ns.id), for slirp4netns the namespace pid it serves
# (run/slirp.id). Before the launcher enters or signals the namespace or
# slirp4netns, the running process must match its record exactly. spaced
# and subs are the pinned binary at its path, in the recorded network
# namespace. A missing or mismatched record leaves every process untouched.
#
# A test operator started before these records existed (run/ns.pid and
# run/slirp.pid only) is adopted once with `adopt`, without a restart:
# adopt records it only if the namespace's only child is the pinned spaced
# with this launcher's exact command line, and slirp4netns has this
# launcher's exact command line for that namespace.
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
#   buyer-gate/operator.sh status        this launcher's processes and spaced's sync height
#   buyer-gate/operator.sh cli ARGS...   space-cli inside the namespace, with one wallet
#   buyer-gate/operator.sh stop          stop this launcher's processes, and only those
#   buyer-gate/operator.sh adopt         record a test operator started before run/ns.id existed
#
# Wallets: $SUBSPACE_TEST_OPERATOR_WALLET names the operator wallet
# (default operator-2). start-subs uses it, and so does every cli call whose
# arguments name no wallet. A cli call may name another wallet once, with
# --wallet NAME, --wallet=NAME, -w NAME or -wNAME. The wallet named
# `operator` is refused wherever it is given: its phrase was shown in a
# session on 2026-11-08, so it is exposed and never used.
#
# The operator wallet is created by the workspace_owner in a terminal
# outside the Claude app, never through an agent session, the app's shell
# input or its Terminal panel, because createwallet prints its recovery
# phrase and anything shown there becomes part of the session:
#   buyer-gate/operator.sh cli createwallet
#
# Nothing here signs or broadcasts. Every mainnet transaction in the buyer
# gate is a separate, authorized step.
set -euo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BIN="$ROOT/regtest/.cache/bin"
DIR="${SUBSPACE_TEST_OPERATOR_DIR:-$HOME/.local/share/subspace-store-test-operator}"
RUN="$DIR/run"
LOGS="$DIR/logs"
SPACED_PORT=7225
SUBS_PORT=7777
EXPOSED_WALLET=operator
WALLET="${SUBSPACE_TEST_OPERATOR_WALLET:-operator-2}"

die() { echo "operator: $*" >&2; exit 1; }

refuse_wallet() {
  [ -n "$1" ] || die "empty wallet name"
  [ "$1" != "$EXPOSED_WALLET" ] || die "the wallet named $EXPOSED_WALLET is exposed (its phrase was shown in a session); use another name"
}
refuse_wallet "$WALLET"

# The exact command lines this launcher runs, arguments joined with "|".
spaced_cmdline() {
  echo "$BIN/spaced|--chain|mainnet|--data-dir|$DIR/spaced|--jobs|1|--block-index-full|--rpc-bind|127.0.0.1|--rpc-port|$SPACED_PORT|"
}
slirp_cmdline() { echo "slirp4netns|--configure|--mtu=65520|--disable-host-loopback|$1|tap0|"; }

# What the kernel says about a process; empty if it is gone or unreadable.
netns_of() { readlink "/proc/$1/ns/net" 2>/dev/null || true; }
exe_of() { readlink "/proc/$1/exe" 2>/dev/null || true; }
cmdline_of() { tr '\0' '|' < "/proc/$1/cmdline" 2>/dev/null || true; }
start_of() {
  local s; s="$(cat "/proc/$1/stat" 2>/dev/null)" || return 0
  s="${s##*) }"
  # shellcheck disable=SC2086
  set -- $s
  echo "${20:-}"
}
is_pid() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }

# record FILE PID EXTRA: write PID's identity, or fail if it can't be read.
record() {
  local start exe
  start="$(start_of "$2")"; exe="$(exe_of "$2")"
  [ -n "$start" ] && [ -n "$exe" ] && [ -n "$3" ] || die "cannot read the identity of pid $2"
  printf '%s %s %s %s\n' "$2" "$start" "$3" "$exe" > "$1"
}

# matches FILE: the pid in FILE's record, if that process is still the one
# recorded (same start time and executable).
matches() {
  local pid start extra exe
  [ -f "$1" ] || return 1
  read -r pid start extra exe < "$1" || return 1
  is_pid "$pid" && [ -n "$start" ] && [ -n "$extra" ] && [ -n "$exe" ] || return 1
  [ "$(start_of "$pid")" = "$start" ] && [ "$(exe_of "$pid")" = "$exe" ] || return 1
  echo "$pid"
}

# The namespace's first process: unshare, still the recorded process, still
# in the recorded network namespace, which isn't the host's.
ns_pid() {
  local pid net
  pid="$(matches "$RUN/ns.id")" || return 1
  read -r _ _ net _ < "$RUN/ns.id"
  [ "$(basename "$(exe_of "$pid")")" = unshare ] || return 1
  [ "$(netns_of "$pid")" = "$net" ] && [ "$net" != "$(netns_of $$)" ] || return 1
  echo "$pid"
}

# slirp4netns: still the recorded process, with this launcher's command
# line for the recorded namespace pid.
slirp_pid() {
  local pid target
  pid="$(matches "$RUN/slirp.id")" || return 1
  read -r _ _ target _ < "$RUN/slirp.id"
  [ "$(basename "$(exe_of "$pid")")" = slirp4netns ] || return 1
  [ "$(cmdline_of "$pid")" = "$(slirp_cmdline "$target")" ] || return 1
  echo "$pid"
}

# gone FILE: the process FILE records no longer exists (no record, no such
# pid, or the pid now belongs to a later process).
gone() {
  local pid start
  [ -f "$1" ] || return 0
  read -r pid start _ < "$1" || return 0
  is_pid "$pid" || return 0
  [ "$(start_of "$pid")" != "$start" ]
}

# own_pids EXE NETNS: processes running the binary EXE (also when it was
# replaced on disk since) in the network namespace NETNS. Only processes
# that pass both tests are this launcher's; a name alone never counts.
own_pids() {
  local p e
  for p in /proc/[0-9]*; do
    p="${p#/proc/}"
    e="$(exe_of "$p")"
    [ "$e" = "$1" ] || [ "$e" = "$1 (deleted)" ] || continue
    [ "$(netns_of "$p")" = "$2" ] && echo "$p"
  done
  return 0
}

no_namespace() {
  if [ -f "$RUN/ns.pid" ] && [ ! -f "$RUN/ns.id" ]; then
    die "run/ns.pid has no identity record; if that test operator is running, record it once with: $0 adopt"
  fi
  die "no running namespace matches run/ns.id; use: $0 start"
}

in_ns() {
  local pid; pid="$(ns_pid)" || no_namespace
  nsenter --target "$pid" --user --net --mount --preserve-credentials -- "$@"
}

cookie() { in_ns sh -c "find '$DIR/spaced' -name .cookie | head -1"; }

# select_wallet ARGS...: CLI_ARGS gets ARGS with exactly one wallet. The
# wallet given in ARGS, if there is one, else $WALLET. space-cli's --wallet
# is a global option, so every argument is checked, wherever it is.
select_wallet() {
  local -a args=("$@")
  local i=0 n=${#args[@]} a v given=0
  CLI_ARGS=()
  while [ "$i" -lt "$n" ]; do
    a="${args[$i]}"
    case "$a" in
      --wallet|-w)
        [ $((i + 1)) -lt "$n" ] || die "$a needs a wallet name"
        v="${args[$((i + 1))]}"
        CLI_ARGS+=("$a" "$v"); i=$((i + 2)) ;;
      --wallet=*) v="${a#--wallet=}"; CLI_ARGS+=("$a"); i=$((i + 1)) ;;
      -w*) v="${a#-w}"; v="${v#=}"; CLI_ARGS+=("$a"); i=$((i + 1)) ;;
      --w*) die "unrecognised option $a; name a wallet with --wallet NAME" ;;
      -[!-]*w*) die "give the wallet on its own, as -w NAME or --wallet NAME, not in $a" ;;
      *) CLI_ARGS+=("$a"); i=$((i + 1)); continue ;;
    esac
    refuse_wallet "$v"
    given=$((given + 1))
  done
  [ "$given" -le 1 ] || die "more than one wallet given"
  if [ "$given" = 0 ]; then
    CLI_ARGS=(--wallet "$WALLET" ${CLI_ARGS[@]+"${CLI_ARGS[@]}"})
  fi
}

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
  ns_pid >/dev/null && die "already running (namespace pid $(ns_pid))"
  [ ! -f "$RUN/ns.pid" ] && [ ! -f "$RUN/slirp.pid" ] \
    || die "run/ns.pid or run/slirp.pid is from a launcher without identity records; adopt that test operator ($0 adopt) or, once it is confirmed stopped, remove them"
  for f in "$RUN/ns.id" "$RUN/slirp.id"; do
    gone "$f" || die "$f names a process that is still running but doesn't match its record; nothing started"
  done
  rm -f "$RUN/ns.id" "$RUN/slirp.id"
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
  local pid=$! host net=""
  host="$(netns_of $$)"
  for _ in $(seq 20); do
    net="$(netns_of "$pid")"
    [ -n "$net" ] && [ "$net" != "$host" ] && break
    net=""; sleep 0.25
  done
  [ -n "$net" ] || die "the namespace did not come up (pid $pid); see $LOGS/spaced.log"
  record "$RUN/ns.id" "$pid" "$net"
  setsid slirp4netns --configure --mtu=65520 --disable-host-loopback "$pid" tap0 \
    >>"$LOGS/slirp4netns.log" 2>&1 < /dev/null &
  local slirp=$!
  for _ in $(seq 20); do
    [ "$(cmdline_of "$slirp")" = "$(slirp_cmdline "$pid")" ] && break
    sleep 0.05
  done
  record "$RUN/slirp.id" "$slirp" "$pid"
  slirp_pid >/dev/null || die "slirp4netns (pid $slirp) doesn't match its record; see $LOGS/slirp4netns.log"
  echo "started: namespace pid $pid; spaced log $LOGS/spaced.log"
}

# adopt: record a test operator started before identity records existed,
# from its run/ns.pid and run/slirp.pid, if the processes prove to be it.
adopt() {
  local pid net kids slirp
  [ ! -f "$RUN/ns.id" ] && [ ! -f "$RUN/slirp.id" ] || die "identity records already exist; nothing adopted"
  [ -f "$RUN/ns.pid" ] && [ -f "$RUN/slirp.pid" ] || die "no run/ns.pid and run/slirp.pid to adopt"
  pid="$(cat "$RUN/ns.pid")"; slirp="$(cat "$RUN/slirp.pid")"
  is_pid "$pid" && is_pid "$slirp" || die "run/ns.pid or run/slirp.pid is not a pid"
  [ "$(exe_of "$pid")" = "$(readlink -f "$(command -v unshare)")" ] \
    || die "pid $pid is not unshare; nothing adopted"
  net="$(netns_of "$pid")"
  [ -n "$net" ] && [ "$net" != "$(netns_of $$)" ] || die "pid $pid is in the host's network namespace; nothing adopted"
  kids="$(pgrep -P "$pid" || true)"
  [ -n "$kids" ] && [ "$(echo "$kids" | wc -l)" = 1 ] || die "pid $pid does not have exactly one child; nothing adopted"
  [ "$(exe_of "$kids")" = "$BIN/spaced" ] && [ "$(netns_of "$kids")" = "$net" ] \
    && [ "$(cmdline_of "$kids")" = "$(spaced_cmdline)" ] \
    || die "pid $pid's child is not this launcher's spaced; nothing adopted"
  [ "$(exe_of "$slirp")" = "$(readlink -f "$(command -v slirp4netns)")" ] \
    && [ "$(cmdline_of "$slirp")" = "$(slirp_cmdline "$pid")" ] \
    || die "pid $slirp is not this launcher's slirp4netns for pid $pid; nothing adopted"
  [ "$(start_of "$slirp")" -ge "$(start_of "$pid")" ] || die "pid $slirp started before pid $pid; nothing adopted"
  record "$RUN/ns.id" "$pid" "$net"
  record "$RUN/slirp.id" "$slirp" "$pid"
  ns_pid >/dev/null && slirp_pid >/dev/null || { rm -f "$RUN/ns.id" "$RUN/slirp.id"; die "records don't verify; nothing adopted"; }
  rm -f "$RUN/ns.pid" "$RUN/slirp.pid"
  echo "adopted: namespace pid $pid ($net), spaced pid $kids, slirp4netns pid $slirp"
}

start_subs() {
  local pid; pid="$(ns_pid)" || no_namespace
  [ -z "$(own_pids "$BIN/subs" "$(netns_of "$pid")")" ] || die "subs is already running"
  in_ns "$BIN/space-cli" --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$(cookie)" \
    --wallet "$WALLET" getwalletinfo >/dev/null 2>&1 \
    || die "no '$WALLET' wallet yet; the workspace_owner creates it in a terminal outside the Claude app: $0 cli createwallet"
  local c; c="$(cookie)"
  in_ns setsid "$BIN/subs" --port "$SUBS_PORT" --data-dir "$DIR/subs" --wallet "$WALLET" \
    --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$c" \
    >>"$LOGS/subs.log" 2>&1 < /dev/null &
  echo "subs started inside the namespace on port $SUBS_PORT; log $LOGS/subs.log"
}

status() {
  local pid net p
  if ! pid="$(ns_pid)"; then
    if [ -f "$RUN/ns.pid" ] && [ ! -f "$RUN/ns.id" ]; then
      echo "run/ns.pid has no identity record; see: $0 adopt"
    elif [ -f "$RUN/ns.id" ]; then
      echo "run/ns.id matches no running process"
    else
      echo "not running"
    fi
    return 0
  fi
  net="$(netns_of "$pid")"
  echo "namespace pid $pid ($net)"
  for b in spaced subs; do
    for p in $(own_pids "$BIN/$b" "$net"); do echo "$b pid $p"; done
  done
  p="$(slirp_pid)" && echo "slirp4netns pid $p" || echo "slirp4netns: no running process matches run/slirp.id"
  in_ns "$BIN/space-cli" --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$(cookie)" \
    getserverinfo 2>&1 | head -5 || true
}

cli() {
  select_wallet "$@"
  in_ns "$BIN/space-cli" --rpc-url "http://127.0.0.1:$SPACED_PORT" --rpc-cookie "$(cookie)" \
    "${CLI_ARGS[@]}"
}

# term_and_wait SECONDS PID...: SIGTERM each, then wait for them to exit.
# Each pid comes from a check just before.
term_and_wait() {
  local secs=$1 p left; shift
  [ $# -gt 0 ] || return 0
  kill -TERM "$@" 2>/dev/null || true
  for _ in $(seq $((secs * 2))); do
    left=0
    for p in "$@"; do [ -d "/proc/$p" ] && left=1; done
    [ "$left" = 0 ] && return 0
    sleep 0.5
  done
  return 1
}

stop() {
  local pid net s left
  if ! pid="$(ns_pid)"; then
    if [ -f "$RUN/ns.id" ] || [ -f "$RUN/slirp.id" ] || [ -f "$RUN/ns.pid" ] || [ -f "$RUN/slirp.pid" ]; then
      die "no running namespace matches its identity record (run/ns.id); nothing signalled, run records left as they are"
    fi
    echo "not running"
    return 0
  fi
  net="$(netns_of "$pid")"
  # subs first, then spaced; each is found again just before it is signalled.
  # shellcheck disable=SC2046
  term_and_wait 30 $(own_pids "$BIN/subs" "$net") || true
  # shellcheck disable=SC2046
  term_and_wait 60 $(own_pids "$BIN/spaced" "$net") || true
  left="$(own_pids "$BIN/subs" "$net") $(own_pids "$BIN/spaced" "$net")"
  if [ -n "${left// /}" ]; then
    die "still running after SIGTERM: pids $left; nothing else signalled"
  fi
  # The namespace's first process (unshare --fork, which ignores SIGTERM)
  # exits once spaced has; it is waited for, not signalled.
  for _ in $(seq 10); do gone "$RUN/ns.id" && break; sleep 0.5; done
  if gone "$RUN/ns.id"; then
    rm -f "$RUN/ns.id"
  else
    echo "the namespace's first process (pid $pid) is still running; not signalled" >&2
  fi
  if s="$(slirp_pid)"; then
    term_and_wait 10 "$s" || true
  elif ! gone "$RUN/slirp.id"; then
    echo "slirp4netns: the process run/slirp.id names doesn't match its record; not signalled" >&2
  fi
  gone "$RUN/slirp.id" && rm -f "$RUN/slirp.id"
  [ -f "$RUN/ns.id" ] || [ -f "$RUN/slirp.id" ] && die "stopped what matched; run records left for what didn't"
  echo "stopped"
}

# Sourced (by tests/test_operator_launcher.py): define the functions only.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

case "${1:-}" in
  start) start ;;
  start-subs) start_subs ;;
  status) status ;;
  cli) shift; cli "$@" ;;
  stop) stop ;;
  adopt) adopt ;;
  *) sed -n '2,/^set -euo pipefail$/p' "$0" | sed '$d'; exit 2 ;;
esac
