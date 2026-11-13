"""Durable binding-failure throttle. No transaction construction or send."""
import re
from .errors import Refused

class RebuildGuard:
    def _rebuild_guard_rows(self):
        rows=[e for e in self.journal.entries() if e['kind']=='rebuild_guard']
        for e in rows:
            if set(e)!={'seq','kind','version','count','last_bid','paused_at','paused_bid'} or type(e['seq']) is not int or e['seq']<1 or type(e['version']) is not int or e['version']!=1 or type(e['count']) is not int or e['count']<0:
                raise Refused('invalid rebuild guard history')
            named=lambda value:isinstance(value,str) and re.fullmatch(r'b[1-9][0-9]*',value) is not None
            if e['count']==0:
                valid=e['last_bid'] is None and e['paused_at'] is None and e['paused_bid'] is None
            elif e['count']<3:
                valid=named(e['last_bid']) and e['paused_at'] is None and e['paused_bid'] is None
            else:
                valid=named(e['last_bid']) and e['paused_bid']==e['last_bid'] and type(e['paused_at']) is int and e['paused_at']>=0
            if not valid:
                raise Refused('invalid rebuild guard history')
        return rows

    def _rebuild_policy(self):
        rows=self._rebuild_guard_rows()
        return rows[-1] if rows else dict(count=0,last_bid=None,paused_at=None,paused_bid=None)

    def _require_rebuild_gate(self):
        policy=self._rebuild_policy()
        if policy['paused_at'] is not None and self.tip() <= policy['paused_at']:
            raise Refused('three rebuilds in a row: paused until the next block')

    def _note_failed_rebuild(self,bid):
        rows=self._rebuild_guard_rows()
        if any(row['last_bid']==bid for row in rows):
            return
        policy=rows[-1] if rows else dict(count=0,last_bid=None,paused_at=None,paused_bid=None)
        count=policy['count']+1
        self.journal.append('rebuild_guard',version=1,count=count,last_bid=bid,
                            paused_at=self.tip() if count>=3 else None,
                            paused_bid=bid if count>=3 else None)

    def _reset_rebuild_guard(self):
        if self._rebuild_policy()['count']:
            self.journal.append('rebuild_guard',version=1,count=0,last_bid=None,paused_at=None,paused_bid=None)

    def _paused_rebuild(self,bid):
        # A retired paused batch never acquires a successor on a late retry,
        # even after a later successful issuance resets the global count.
        return any(e['kind']=='rebuild_guard' and e.get('paused_bid')==bid for e in self._rebuild_guard_rows())

    def pause_missing_commitment_bytes(self,bid):
        b=self.batch(bid)
        if not b['recovery_paused']:
            self._atomically(
                ("update batches set recovery_paused=1 where bid=?",(bid,)),
                ("insert into alerts(kind,bid,detail) values('recovery_paused',?,'no journaled commitment bytes')",(bid,)))
        self._journal(bid)
