"""The store's operator API, as the runner and the controller use it.

This is the controller's registry interface (`CONTROLLER-DESIGN.md`) served
by the store service over HTTP with the operator's bearer token. It never
holds or uses an order link. The read-only database connection and the
store journal are for the controller's coordinated snapshot only, which
runs on the store's host.
"""

import base64
import json
import sqlite3
from pathlib import Path

from controller.journal import Journal
from controller.rpc import Http, HttpError


class Refused(Exception):
    pass


class Store:
    def __init__(self, url, token_file, db_path, journal_dir):
        self.url = url
        self.token_file = Path(token_file)
        self.db_path = Path(db_path)
        self.journal = Journal(journal_dir, "store")
        self._db = None

    @property
    def db(self):
        if self._db is None:
            self._db = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True,
                                       check_same_thread=False)
            self._db.row_factory = sqlite3.Row
        return self._db

    def op(self, method, path, body=None):
        http = Http(self.url, timeout=120, token=self.token_file.read_text().strip())
        try:
            return http.request(method, path, body)
        except HttpError as e:
            if e.status in (404, 409):
                try:
                    raise Refused(json.loads(e.body)["error"])
                except (ValueError, KeyError):
                    raise Refused(e.body)
            raise

    # The controller's registry interface

    def observe(self):
        self.op("POST", "/operator/observe")

    def order(self, oid):
        o = self.op("GET", f"/operator/orders/{oid}")
        o["pay_address"] = o.get("dest_address")
        return o

    def converted_orders(self):
        self.observe()
        return self.op("GET", "/operator/orders?status=converted")["orders"]

    def batch_entry_ok(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/batch-entry")["batch_entry"]

    def issuing_recheck_ok(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/batch-entry")["issuing_recheck"]

    def mark_issuing(self, oids):
        return self.op("POST", "/operator/issuing", {"oids": list(oids)})["acknowledged"]

    def acknowledged_status(self, oid):
        return self.order(oid)["journaled_status"]

    def journal_ok(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/journal")["acknowledged"]

    def set_pending(self, oids):
        self.op("POST", "/operator/pending", {"oids": list(oids)})

    def _transition(self, oid, action):
        self.op("POST", f"/operator/orders/{oid}/transition", {"action": action})

    def unissue(self, oid):
        self._transition(oid, "unissue")

    def restore_issuing(self, oid):
        self._transition(oid, "restore_issuing")

    def unready(self, oid):
        self._transition(oid, "unready")

    def mark_ready(self, oid):
        self._transition(oid, "mark_ready")

    def mark_fulfilled(self, oid):
        self._transition(oid, "mark_fulfilled")

    # The runner's own calls

    def status(self):
        return self.op("GET", "/operator/status")

    def alerts(self):
        return self.op("GET", "/operator/alerts")["alerts"]

    def orders(self, status=None):
        path = "/operator/orders" + (f"?status={status}" if status else "")
        return self.op("GET", path)["orders"]

    def cancel(self, oid):
        return self.op("POST", f"/operator/orders/{oid}/cancel")

    def refund(self, oid, kind):
        return self.op("POST", f"/operator/orders/{oid}/refunds", {"kind": kind})

    def broadcast(self, gid, txid=None):
        return self.op("POST", f"/operator/refunds/{gid}/broadcast", {"txid": txid})

    def deliver_certificate(self, oid, message):
        return self.op("POST", f"/operator/orders/{oid}/certificate",
                       {"message_b64": base64.b64encode(message).decode()})
