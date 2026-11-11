import { Effect } from "effect";
import { ApplicationError, verified } from "../application/records.ts";
import { prepared } from "../refunds/records.ts";
import type { PreparedRefund, RefundFacts, RefundSnapshot, Replacement } from "../refunds/types.ts";
import { CoreAdapter, type CoreConfig } from "./core.ts";
import { BitcoinRpc } from "./rpc.ts";
import { amount, hex, integer, invalid, object } from "./validation.ts";
import { verifyReplacement } from "./exclusivity.ts";

interface Position { confirmations: number; mempool: boolean; blockHash: string | null; inputs: string[]; decoded: unknown }
function decodedMatches(tx: PreparedRefund, raw: unknown): void {
  const d = object(raw);
  if (d.txid !== tx.txid || d.vsize !== tx.vbytes || d.locktime !== 0 || !Array.isArray(d.vin) || !Array.isArray(d.vout) ||
      d.vin.length !== tx.inputs.length || d.vout.length !== tx.outputs.length) invalid("refund signed bytes differ from journaled transaction");
  for (const [i, row] of d.vin.entries()) {
    const v = object(row);
    if (`${hex(v.txid)}:${integer(v.vout)}` !== tx.inputs[i]!.outpoint || v.sequence !== 0xffff_fffd) invalid("refund signed inputs differ");
  }
  for (const [i, row] of d.vout.entries()) {
    const v = object(row);
    if (v.n !== i || object(v.scriptPubKey).hex !== tx.outputs[i]!.script || amount(v.value) !== tx.outputs[i]!.sats) invalid("refund signed outputs differ");
  }
}
/** Observe every saved member and verify exclusivity before replacement sends. */
export class CoreRefundSender {
  private readonly node: BitcoinRpc;
  private readonly wallet: BitcoinRpc;
  private readonly core: CoreAdapter;
  private constructor(config: CoreConfig, core: CoreAdapter) {
    const { wallet, ...node } = config;
    this.node = new BitcoinRpc(node); this.wallet = new BitcoinRpc({ ...node, wallet }); this.core = core;
  }
  static make(config: CoreConfig) {
    return CoreAdapter.make(config).pipe(Effect.flatMap(core => verified(() => new CoreRefundSender(config, core))));
  }
  private rpc(client: BitcoinRpc, method: string, ...params: readonly unknown[]) {
    return client.call(method, ...params).pipe(Effect.mapError(e => new ApplicationError({ code: "unavailable", message: e.message })));
  }
  private history() {
    const self = this;
    return Effect.gen(function* () {
      const reply = yield* self.rpc(self.wallet, "listsinceblock", null, 1, true, true, true);
      return yield* verified(() => {
        const h = object(reply); hex(h.lastblock);
        if (!Array.isArray(h.transactions)) invalid("invalid refund wallet history");
        return { hash: h.lastblock, ids: [...new Set(h.transactions.map(row => hex(object(row).txid)))].sort() };
      });
    });
  }
  private position(id: string, height: number, allowMissing: boolean) {
    const self = this;
    return Effect.gen(function* () {
      const reply = yield* self.wallet.call("gettransaction", id, true, true).pipe(Effect.match({
        onSuccess: value => ({ ok: true as const, value }), onFailure: error => ({ ok: false as const, error }),
      }));
      if (!reply.ok) {
        if (allowMissing && reply.error.kind === "rejected" && reply.error.rpcCode === -5) return null;
        return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: reply.error.message }));
      }
      const value = yield* verified(() => {
        const v = object(reply.value), d = object(v.decoded);
        if (v.txid !== id || d.txid !== id || !Array.isArray(d.vin)) invalid("invalid refund wallet transaction");
        const inputs = d.vin.flatMap(row => {
          const input = object(row);
          if (typeof input.coinbase === "string") return [];
          const vout = integer(input.vout); if (vout > 0xffff_ffff) invalid("invalid refund spend index");
          return [`${hex(input.txid)}:${vout}`];
        });
        if (new Set(inputs).size !== inputs.length) invalid("duplicate wallet transaction input");
        return { confirmations: integer(v.confirmations, -Number.MAX_SAFE_INTEGER), blockHash: v.blockhash, inputs, decoded: d };
      });
      if (value.confirmations > 0) {
        const block = yield* verified(() => hex(value.blockHash));
        const reply = yield* self.rpc(self.node, "getblockheader", block);
        return yield* verified((): Position => {
          const h = object(reply);
          if (h.hash !== block || integer(h.confirmations, -1) !== value.confirmations || integer(h.height) + value.confirmations - 1 !== height)
            invalid("refund block position changed");
          return { ...value, confirmations: value.confirmations, mempool: false, blockHash: block };
        });
      }
      const pool = yield* self.node.call("getmempoolentry", id).pipe(Effect.match({
        onSuccess: value => ({ ok: true as const, value }), onFailure: error => ({ ok: false as const, error }),
      }));
      if (!pool.ok && !(pool.error.kind === "rejected" && pool.error.rpcCode === -5))
        return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: pool.error.message }));
      if (pool.ok) yield* verified(() => { const e = object(pool.value); integer(e.time); integer(e.height); });
      return { ...value, confirmations: 0, mempool: pool.ok, blockHash: null } satisfies Position;
    });
  }
  private inputs(tx: PreparedRefund, tip: string, includeMempool = true) {
    const self = this;
    return Effect.gen(function* () {
      let available = true;
      for (const input of tx.inputs) {
        const [id, index] = input.outpoint.split(":");
        const raw = yield* self.rpc(self.node, "gettxout", id, Number(index), includeMempool);
        if (raw === null) { available = false; continue; }
        yield* verified(() => {
          const v = object(raw);
          if (hex(v.bestblock) !== tip || amount(v.value) !== input.sats || object(v.scriptPubKey).hex !== input.script)
            invalid("refund input contents or tip differ");
          if (integer(v.confirmations) < 6) available = false;
        });
      }
      return available;
    });
  }
  private read(transactions: readonly PreparedRefund[]) {
    const self = this;
    return Effect.gen(function* () {
      const start = yield* self.core.checkReady(), history = yield* self.history();
      if (history.hash !== start.hash) return null;
      const ids = [...new Set([...history.ids, ...transactions.map(tx => tx.txid)])].sort();
      const positions = new Map<string, Position | null>();
      for (const id of ids) positions.set(id, yield* self.position(id, start.height, !history.ids.includes(id)));
      const facts: RefundFacts[] = [];
      for (const tx of transactions) {
        const p = positions.get(tx.txid)!;
        if (p) yield* verified(() => decodedMatches(tx, p.decoded));
        const inputsAvailable = yield* self.inputs(tx, start.hash), chainInputsAvailable = yield* self.inputs(tx, start.hash, false);
        const inputs = new Set(tx.inputs.map(i => i.outpoint));
        const conflicts = [...positions].filter(([id, p]) => id !== tx.txid && p && (p.confirmations > 0 || p.mempool) && p.inputs.some(i => inputs.has(i)))
          .map(([txid, p]) => ({ txid, confirmations: p!.confirmations, mempool: p!.mempool }));
        if (p && (p.confirmations > 0 || p.mempool) && conflicts.length) return null;
        facts.push({ txid: tx.txid, seen: p?.confirmations ? "mined" : p?.mempool ? "mempool" : "absent",
          confirmations: p?.confirmations ?? 0, blockHash: p?.blockHash ?? null, inputsAvailable, chainInputsAvailable, conflicts });
      }
      const again = yield* self.history();
      if (history.hash !== again.hash || JSON.stringify(history.ids) !== JSON.stringify(again.ids)) return null;
      for (const [id, previous] of positions) {
        const current = yield* self.position(id, start.height, !history.ids.includes(id));
        if (JSON.stringify(previous) !== JSON.stringify(current)) return null;
      }
      for (const [i, tx] of transactions.entries()) if ((yield* self.inputs(tx, start.hash)) !== facts[i]!.inputsAvailable) return null;
      for (const [i, tx] of transactions.entries()) if ((yield* self.inputs(tx, start.hash, false)) !== facts[i]!.chainInputsAvailable) return null;
      const end = yield* self.core.checkReady();
      return end.hash === start.hash && end.height === start.height ? { tip: start.height, tipHash: start.hash, transactions: facts } satisfies RefundSnapshot : null;
    });
  }
  observe(input: readonly PreparedRefund[]) {
    const self = this;
    return Effect.gen(function* () {
      const transactions = yield* verified(() => {
        const copy = structuredClone(input); copy.forEach(prepared);
        if (new Set(copy.map(t => t.txid)).size !== copy.length) invalid("duplicate refund transaction"); return copy;
      });
      for (let attempt = 0; attempt < 3; attempt++) { const result = yield* self.read(transactions); if (result) return result; }
      return yield* verified(() => invalid("Core changed during refund observation"));
    });
  }
  broadcast(input: PreparedRefund, permission: Effect.Effect<boolean, ApplicationError>, expectedTip: Pick<RefundSnapshot, "tip" | "tipHash">, replacement?: Replacement) {
    const self = this;
    return Effect.gen(function* () {
      const tx = yield* verified(() => { prepared(input); return structuredClone(input); });
      const expected = yield* verified(() => ({ hash: hex(expectedTip.tipHash), height: integer(expectedTip.tip) }));
      const start = yield* self.core.checkReady();
      if (start.hash !== expected.hash || start.height !== expected.height) return yield* verified(() => invalid("Core tip changed before refund send"));
      if (replacement) yield* verifyReplacement(self.node, replacement);
      const decoded = yield* self.rpc(self.node, "decoderawtransaction", tx.raw);
      yield* verified(() => decodedMatches(tx, decoded));
      const end = yield* self.core.checkReady();
      if (end.hash !== expected.hash || end.height !== expected.height) return yield* verified(() => invalid("Core tip changed during refund preflight"));
      // No intervening RPC between the application's live journal gate and send.
      if (!(yield* permission)) return yield* verified(() => invalid("refund journal is not currently acknowledged"));
      const result = yield* self.rpc(self.node, "sendrawtransaction", tx.raw);
      yield* verified(() => { if (result !== tx.txid) invalid("refund broadcast returned another transaction id"); });
    });
  }
}
