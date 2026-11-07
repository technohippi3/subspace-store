"""A small simulated Bitcoin chain for the reference model.

Transactions spend outpoints and create outputs. Blocks are validated, so a
double spend can never be mined and a child can't be mined before its parent.
Conflicts and dependencies between transactions are therefore real, not
flags. Depth is always derived from the current best chain.

An input whose transaction id the chain has never seen is an external coin,
such as a buyer's wallet output. It can be spent once.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Tx:
    txid: str
    inputs: tuple  # outpoints: (txid, vout)
    outputs: tuple  # (script, value)


class ChainError(Exception):
    pass


class Chain:
    def __init__(self, base_height=1000):
        self.base = base_height
        self.blocks = []  # blocks[i] holds the txids mined at base + 1 + i
        self.txs = {}
        self.mempool = []
        self._pos = {}  # txid -> (height, index), rebuilt whenever blocks change

    def _reindex(self):
        self._pos = {txid: (self.base + 1 + i, j)
                     for i, block in enumerate(self.blocks)
                     for j, txid in enumerate(block)}

    # Heights and positions

    @property
    def tip(self):
        return self.base + len(self.blocks)

    def position(self, txid):
        return self._pos.get(txid)

    def conf(self, txid):
        """Conventional confirmations: 0 when unmined, 1 in the tip block."""
        pos = self.position(txid)
        return 0 if pos is None else self.tip - pos[0] + 1

    def in_mempool(self, txid):
        return txid in self.mempool

    # Spends

    def _mined_spends(self, upto=None):
        spends = {}
        blocks = self.blocks if upto is None else self.blocks[:upto]
        for block in blocks:
            for txid in block:
                for op in self.txs[txid].inputs:
                    spends[op] = txid
        return spends

    def mined_spends(self):
        """Every mined spend on the best chain: outpoint -> spending txid."""
        return self._mined_spends()

    def spender(self, outpoint):
        """The mined transaction spending an outpoint, or None."""
        return self._mined_spends().get(outpoint)

    def _check(self, tx, spends, mined_ids):
        for op in tx.inputs:
            if op in spends and spends[op] != tx.txid:
                return False
            parent = op[0]
            if parent in self.txs:
                if parent not in mined_ids:
                    return False
                if op[1] >= len(self.txs[parent].outputs):
                    return False
        return True

    # Mutations

    def add(self, tx):
        """Register a transaction and put it in the mempool (a broadcast)."""
        known = self.txs.get(tx.txid)
        if known is not None and known != tx:
            raise ChainError(f"txid reused: {tx.txid}")
        self.txs[tx.txid] = tx
        if self.position(tx.txid) is None and tx.txid not in self.mempool:
            self.mempool.append(tx.txid)

    def drop(self, txid):
        """Remove a transaction from the mempool, as an eviction would."""
        if txid in self.mempool:
            self.mempool.remove(txid)

    def mine(self, txids=None):
        """Mine one block.

        With txids=None, include every valid mempool transaction in mempool
        order. With an explicit list, every listed transaction must be valid,
        or ChainError is raised and nothing changes.
        """
        spends = self._mined_spends()
        mined_ids = {t for b in self.blocks for t in b}
        block = []
        candidates = list(self.mempool) if txids is None else list(txids)
        for txid in candidates:
            tx = self.txs.get(txid)
            if tx is None:
                raise ChainError(f"unknown tx {txid}")
            if txid in mined_ids:
                raise ChainError(f"already mined {txid}")
            if self._check(tx, spends, mined_ids):
                block.append(txid)
                mined_ids.add(txid)
                for op in tx.inputs:
                    spends[op] = txid
            elif txids is not None:
                raise ChainError(f"invalid in block: {txid}")
        self.blocks.append(block)
        self._reindex()
        self._purge_mempool()
        return block

    def mine_empty(self, n=1):
        for _ in range(n):
            self.mine([])

    def reorg(self, depth, new_blocks):
        """Replace the last `depth` blocks with `new_blocks`, atomically.

        Each entry of `new_blocks` is a list of txids, or None to mine every
        valid mempool transaction. Transactions from removed blocks return to
        the mempool unless the new chain conflicts with them.
        """
        if depth > len(self.blocks):
            raise ChainError("reorg deeper than the simulated chain")
        removed = self.blocks[len(self.blocks) - depth:]
        self.blocks = self.blocks[: len(self.blocks) - depth]
        self._reindex()
        for block in removed:
            for txid in block:
                if txid not in self.mempool:
                    self.mempool.append(txid)
        for txids in new_blocks:
            self.mine(txids)
        self._purge_mempool()

    def _purge_mempool(self):
        spends = self._mined_spends()
        mined_ids = {t for b in self.blocks for t in b}
        keep = []
        for txid in self.mempool:
            if txid in mined_ids:
                continue
            tx = self.txs[txid]
            if any(op in spends and spends[op] != txid for op in tx.inputs):
                continue
            keep.append(txid)
        self.mempool = keep

    # Queries used by the store

    def outputs_to(self, script):
        """Every output paying `script`, mined or in the mempool."""
        found = []
        for txid, tx in self.txs.items():
            mined = self.position(txid) is not None
            if not mined and txid not in self.mempool:
                continue
            for vout, (spk, value) in enumerate(tx.outputs):
                if spk == script:
                    found.append({"outpoint": (txid, vout), "value": value,
                                  "conf": self.conf(txid)})
        return found

    def ancestors(self, tx):
        """`tx` plus every known transaction it depends on."""
        seen = {tx.txid: tx}
        stack = [tx]
        while stack:
            cur = stack.pop()
            for op in cur.inputs:
                parent = self.txs.get(op[0])
                if parent is not None and parent.txid not in seen:
                    seen[parent.txid] = parent
                    stack.append(parent)
        return list(seen.values())

    def exclusive(self, a, b):
        """True if `a` and `b` can never both be mined on any one chain.

        That holds when some transaction `a` depends on (or `a` itself) and some
        transaction `b` depends on (or `b` itself) are different transactions
        spending the same outpoint.
        """
        for x in self.ancestors(a):
            for y in self.ancestors(b):
                if x.txid != y.txid and set(x.inputs) & set(y.inputs):
                    return True
        return False
