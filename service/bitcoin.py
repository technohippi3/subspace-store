"""The ledger's chain view over Bitcoin Core, and the refund builder.

Positions come from the node's best chain: a transaction counts as mined
only while its block is on the active chain (`getblockheader` reports a
positive confirmation count), and as seen only while it is in the node's
mempool. Anything else contributes nothing. The node must run with
`-txindex=1`, so any transaction can be looked up by its id.

The payment wallet gives each quote a fresh bech32m destination. On regtest
the same wallet signs refunds, as the capped hot wallet of the
specification's two funding options; an owner-signed PSBT is later work
(docs/SERVICE.md).
"""

from .ledger import Refused, SendFailed, SendUncertain
from .rpc import RpcError, RpcUnreachable

DUST = 546
SETTLED = 6


def sats(btc):
    return int(round(btc * 1e8))


def btc(sats_):
    return f"{sats_ / 1e8:.8f}"


class BitcoinChainView:
    def __init__(self, node, wallet):
        self.node = node      # BitcoinRpc without a wallet path
        self.wallet = wallet  # BitcoinRpc for the payment and refund wallet
        self.refresh()

    def refresh(self):
        self._tip = self.node.call("getblockcount")
        self._mempool = set(self.node.call("getrawmempool"))
        self._tx = {}
        self._conf = {}
        self._outputs = {}
        self._spends = None

    @property
    def tip(self):
        return self._tip

    def chain_identity(self):
        """Which chain the node follows, read live: for the runner's check
        that every component is on one chain of the configured network."""
        info = self.node.call("getblockchaininfo")
        return {"network": info["chain"], "best_block_hash": info["bestblockhash"],
                "blocks": info["blocks"]}

    def _raw(self, txid):
        if txid not in self._tx:
            try:
                self._tx[txid] = self.node.call("getrawtransaction", txid, True)
            except RpcError:
                self._tx[txid] = None
        return self._tx[txid]

    def conf(self, txid):
        if txid not in self._conf:
            tx = self._raw(txid)
            c = 0
            if tx and tx.get("blockhash"):
                try:
                    header = self.node.call("getblockheader", tx["blockhash"])
                    c = max(0, header["confirmations"])
                except RpcError:
                    c = 0
            self._conf[txid] = c
        return self._conf[txid]

    def position(self, txid):
        c = self.conf(txid)
        return None if c < 1 else (self._tip - c + 1, None)

    def in_mempool(self, txid):
        return txid in self._mempool

    def _live(self, txid):
        return self.conf(txid) > 0 or txid in self._mempool

    def outputs_to(self, script):
        if script in self._outputs:
            return self._outputs[script]
        address = self.node.call("decodescript", script).get("address")
        found = []
        if address:
            rows = self.wallet.call("listreceivedbyaddress", 0, True, True, address)
            txids = sorted({t for r in rows for t in r.get("txids", [])})
            for txid in txids:
                tx = self._raw(txid)
                if tx is None or not self._live(txid):
                    continue
                for out in tx["vout"]:
                    if out["scriptPubKey"]["hex"] == script:
                        found.append({"outpoint": (txid, out["n"]), "value": sats(out["value"]),
                                      "conf": self.conf(txid)})
        self._outputs[script] = found
        return found

    def _wallet_spends(self):
        """outpoint -> spending txid, for every live wallet transaction. Any
        spend of a wallet output is itself a wallet transaction."""
        if self._spends is None:
            self._spends = {}
            txids = {t["txid"] for t in self.wallet.call("listtransactions", "*", 100000, 0, True)}
            for txid in sorted(txids):
                tx = self._raw(txid)
                if tx is None:
                    continue
                for vin in tx["vin"]:
                    if "txid" in vin:
                        self._spends.setdefault((vin["txid"], vin["vout"]), []).append(txid)
        return self._spends

    def spender(self, outpoint):
        for txid in self._wallet_spends().get(tuple(outpoint), []):
            if self.conf(txid) > 0:
                return txid
        return None

    def _ancestors(self, tx):
        seen = {tx["txid"]: [tuple(i) for i in tx["inputs"]]}
        stack = list(seen[tx["txid"]])
        while stack:
            parent = stack.pop()[0]
            if parent in seen:
                continue
            raw = self._raw(parent)
            if raw is None:
                continue
            ins = [(v["txid"], v["vout"]) for v in raw["vin"] if "txid" in v]
            seen[parent] = ins
            stack.extend(ins)
        return seen

    def exclusive(self, a, b):
        """Some transaction `a` depends on and a different one `b` depends on
        spend the same outpoint, so they can never both be mined."""
        for xa, ins_a in self._ancestors(a).items():
            for xb, ins_b in self._ancestors(b).items():
                if xa != xb and set(ins_a) & set(ins_b):
                    return True
        return False

    def send(self, tx):
        if not tx.get("raw"):
            raise SendFailed("no signed transaction stored")
        try:
            self.node.call("sendrawtransaction", tx["raw"])
        except RpcUnreachable as e:
            raise SendUncertain(str(e))
        except RpcError as e:
            msg = str(e.error)
            if "already" in msg and ("known" in msg or "block chain" in msg):
                return
            raise SendFailed(msg)

    def new_destination(self, label):
        address = self.wallet.call("getnewaddress", label, "bech32m")
        return address, self.wallet.call("getaddressinfo", address)["scriptPubKey"]

    def refund_script(self, address):
        """The script for a buyer's refund address, on the node's network."""
        try:
            info = self.node.call("validateaddress", address)
        except RpcError:
            info = {}
        if not info.get("isvalid"):
            raise Refused("invalid refund address for this network")
        return info["scriptPubKey"]


class RefundBuilder:
    """Builds and signs one refund transaction for an order: it spends the
    order's own settled, unspent payment outputs, pays `to_buyer` to the
    buyer's refund script, and returns any change to the store's wallet."""

    def __init__(self, view, hot_wallet_cap_sats):
        self.view = view
        self.cap = hot_wallet_cap_sats

    def build(self, ledger, oid, to_buyer, fee):
        o = ledger.operator_view(oid)
        if not o["refund_spk"]:
            raise Refused("the buyer hasn't given a refund address through the order link")
        if to_buyer < DUST:
            raise Refused("refund below dust")
        if to_buyer > self.cap:
            raise Refused(f"refund above the hot wallet cap of {self.cap} sats")
        node = self.view.node
        inputs, total = [], 0
        for x in sorted(ledger.outputs(oid), key=lambda x: x["outpoint"]):
            txid, vout = x["outpoint"]
            if x["conf"] < SETTLED or node.call("gettxout", txid, vout, True) is None:
                continue
            inputs.append({"txid": txid, "vout": vout})
            total += x["value"]
            if total >= to_buyer + fee:
                break
        if total < to_buyer + fee:
            raise Refused("the order's settled, unspent payment outputs don't cover the refund")
        outputs = [{o["refund_address"]: btc(to_buyer)}]
        change = total - to_buyer - fee
        if change >= DUST:
            change_address = self.view.wallet.call("getrawchangeaddress", "bech32m")
            outputs.append({change_address: btc(change)})
        # A change below dust goes to the fee. That part is a store cost,
        # never charged to the order.
        raw = node.call("createrawtransaction", inputs, outputs, 0, True)
        signed = self.view.wallet.call("signrawtransactionwithwallet", raw)
        if not signed.get("complete"):
            raise Refused("the wallet could not sign the refund")
        decoded = node.call("decoderawtransaction", signed["hex"])
        actual_fee = total - sum(sats(v["value"]) for v in decoded["vout"])
        return {"txid": decoded["txid"],
                "inputs": [(i["txid"], i["vout"]) for i in inputs],
                "outputs": [(v["scriptPubKey"]["hex"], sats(v["value"])) for v in decoded["vout"]],
                "raw": signed["hex"]}, actual_fee
