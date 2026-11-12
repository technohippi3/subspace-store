"""Real runner/client transport; the surrounding test supplies recording RPCs."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))
from runner.cli import Runner
from runner.store import TypeScriptStore

mode, url, token, database, journal, gid, txid = sys.argv[1:]
store = TypeScriptStore(url, token, database, journal)
runner = Runner(store, None)
if mode == "prepare":
    result = runner.refund("o1", cause="buyer")
else:
    result = runner.broadcast_refund(gid, confirm=gid, txid=txid)
print(json.dumps(result))
