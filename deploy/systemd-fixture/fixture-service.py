"""Disposable package protocol fixture, not store-domain evidence."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import urllib.parse

sys.path.insert(0, str(Path(__file__).parent / "native"))
from common import config, json_file, paths
from fence import acquire

role, file = sys.argv[1:]
value = config(file)
state = paths(value)
installation_owner = acquire(state["lock"], latch=state["latch"])
runtime, runner = json_file(value["storeConfig"]), json_file(value["runnerConfig"])
if role == "store":
    lock = open(runtime["database"] + ".lock", "a+")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    database = sqlite3.connect(runtime["database"], check_same_thread=False, isolation_level=None)
    database.executescript("""pragma journal_mode=WAL; pragma synchronous=FULL;
    create table if not exists store_meta(id integer primary key,version integer,store text);
    insert or ignore into store_meta values(1,1,'fixture');
    create table if not exists outbox(seq integer primary key,payload text not null,acknowledged integer);
    create table if not exists records(kind text,key text,value text,seq integer,primary key(kind,key));
    create table if not exists fixture_settings(id integer primary key,paused integer,review_count integer,reconciled integer,blocker text);
    insert or ignore into fixture_settings values(1,1,7,0,null);
    create table if not exists preserved_history(address text);
    insert into preserved_history select 'fixture-historical-payment-address' where not exists(select 1 from preserved_history);
    """)
    token = (Path(os.environ["CREDENTIALS_DIRECTORY"]) / "operator").read_text().strip()
    mutex = threading.RLock()
else:
    directory = Path(runner["subs"]["data_dir"])
    marker = directory / "starts"
    marker.write_text(str(int(marker.read_text()) + 1 if marker.exists() else 1))
    token = None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send(self, value, code=200):
        raw = json.dumps(value).encode()
        self.send_response(code)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if role != "store":
            self.send({"ready": True})
            return
        if self.server.server_port == runtime["listen"]["buyer"]:
            self.send({"fixture": True, "publicOrigin": value["publicOrigin"]})
            return
        if self.headers.get("Authorization") != "Bearer " + token:
            self.send({}, 403)
            return
        with mutex:
            paused, count, reconciled, blocker = database.execute("select paused,review_count,reconciled,blocker from fixture_settings").fetchone()
        if self.path == "/operator/status":
            self.send({"unknown_payment_history": 0,'acknowledged':True,'paused':bool(paused)})
            return
        blockers = [] if paused else [{"kind": "admission_open", "id": "global"}]
        if blocker:
            blockers.append({"kind": blocker, "id": "fixture-order"})
        if not reconciled:
            blockers.append({"kind": "restore_quarantine", "id": "global"})
        self.send({"paused": bool(paused), "reviewCount": count, "blockers": blockers, "ready": not blockers,
                   "acknowledged": True, "chain": {"height": 1, "hash": "1" * 64}})

    def do_POST(self):
        if role != "store" or self.headers.get("Authorization") != "Bearer " + token or self.path != "/operator/pause":
            self.send({}, 403)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        with mutex:
            database.execute("update fixture_settings set paused=?", (int(body["paused"]),))
        self.send({"paused": body["paused"], "acknowledged": True})


if role == "store":
    buyer = ThreadingHTTPServer(("127.0.0.1", runtime["listen"]["buyer"]), Handler)
    threading.Thread(target=buyer.serve_forever, daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", runtime["listen"]["operator"]), Handler)
else:
    server = ThreadingHTTPServer(("127.0.0.1", urllib.parse.urlsplit(runner["subs"]["url"]).port), Handler)
server.serve_forever()
