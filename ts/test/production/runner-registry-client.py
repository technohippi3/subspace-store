"""Exercise the shipped runner HTTP client and controller send guard.

Called by the TypeScript integration suite with made-up credentials and a
real loopback store. Subs is a recording stand-in, not a Bitcoin broadcaster.
"""
import json
import sys
from types import SimpleNamespace
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from controller.core import Controller, Refused
from runner.store import TypeScriptStore


class SendGate:
    _issuance_acknowledged = Controller._issuance_acknowledged
    _send = Controller._send

    def __init__(self, registry, controller_ack):
        self.registry, self.controller_ack = registry, controller_ack
        self.journal = SimpleNamespace(down=lambda: not controller_ack)
        self.sent = 0
        self.row = dict(bid="b1", space="@space", root="a" * 64, entry_key="1" * 32,
                        delegate_in="mock-delegate", members=["o1"], intent=1,
                        fee_rate=1, attempted=0, state="issuing")
        self.subs = self

    def batch(self, _):
        return self.row.copy()

    def acknowledged(self, _):
        return self.row.copy() if self.controller_ack else None

    def _save(self, _, **fields):
        self.row.update(fields)

    def post(self, *_args, **_kwargs):
        self.sent += 1
        return json.dumps({"txid": "a" * 64})

    def capture_bytes(self, _):
        pass


mode, url, token, database, journal = sys.argv[1:]
store = TypeScriptStore(url, token, database, journal)
if mode == "inspect":
    assert store.converted_orders() == ["o1"]
    assert store.order("o1")["name"] == "n0@space"
    assert store.batch_entry_ok("o1")
    store.set_pending(["o1"])
    assert store.entry_status(dict(entry_key="1" * 32, root="a" * 64, members=["o1"]), create=True)["acknowledged"]
    assert store.issuing_recheck_ok("o1")
    assert store.acknowledged_status("o1") == "issuing"
    assert store.journal.position() > 0
    print(json.dumps({"ok": True}))
else:
    gate = SendGate(store, mode != "controller-down")
    try:
        gate._send("b1")
    except Refused:
        assert gate.sent == 0 and gate.row["attempted"] == 0
    print(json.dumps({"sent": gate.sent, "attempted": gate.row["attempted"]}))
