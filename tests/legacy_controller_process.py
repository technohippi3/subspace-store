"""Run an unchanged old controller against recording ports and real history."""
import base64
import hashlib
import json
from pathlib import Path
import sys

source, database, journal_file, mode = sys.argv[1:]
sys.path.insert(0, source)
from controller.core import Controller, Clients
from controller.journal import Journal

calls = []
def forbidden():
    calls.append("native")
    raise AssertionError("legacy native port reached")
class Registry:
    bound_entries = True
    def entry_status(self, *args, **kwargs):
        calls.append("registry")
        raise AssertionError("legacy registry effect reached")

if mode == "remote":
    from controller.recovery_backend import RemoteJournal
    class Backend:
        def request(self, request):
            if request["op"] != "journal-read":
                calls.append(request["op"])
                raise AssertionError("legacy remote mutation reached")
            rows = Path(journal_file).read_bytes().splitlines()
            after = request["after"]
            return dict(head=len(rows), entries=[dict(sequence=i + 1, sha256=hashlib.sha256(row).hexdigest(), data=base64.b64encode(row).decode())
                        for i, row in list(enumerate(rows))[after:after + request["limit"]]])
    journal = RemoteJournal(Backend())
else:
    path = Path(journal_file)
    journal = Journal(path.parent, path.stem)
try:
    c = Controller(database, journal, Registry(), Clients(forbidden, forbidden, forbidden, forbidden),
                   None, Path(database).parent / "unused-verifier", Path(database).parent / "work", "mock-wallet",
                   snapshot_dir=Path(database).parent / "snapshots")
    c.close()
    print(json.dumps(dict(opened=True, calls=calls)))
except Exception as error:
    print(json.dumps(dict(opened=False, error=type(error).__name__, calls=calls)))
