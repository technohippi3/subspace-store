#!/usr/bin/env bash
# Run a command inside a new unprivileged user and network namespace with
# loopback only (unshare -rn). Nothing outside the host can reach the
# processes started in it, and they can reach nothing outside: subs binds
# every interface (finding R7), and this is what confines it. It changes no
# host firewall, system or security setting.
set -euo pipefail
exec unshare -rn sh -c 'ip link set lo up && exec "$@"' sh "$@"
