import assert from "node:assert/strict";
import { Effect } from "effect";
import type { SalesStore } from "../src/application/store.ts";
import type { BitcoinRpc } from "../src/bitcoin/rpc.ts";
import { integer, hex, object } from "../src/bitcoin/validation.ts";

const binding = { entry: "e".repeat(32), root: "f".repeat(64), oids: ["o1", "o5"], delegate: "d".repeat(64) + ":0" };
const message = Buffer.from("mock verified certificate; real Core ancestry, no Spaces proof");
export function certificateLifecycle(store: SalesStore, node: BitcoinRpc, miner: string, token: string) {
  return Effect.gen(function* () {
    const current = yield* store.registry.commitments.current(binding), facts = current.observation!;
    const packet = { ...binding, oid: "o1", revision: current.revision, certificateRoot: binding.root,
      certificateHeight: facts.minedHeight, message_b64: message.toString("base64") };
    assert.equal((yield* store.registry.certificates.accept(packet)).acknowledged, true);
    assert.deepEqual(yield* store.certificate(token), message);
    yield* node.call("generatetoaddress", 1, miner);
    assert.deepEqual(yield* store.certificate(token), message, "descendant tip preserves readiness");
    yield* node.call("invalidateblock", facts.tipHash);
    assert.equal((yield* Effect.result(store.certificate(token)))._tag, "Failure");
    assert.equal((yield* store.order(token)).status, "issuing");
    yield* node.call("reconsiderblock", facts.tipHash);
    assert.equal((yield* Effect.result(store.registry.certificates.accept(packet)))._tag, "Failure");
    const tip = object(yield* node.call("getblockchaininfo"));
    const observed = { txid: facts.txid, tipHash: hex(tip.bestblockhash), tipHeight: integer(tip.blocks),
      minedHeight: facts.minedHeight, rootHeight: facts.rootHeight, anchorHeight: facts.anchorHeight };
    const fresh = yield* store.registry.commitments.observe({ ...binding, expectedRevision: current.revision, observation: observed });
    assert.equal((yield* store.order(token)).certificate_available, false);
    yield* store.registry.certificates.accept({ ...packet, revision: fresh.revision });
    assert.deepEqual(yield* store.certificate(token), message);
    assert.equal((yield* store.inspectionOrder("o1")).price_reserve, 1000);
  });
}
export function certificateRestart(store: SalesStore, token: string) {
  return Effect.gen(function* () {
    assert.equal((yield* store.order(token)).status, "ready");
    assert.deepEqual(yield* store.certificate(token), message);
  });
}
