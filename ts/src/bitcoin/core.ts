import { Effect } from "effect";
import { ApplicationError, destination, verified, type Destination, type Output, type Snapshot } from "../application/records.ts";
import { validP2tr } from "../recipient.ts";
import { BitcoinRpc, type RpcConfig } from "./rpc.ts";
import { amount, hex, integer, invalid, object } from "./validation.ts";
import type { ChainCheckpoint } from "../application/certificate-records.ts";

export interface CoreConfig extends Omit<RpcConfig, "wallet"> {
  readonly wallet: string;
  readonly network: "main" | "test" | "testnet4" | "signet" | "regtest";
}
interface Tip { hash: string; height: number }
interface Transaction { decoded: unknown; confirmations: number; marker: string; live: boolean }
const unavailable = (message: string) => new ApplicationError({ code: "unavailable", message });

/** Payment observation and bech32m allocation only. No signing, sending,
 * wallet creation, descriptor import or automatic recovery policy. */
export class CoreAdapter {
  private readonly node: BitcoinRpc;
  private readonly wallet: BitcoinRpc;
  private readonly config: CoreConfig;
  private constructor(config: CoreConfig) {
    this.config = { ...config };
    const { wallet, ...node } = config;
    this.node = new BitcoinRpc(node);
    this.wallet = new BitcoinRpc({ ...node, wallet });
  }
  static make(config: CoreConfig) {
    return verified(() => new CoreAdapter(config));
  }
  private rpc(client: BitcoinRpc, method: string, ...params: readonly unknown[]) {
    return client.call(method, ...params).pipe(Effect.mapError(e => unavailable(e.message)));
  }
  private tip() {
    const self = this;
    return Effect.gen(function* () {
      const info = yield* self.rpc(self.node, "getblockchaininfo");
      return yield* verified(() => {
        const value = object(info);
        if (value.chain !== self.config.network || value.initialblockdownload !== false || value.headers !== value.blocks)
          invalid("Core network mismatch or synchronization incomplete");
        return { hash: hex(value.bestblockhash), height: integer(value.blocks) };
      });
    });
  }
  private walletReady(tip: Tip) {
    const self = this;
    return Effect.gen(function* () {
      const mempool = yield* self.rpc(self.node, "getmempoolinfo");
      yield* verified(() => { if (object(mempool).loaded !== true) invalid("Core mempool is not loaded"); });
      const info = yield* self.rpc(self.wallet, "getwalletinfo");
      yield* verified(() => {
        const value = object(info), block = object(value.lastprocessedblock);
        if (value.walletname !== self.config.wallet || value.descriptors !== true || value.scanning !== false ||
            block.hash !== tip.hash || block.height !== tip.height) invalid("payment wallet is not ready at the Core tip");
      });
    });
  }
  private ready() {
    const self = this;
    return Effect.gen(function* () {
      const info = yield* self.rpc(self.node, "getnetworkinfo");
      yield* verified(() => { if (object(info).version !== 310200) invalid("Core 31.2 is required"); });
      const tip = yield* self.tip(); yield* self.walletReady(tip); return tip;
    });
  }
  /** Readiness guard shared with the explicit refund builder. */
  checkReady() { return this.ready(); }
  /** Check ancestry against the same coherent tip used by the application.
   * No signing, wallet mutation or inferred timestamp is involved. */
  containsBlock(checkpoint: ChainCheckpoint) {
    const self = this;
    return Effect.gen(function* () {
      yield* verified(() => { hex(checkpoint.tipHash); hex(checkpoint.hash); integer(checkpoint.height); });
      const start = yield* self.tip();
      if (start.hash !== checkpoint.tipHash) return yield* Effect.fail(unavailable("Core changed before certificate check"));
      const block = checkpoint.height <= start.height ? yield* self.rpc(self.node, "getblockhash", checkpoint.height) : null;
      const end = yield* self.tip();
      if (end.hash !== start.hash || end.height !== start.height) return yield* Effect.fail(unavailable("Core changed during certificate check"));
      if (block !== null) yield* verified(() => hex(block));
      return block === checkpoint.hash;
    });
  }
  private owned(address: string, script?: string) {
    const self = this;
    return Effect.gen(function* () {
      const info = yield* self.rpc(self.wallet, "getaddressinfo", address);
      return yield* verified(() => {
        const value = object(info);
        const result = { address, script: value.scriptPubKey };
        destination(result);
        if (value.address !== address || value.ismine !== true || (script !== undefined && result.script !== script))
          invalid("payment wallet does not own a recorded destination");
        return result;
      });
    });
  }
  private discovery(destinations: readonly Destination[]) {
    const self = this;
    return Effect.gen(function* () {
      // Full wallet history, including change and receipts absent from the
      // address book after descriptor recovery. No pagination/UTXO filter.
      const reply = yield* self.rpc(self.wallet, "listsinceblock", null, 1, true, true, true);
      return yield* verified(() => {
        const history = object(reply), hash = hex(history.lastblock);
        if (!Array.isArray(history.transactions)) invalid("invalid wallet receipt history");
        const addresses = new Set(destinations.map(d => d.address)), ids = new Set<string>();
        for (const row of history.transactions) {
          const value = object(row);
          if (!addresses.has(value.address as string)) continue;
          ids.add(hex(value.txid));
        }
        return { hash, ids: [...ids].sort() };
      });
    });
  }
  private transaction(txid: string, tip: Tip, verbose: boolean) {
    const self = this;
    return Effect.gen(function* () {
      const reply = yield* self.rpc(self.wallet, "gettransaction", txid, true, verbose);
      const value = yield* verified(() => {
        const value = object(reply); if (value.txid !== txid) invalid("wallet transaction identity differs");
        integer(value.confirmations, -Number.MAX_SAFE_INTEGER); return value;
      });
      if ((value.confirmations as number) > 0) {
        const block = yield* verified(() => hex(value.blockhash));
        const header = yield* self.rpc(self.node, "getblockheader", block);
        return yield* verified((): Transaction | null => {
          const h = object(header), depth = integer(h.confirmations, -1), height = integer(h.height);
          if (h.hash !== block || depth < 1 || height + depth - 1 !== tip.height || depth !== value.confirmations) return null;
          return { decoded: value.decoded, confirmations: depth, marker: `${block}:${depth}`, live: true };
        });
      }
      const mempool = yield* self.node.call("getmempoolentry", txid).pipe(Effect.match({
        onSuccess: result => ({ ok: true as const, result }), onFailure: error => ({ ok: false as const, error }),
      }));
      if (!mempool.ok && !(mempool.error.kind === "rejected" && mempool.error.rpcCode === -5))
        return yield* Effect.fail(unavailable(mempool.error.message));
      if (mempool.ok) yield* verified(() => {
        const entry = object(mempool.result); integer(entry.time); integer(entry.height);
      });
      // Entry metadata is not used to invent an on-time store observation.
      return { decoded: value.decoded, confirmations: 0, marker: mempool.ok ? "mempool" : "absent", live: mempool.ok };
    });
  }
  private read(destinations: readonly Destination[]) {
    const self = this;
    return Effect.gen(function* () {
      const tip = yield* self.ready();
      for (const d of destinations) yield* self.owned(d.address, d.script);
      const history = yield* self.discovery(destinations), transactions = new Map<string, Transaction>();
      if (history.hash !== tip.hash) return null;
      const ids = history.ids;
      const outputs: Output[] = [], scripts = new Set(destinations.map(d => d.script));
      for (const txid of ids) {
        const tx = yield* self.transaction(txid, tip, true);
        if (!tx) return null;
        transactions.set(txid, tx);
        if (!tx.live) continue;
        yield* verified(() => {
          const decoded = object(tx.decoded);
          if (decoded.txid !== txid || !Array.isArray(decoded.vout)) invalid("invalid decoded wallet transaction");
          for (const [index, raw] of decoded.vout.entries()) {
            const out = object(raw), script = object(out.scriptPubKey).hex;
            if (integer(out.n) !== index || typeof script !== "string" || !/^(?:[0-9a-f]{2})*$/.test(script))
              invalid("invalid decoded transaction output");
            const sats = amount(out.value);
            if (scripts.has(script) && sats > 0) outputs.push({ outpoint: `${txid}:${index}`, script, sats, confirmations: tx.confirmations });
          }
        });
      }
      const again = yield* self.discovery(destinations);
      if (again.hash !== tip.hash || JSON.stringify(ids) !== JSON.stringify(again.ids)) return null;
      for (const [id, original] of transactions) {
        const current = yield* self.transaction(id, tip, false);
        if (!current || current.marker !== original.marker) return null;
      }
      const end = yield* self.tip(); yield* self.walletReady(end);
      return end.hash === tip.hash && end.height === tip.height ? { tip: tip.height, tipHash: tip.hash, outputs } satisfies Snapshot : null;
    });
  }
  snapshot(destinations: readonly Destination[]): Effect.Effect<Snapshot, ApplicationError> {
    const self = this;
    return Effect.gen(function* () {
      const copy = yield* verified(() => {
        const seen = new Set<string>();
        return destinations.map(value => {
          destination(value);
          if (seen.has(value.script)) invalid("duplicate recorded payment destination");
          seen.add(value.script); return { ...value };
        });
      });
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = yield* self.read(copy);
        if (result) return result;
      }
      return yield* Effect.fail(unavailable("Core changed during payment observation; retry required"));
    });
  }
  newDestination() {
    const self = this;
    return Effect.gen(function* () {
      yield* self.ready();
      const raw = yield* self.rpc(self.wallet, "getnewaddress", "subspace-store", "bech32m");
      const address = yield* verified(() => {
        if (typeof raw !== "string" || raw.length > 256 || !raw) invalid("invalid Core address"); return raw;
      });
      const result = yield* self.owned(address);
      yield* verified(() => { if (!validP2tr(result.script)) invalid("Core did not return a valid bech32m destination"); });
      yield* self.ready();
      return result;
    });
  }
}
