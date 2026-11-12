import assert from "node:assert/strict";
import { Effect } from "effect";
import type { SalesStore } from "../src/application/store.ts";
import type { BitcoinRpc } from "../src/bitcoin/rpc.ts";
import { hex, integer, object } from "../src/bitcoin/validation.ts";

const binding = { entry: "e".repeat(32), root: "f".repeat(64), oids: ["o1", "o5"], delegate: "d".repeat(64) + ":0" };
/** A real newly mined Core transaction supplies depth and reorg evidence.
 * The Spaces root, root height and anchors are explicit controller mocks. */
export function commitmentLifecycle(store: SalesStore, node: BitcoinRpc, minerAddress: string) {
  return Effect.gen(function* () {
    const mined = yield* node.call("generatetoaddress", 1, minerAddress); assert(Array.isArray(mined));
    const block = object(yield* node.call("getblock", mined[0], 1)); assert(Array.isArray(block.tx));
    const txid = hex(block.tx[0]), height = integer(block.height);
    const blocks = yield* node.call("generatetoaddress", 150, minerAddress); assert(Array.isArray(blocks));
    const facts = (anchorHeight: number) => Effect.gen(function* () {
      const tip = object(yield* node.call("getblockchaininfo"));
      return { txid, tipHeight: integer(tip.blocks), tipHash: hex(tip.bestblockhash), minedHeight: height, rootHeight: height, anchorHeight };
    });
    const first = { ...binding, expectedRevision: 0, observation: yield* facts(height + 143) };
    const saved = yield* store.registry.commitments.observe(first);
    assert.equal(saved.observation!.phase, "final"); assert.equal(saved.observation!.depth, 150);
    assert.equal(saved.observation!.covered, false);
    assert.deepEqual(yield* store.registry.commitments.observe(first), saved);
    const covered = { ...binding, expectedRevision: 1, observation: yield* facts(height + 144) };
    assert.equal((yield* store.registry.commitments.observe(covered)).observation!.covered, true);
    yield* node.call("invalidateblock", blocks.at(-1));
    assert.equal((yield* Effect.result(store.registry.commitments.observe(covered)))._tag, "Failure");
    const lost = yield* store.registry.commitments.observe({ ...binding, expectedRevision: 2, observation: yield* facts(height + 144) });
    assert.equal(lost.observation!.phase, "mined"); assert.equal(lost.observation!.depth, 149); assert.equal(lost.observation!.covered, false);
    yield* node.call("reconsiderblock", blocks.at(-1));
    // Same old final tip is active again, but its report revision is stale.
    assert.equal((yield* Effect.result(store.registry.commitments.observe(first)))._tag, "Failure");
    const restored = yield* store.registry.commitments.observe({ ...binding, expectedRevision: 3, observation: yield* facts(height + 144) });
    assert.equal(restored.observation!.phase, "final"); assert.equal(restored.observation!.covered, true);
    for (const id of binding.oids) assert.equal((yield* store.inspectionOrder(id)).status, "issuing");
  });
}
export function commitmentRestart(store: SalesStore) {
  return Effect.gen(function* () {
    const saved = yield* store.registry.commitments.current(binding);
    assert.equal(saved.revision, 4); assert.equal(saved.acknowledged, true);
    assert.equal(saved.observation!.phase, "final"); assert.equal(saved.observation!.covered, true);
  });
}
