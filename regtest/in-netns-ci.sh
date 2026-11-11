#!/usr/bin/env bash
# Hosted CI may deny unprivileged uid_map writes. Create only the network
# namespace as root, then run the qualification as the original caller.
set -euo pipefail

[[ ${CI:-} == true && ${GITHUB_ACTIONS:-} == true ]] || {
  echo 'use in-netns.sh outside hosted CI' >&2
  exit 1
}
HERE="$(cd "$(dirname "$0")" && pwd)"
caller_uid=$(id -u)
caller_gid=$(id -g)
node_binary=$(command -v node)
[[ $caller_uid != 0 ]] || { echo 'start CI qualification as an unprivileged caller' >&2; exit 1; }
cd "$HERE/../ts"
exec sudo -n -- unshare --net -- sh -eu -c '
  ip link set lo up
  exec setpriv --reuid "$1" --regid "$2" --clear-groups --no-new-privs \
    env SUBSPACE_CORE_REGTEST_ISOLATED=1 "$3" --test regtest/core.test.ts
' sh "$caller_uid" "$caller_gid" "$node_binary"
