"""Generate actual controller abort history with recording native/store ports.

Run on the fixture host over encrypted SSH, then materialize the database in
the stopped guest. Guest maintenance still uses its installed encrypted client.
This is lifecycle evidence; the fixture order has no financial history.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

release, configuration = Path(sys.argv[1]), sys.argv[2]
sys.path.insert(0, str(release / 'app'))
from controller.core import Controller, Clients
from controller.preparation_history import PreparationBarrier, history
from controller.recovery_backend import RecoveryBackend, RemoteJournal
from controller.rpc import HttpError

value = json.loads(Path(configuration).read_text())
database = Path(value['database'])
with sqlite3.connect(database) as connection:
    # Replace only the empty fixture table with the real controller schema.
    if connection.execute('select count(*) from batches').fetchone() != (0,):
        raise RuntimeError('empty fixture controller required')
    connection.execute('drop table batches')

calls = []
order = dict(name='cancelled@space', recipient_spk='5120' + '1'.zfill(64), status='cancelled')
class Registry:
    def order(self, oid):
        if oid != 'o1': raise AssertionError(oid)
        return order
    def set_pending(self, members):
        calls.append(list(members))
        return True
class Native:
    def get(self, path):
        if path.endswith('/pipeline'):
            return dict(root=None, txid=None, has_pending=False, staged_count=0, commitment_idx=None,
                        steps={key:'pending' for key in ('local','proving','broadcast','confirmed','finalized','published')})
        raise HttpError('GET', path, 404, 'absent fixture member')
native = Native()
journal = RemoteJournal(RecoveryBackend(value['recoveryConfig'], release/'client/client.mjs', value['node']))
controller = Controller(database, journal, Registry(), Clients(lambda:native, lambda:native, lambda:None, lambda:None),
                        None, release/'unused-verifier', database.parent/'certificates', 'fixture-operator',
                        snapshot_dir=database.parent/'snapshots')
try:
    controller.onchain_commitment = lambda space: None
    digest = hashlib.sha256(json.dumps([(order['name'], order['recipient_spk'], 'o1')]).encode()).hexdigest()
    controller.db.execute('insert into batches(bid,space,members,digest,state) values(?,?,?,?,?)',
                          ('b1','@space',json.dumps(['o1']),digest,'frozen'))
    controller._journal('b1')
    barrier = PreparationBarrier(journal)
    batch = controller.batch('b1')
    barrier.acquire(batch)
    barrier.effect(batch, 'pending_set', [], lambda:True, pending=True)
    aborted = controller.abort_preparation('b1')
    controller.abort_preparation('b1')
    rows = journal.entries()
    assert aborted['state'] == 'rebuilt' and history(journal)[0] is None and calls == [[]]
    controller.db.execute('pragma wal_checkpoint(TRUNCATE)')
    print(json.dumps(dict(state=aborted['state'], journalPosition=len(rows), pendingClears=len(calls),
                         protocolPosition=next(row['seq'] for row in rows if row['kind']=='controller_protocol'))))
finally:
    controller.close()
