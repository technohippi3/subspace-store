"""Bounded fake upstream receipts for actual package/systemd tests."""
import json
from pathlib import Path
import sqlite3
import sys
sys.path.insert(0, str(Path(__file__).parent / "native"))
from common import config, json_file, paths
from fence import acquire

operation, file = sys.argv[1:]
value = config(file)
runtime = json_file(value["storeConfig"])
if operation == "preflight":
    print(json.dumps({"ready": True, "network": value["network"]}))
else:
    owner = acquire(paths(value)["lock"], latch=paths(value)["latch"])
    release = json.loads(Path(__file__).with_name("fixture-version.json").read_text())
    if release["fail"]:
        print(json.dumps({"ready": False, "acknowledged": False}))
        raise SystemExit(2)
    with sqlite3.connect(runtime["database"]) as database:
        if operation == "reconcile":
            database.execute("update fixture_settings set reconciled=1")
        ready = database.execute("select reconciled from fixture_settings").fetchone()[0] == 1
    runner = json_file(value["runnerConfig"])
    with sqlite3.connect(Path(runner["controller"]["dir"]) / "controller.db") as database:
        database.executescript("create table if not exists fixture_history(value text); insert into fixture_history select 'fixture-controller-history' where not exists(select 1 from fixture_history); create table if not exists batches(bid text primary key,members text,state text,root text,intent integer,attempted integer);")
    print(json.dumps({"ready": ready, "acknowledged": ready}))
