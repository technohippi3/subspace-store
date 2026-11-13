import type { TestContext } from "node:test";
import { Effect } from "effect";
import { ApplicationError } from "../../src/application/records.ts";
import type { SalesStore } from "../../src/application/store.ts";
import { armed, commitmentFixture } from "./commitment-fixture.ts";

export function certificateFixture(t: TestContext) {
  const f = commitmentFixture(t); f.node.tip = 210;
  const active = new Map([[210, f.chain.hash]]), chain = { down: false };
  f.adapters.certificateChain = checkpoint => Effect.gen(function* () {
    if (chain.down || checkpoint.tipHash !== f.chain.hash) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "mock checkpoint unavailable" }));
    return checkpoint.height <= f.node.tip && (checkpoint.height === f.node.tip ? f.chain.hash : active.get(checkpoint.height)) === checkpoint.hash;
  });
  const message = Buffer.from("mock verified certificate message, not a cryptographic proof");
  const packet = (oid = "o1", revision = 1, root = armed.root, height = 50, bytes = message) => ({
    ...armed, oid, revision, certificateRoot: root, certificateHeight: height, message_b64: bytes.toString("base64") });
  const prepare = (store: SalesStore) => Effect.gen(function* () {
    const tokens = yield* f.prepare(store);
    yield* store.registry.commitments.observe({ ...armed, expectedRevision: 0, observation: f.facts(50, 50, 210) });
    return tokens;
  });
  return { ...f, active, chainControl: chain, message, packet, prepare };
}
