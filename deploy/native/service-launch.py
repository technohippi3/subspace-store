#!/usr/bin/env python3
"""The same lifetime fence precedes every shipped service invocation."""
import argparse
import os
from pathlib import Path
import sys
from common import config, expand, paths
from fence import acquire

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("role", choices=("store", "subs", "proxy"))
    args = parser.parse_args()
    try:
        value = config(args.config)
        state = paths(value)
        if args.role!='subs' and os.path.lexists(state['lock'].parent/'recovery.json'):
            raise RuntimeError('attended recovery is active')
        ownership = acquire(state["lock"], latch=state["latch"])
        if args.role=='subs':
            subs_owner=acquire(state['subsLock'],latch=state['subsLatch'])
        release = Path(value["currentPath"]).resolve(strict=True)
        command = expand(value, release, value["services"][args.role]["command"])
        os.environ["SUBSPACE_MAINTENANCE_LOCK"] = str(state["lock"])
        os.environ["SUBSPACE_MAINTENANCE_LATCH"] = str(state["latch"])
        os.chdir(release)
        os.execv(command[0], command)
    except Exception:
        sys.stderr.write("service start refused by installation lifecycle\n")
        raise SystemExit(75)
