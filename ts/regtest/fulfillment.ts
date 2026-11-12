import assert from "node:assert/strict";
import { Effect } from "effect";
import type { SalesStore } from "../src/application/store.ts";
import type { BitcoinRpc } from "../src/bitcoin/rpc.ts";

const binding = { entry: "e".repeat(32), root: "f".repeat(64), oids: ["o1", "o5"], delegate: "d".repeat(64) + ":0" };
export function fulfillmentLifecycle(store: SalesStore, node: BitcoinRpc, token: string) {
  return Effect.gen(function* () {
    const current = yield* store.registry.commitments.current(binding), facts = current.observation!;
    const status = yield* store.registry.deliveries.status({ ...binding, oid: "o1" }), bytes = yield* store.certificate(token);
    const delivery = { ...binding, oid: "o1", revision: current.revision, certificateHash: status.certificateHash!,
      relayRoot: binding.root, relayHeight: facts.minedHeight, proofHash: "e".repeat(64) };
    assert.equal((yield* store.registry.deliveries.fulfill(delivery)).acknowledged, true);
    const before = yield* store.inspectionOrder("o1");
    yield* node.call("invalidateblock", facts.tipHash);
    assert.equal((yield* store.order(token)).status, "fulfilled");
    assert.equal((yield* Effect.result(store.certificate(token)))._tag, "Failure");
    assert.equal((yield* store.order(token)).recovery_incident!.open, true);
    assert.equal((yield* store.inspectionOrder("o1")).price_reserve, 1000);
    yield* node.call("reconsiderblock", facts.tipHash);
    const observation = { txid: facts.txid, tipHeight: facts.tipHeight, tipHash: facts.tipHash,
      minedHeight: facts.minedHeight, rootHeight: facts.rootHeight, anchorHeight: facts.anchorHeight };
    const fresh = yield* store.registry.commitments.observe({ ...binding, expectedRevision: current.revision, observation });
    yield* store.registry.certificates.accept({ ...binding, oid: "o1", revision: fresh.revision,
      certificateRoot: binding.root, certificateHeight: facts.minedHeight, message_b64: bytes.toString("base64") });
    assert.equal((yield* store.order(token)).status, "fulfilled");
    assert.equal((yield* store.order(token)).recovery_incident!.open, true);
    yield* store.registry.deliveries.resolve({ incident: 1, resolution: "operator reviewed restored chain" });
    const after = yield* store.inspectionOrder("o1");
    assert.equal((yield* store.order(token)).recovery_incident!.open, false);
    assert.equal(after.refunded_total, before.refunded_total); assert.equal(after.reserved, before.reserved);
    assert.equal(after.fulfillment!.proofHash, "e".repeat(64)); assert.equal(after.price_reserve, 1000);
  });
}
export function fulfillmentRestart(store: SalesStore, token: string) {
  return Effect.gen(function* () {
    assert.equal((yield* store.order(token)).status, "fulfilled");
    assert.equal((yield* store.order(token)).recovery_incident!.open, false);
    assert.equal((yield* store.inspectionOrder("o1")).fulfillment!.proofHash, "e".repeat(64));
  });
}
