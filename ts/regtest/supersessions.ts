import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, Scope } from "effect";
import { SalesStore } from "../src/application/store.ts";
import { CoreAdapter, type CoreConfig } from "../src/bitcoin/core.ts";
import { BitcoinRpc } from "../src/bitcoin/rpc.ts";
import { conflictVerifier } from "../src/bitcoin/supersession.ts";
import { hex, integer, object } from "../src/bitcoin/validation.ts";
import { refundPolicy } from "../test/production/application-fixture.ts";

/** Actual signed delegate conflict and Core reorg. Spaces root exclusion is
 * an explicit fixture attestation; this does not exercise a Spaces rollback. */
export function supersessionQualification(root: string, config: CoreConfig, buyer: BitcoinRpc, node: BitcoinRpc, miner: string) {
  return Effect.scoped(Effect.gen(function* () {
    yield* node.call("createwallet", "supersession-merchant");
    const settings = { ...config, wallet: "supersession-merchant" }, wallet = new BitcoinRpc(settings);
    const core = yield* CoreAdapter.make(settings), chain = yield* conflictVerifier(settings);
    const directory = join(root, "supersession"), journalDirectory = join(directory, "journal"); mkdirSync(journalDirectory, { recursive: true });
    const open = () => SalesStore.open({ database: join(directory, "store.db"), journalDirectory, riskBudgetSats: 100_000, refundPolicy },
      { clock: () => 0, snapshot: destinations => core.snapshot(destinations), newDestination: core.newDestination(), supersessionChain: chain });
    const parent = yield* Effect.scope;
    let lifetime = yield* Scope.fork(parent), store = yield* Scope.provide(lifetime)(open());
    yield* store.pause(false);
    const tokens: string[] = [];
    for (const label of ["proof-one", "proof-two"]) {
      yield* store.listName(`${label}@space`, 1000);
      const order = yield* store.request({ handle: `${label}@space`, script_pubkey: "5120" + String(tokens.length + 1).padStart(64, "0") });
      const invoice = yield* store.quote(order.token); assert(invoice.address); tokens.push(order.token);
      yield* buyer.call("sendtoaddress", invoice.address, "0.00001000");
    }
    const destination = yield* wallet.call("getnewaddress", "", "bech32m");
    const funding = yield* buyer.call("sendtoaddress", destination, "0.00100000");
    yield* node.call("generatetoaddress", 6, miner);
    const funded = object(yield* wallet.call("gettransaction", funding, true, true)), decoded = object(funded.decoded);
    assert(Array.isArray(decoded.vout));
    const coin = decoded.vout.map(object).find(o => object(o.scriptPubKey).address === destination)!;
    const input = { txid: funding, vout: integer(coin.n), sequence: 0xfffffffd };
    const binding = { entry: "1".repeat(32), root: "2".repeat(64), oids: ["o1", "o2"], delegate: `${funding}:${input.vout}` };
    const sign = (outputs: unknown) => Effect.gen(function* () {
      const raw = yield* node.call("createrawtransaction", [input], outputs);
      const signed = object(yield* wallet.call("signrawtransactionwithwallet", raw)); assert.equal(signed.complete, true);
      assert.equal(typeof signed.hex, "string"); assert.match(String(signed.hex), /^(?:[0-9a-f]{2})+$/);
      return String(signed.hex);
    });
    const originalRaw = yield* sign([{ data: binding.root }, { [String(destination)]: "0.00099000" }]);
    const txid = hex(object(yield* node.call("decoderawtransaction", originalRaw)).txid);
    yield* store.registry.entries.enter({ entry: binding.entry, root: binding.root, oids: binding.oids });
    assert.equal((yield* store.registry.entries.arm(binding)).granted, true);
    assert.equal(yield* node.call("sendrawtransaction", originalRaw), txid);
    const conflictRaw = yield* sign([{ [String(destination)]: "0.00095000" }]);
    const conflictTxid = hex(yield* node.call("sendrawtransaction", conflictRaw));
    const blocks = yield* node.call("generatetoaddress", 6, miner); assert(Array.isArray(blocks));
    const tip = object(yield* node.call("getblockchaininfo")), header = object(yield* node.call("getblockheader", blocks[0]));
    const report = yield* store.registry.commitments.observe({ ...binding, expectedRevision: 0, observation: {
      txid, tipHeight: integer(tip.blocks), tipHash: hex(tip.bestblockhash), minedHeight: null, rootHeight: null, anchorHeight: null } });
    const packet = { ...binding, revision: report.revision, txid, originalRaw, conflictTxid, blockHash: hex(blocks[0]), height: integer(header.height),
      tipHeight: integer(tip.blocks), tipHash: hex(tip.bestblockhash), rootAbsent: true, confirm: binding.entry };
    const receipt = yield* store.registry.supersessions.accept(packet);
    assert.equal(receipt.acknowledged, true); assert.equal(receipt.proof!.active, true); assert.equal("originalRaw" in receipt.proof!, false);
    for (const token of tokens) assert.equal((yield* store.order(token)).status, "converted");
    assert.equal((yield* store.inspectionOrder("o1")).price_reserve, 1000);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parent); store = yield* Scope.provide(lifetime)(open());
    assert.equal((yield* store.registry.supersessions.current(binding)).proof!.active, true);
    yield* store.cancel(tokens[1]!);
    // Losing even the verification checkpoint revokes permission. The conflict
    // is now only five deep; cancellation remains irreversible.
    yield* node.call("invalidateblock", packet.tipHash);
    assert.equal((yield* store.order(tokens[0]!)).status, "issuing");
    assert.equal((yield* store.order(tokens[1]!)).status, "cancelled");
    assert.equal((yield* store.order(tokens[1]!)).recovery_incident!.open, true);
    yield* node.call("reconsiderblock", packet.tipHash);
    const retry = yield* store.registry.supersessions.accept(packet);
    assert.equal(retry.proof!.active, false); assert.equal(retry.conflicted, true);
    yield* Scope.close(lifetime, Exit.void); lifetime = yield* Scope.fork(parent); store = yield* Scope.provide(lifetime)(open());
    assert.equal((yield* store.registry.supersessions.current(binding)).proof!.active, false);
    assert.equal((yield* store.inspectionOrder("o1")).price_reserve, 1000);
    assert.equal((yield* store.registry.entries.arm(binding)).granted, false);
  }));
}
