import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { invoice, payment, setup, use } from "./application-fixture.ts";
import { sendingFixture, tipHash } from "./refund-sending-fixture.ts";

test("K21: cancel first, refund the partial payment, then keep late old payments separate from a new checkout", async (t) => {
  const f = sendingFixture(t); let token = "", address = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const old = yield* invoice(store); token = old.token; address = old.quote.address!;
    f.node.outputs = [{ ...payment(1, 900, 6), outpoint: "1".repeat(64) + ":0" }];
    const partial = yield* store.setRefundDestination(token, "buyer"); assert.equal(partial.status, "quoted"); assert.deepEqual(partial.refund_deadlines, []);
    for (const kind of ["excess", "cancellation"] as const)
      yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", kind, "buyer")), /cancel/));
    assert.equal((yield* store.order(token)).refund_groups.length, 0); assert.equal(f.senderState.builds, 0);
    f.journal.down = true; assert.equal((yield* store.cancel(token)).cancellation, "unconfirmed");
    f.journal.down = false; const cancelled = yield* store.cancel(token); assert.equal(cancelled.cancellation, "final");
    assert.equal(cancelled.refund_deadlines[0]!.principal_sats, 900);
    const refund = yield* store.prepareRefund("o1", "cancellation", "buyer"); yield* store.broadcastRefund(refund.id);
    f.observations.set(refund.txid!, { txid: refund.txid!, seen: "mined", confirmations: 6, blockHash: tipHash, inputsAvailable: false, conflicts: [] });
    assert.equal((yield* store.order(token)).refunded_sats, 900);
  }));
  await use(f, store => Effect.gen(function* () {
    const fresh = yield* invoice(store); assert.notEqual(fresh.quote.address, address);
    f.node.outputs.push({ ...payment(1, 1000, 6), outpoint: "2".repeat(64) + ":0" });
    const old = yield* store.order(token); assert.equal(old.status, "cancelled"); assert.equal(old.address, address);
    assert.equal(old.refundable_sats, 1000); assert.equal((yield* store.order(fresh.token)).status, "quoted");
    f.node.outputs.push({ ...payment(2, 1000, 3), outpoint: "3".repeat(64) + ":0" });
    assert.equal((yield* store.order(fresh.token)).status, "converted"); assert.equal((yield* store.order(token)).status, "cancelled");
  }));
});
