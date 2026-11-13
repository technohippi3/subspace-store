import type { TestContext } from "node:test";
import { Effect } from "effect";
import { ApplicationError } from "../../src/application/records.ts";
import type { SalesStore } from "../../src/application/store.ts";
import { certificateFixture } from "./certificate-fixture.ts";
import { armed } from "./commitment-fixture.ts";

export function supersessionFixture(t: TestContext) {
  const f = certificateFixture(t), control = { valid: true, down: false, checks: 0 };
  f.adapters.supersessionChain = check => Effect.gen(function* () {
    control.checks++;
    if (control.down) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "mock conflict RPC unavailable" }));
    return check.tipHash === f.chain.hash && control.valid;
  });
  const prepare = (store: SalesStore, delivered = false) => Effect.gen(function* () {
    const tokens = yield* f.prepare(store);
    for (const oid of ["o1", "o2"]) yield* store.registry.certificates.accept(f.packet(oid));
    if (delivered) {
      const cert = yield* store.registry.deliveries.status({ ...armed, oid: "o1" });
      yield* store.registry.deliveries.fulfill({ ...armed, oid: "o1", revision: cert.revision, certificateHash: cert.certificateHash,
        relayRoot: armed.root, relayHeight: 50, proofHash: "e".repeat(64) });
    }
    f.node.tip = 300; f.chain.hash = "c".repeat(64);
    const report = yield* store.registry.commitments.observe({ ...armed, expectedRevision: 1, observation: f.facts(null, null, 300) });
    const input = { ...armed, revision: report.revision, txid: "a".repeat(64), originalRaw: "00",
      conflictTxid: "f".repeat(64), blockHash: "e".repeat(64), height: 290, tipHeight: 300, tipHash: f.chain.hash,
      rootAbsent: true, confirm: armed.entry };
    return { tokens, input };
  });
  return { ...f, control, prepare };
}
