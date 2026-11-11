import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import type { SalesStore } from "../../src/application/store.ts";
import { replacement } from "../../src/refunds/families.ts";
import { RefundFamilies } from "../../model/refund-families.ts";
import { invoice, payment, setup, use } from "./application-fixture.ts";
import { familyFixture, mine } from "./refund-families-fixture.ts";
import { paymentId } from "./refund-sending-fixture.ts";

function first(store: SalesStore, f: ReturnType<typeof familyFixture>) {
  return Effect.gen(function* () {
    yield* setup(store); yield* store.listName("n0@space", 3000); const one = yield* invoice(store);
    f.node.outputs = [{ ...payment(1, 13_000, 6), outpoint: paymentId }];
    yield* store.setRefundDestination(one.token, "buyer-refund");
    return { ...one, group: yield* store.prepareRefund("o1", "excess", "buyer") };
  });
}
function conflict(f: ReturnType<typeof familyFixture>, ids: string[]) {
  const conflictId = "c".repeat(64), input = { outpoint: `${conflictId}:0`, script: "0014" + "b".repeat(40), sats: 12_000, owner: "order" as const };
  for (const id of ids) f.observations.set(id, { txid: id, seen: "absent", confirmations: 0, blockHash: null, inputsAvailable: false, chainInputsAvailable: false,
    conflicts: [{ txid: conflictId, confirmations: 6, mempool: false }] });
  f.control.rebuild = { requiredInputs: [input], proofs: ids.map(earlier => ({ earlier, input: input.outpoint,
    via: { txid: conflictId, raw: "cc", inputs: [paymentId] } })) }; f.control.failFunding = false;
}
test("G1: an equal-charge fee bump consumes no additional order credit", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); const bumped = yield* store.bumpRefund(one.group.id, 6000);
    assert.equal(bumped.attempts.length, 2); assert.equal(bumped.charged_sats, 10_000);
    assert.equal((yield* store.order(one.token)).refundable_sats, 0);
  }));
});
test("G2: a 500-sat increase refuses when only 300 sats are available", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); f.node.outputs.push({ ...payment(1, 300, 6), outpoint: "2".repeat(64) + ":0" });
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.bumpRefund(one.group.id, 6000, 10_500)), /exceeds available/));
    assert.equal(f.senderState.builds, 1);
  }));
});
test("G3: a 500-sat increase with 600 available reserves the delta and leaves 100", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); f.node.outputs.push({ ...payment(1, 600, 6), outpoint: "2".repeat(64) + ":0" });
    const bumped = yield* store.bumpRefund(one.group.id, 6000, 10_500);
    assert.equal(bumped.charged_sats, 10_500); assert.equal((yield* store.order(one.token)).refundable_sats, 100);
  }));
});
test("G4: a buyer-funded bump preserves its charge and lowers the output within the disclosed ceiling", async (t) => {
  const f = familyFixture(t); f.config.refundPolicy = { ...f.config.refundPolicy, buyerFeeCeiling: 1000 };
  f.adapters.refunds = { ...f.adapters.refunds!, estimateRate: () => Effect.succeed(3000) };
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); assert.equal(one.group.to_buyer_sats, 9700);
    const bumped = yield* store.bumpRefund(one.group.id, 6000); assert.equal(bumped.to_buyer_sats, 9400);
    assert.equal(bumped.charged_sats, 10_000); assert.equal(bumped.merchant_fee_sats, 0);
  }));
});
test("G5: absorbing a bump preserves the buyer output and records the merchant fee", async (t) => {
  const f = familyFixture(t); f.config.refundPolicy = { ...f.config.refundPolicy, buyerFeeCeiling: 1000 };
  f.adapters.refunds = { ...f.adapters.refunds!, estimateRate: () => Effect.succeed(3000) };
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); const bumped = yield* store.bumpRefund(one.group.id, 6000, undefined, true);
    assert.equal(bumped.to_buyer_sats, 9700); assert.equal(bumped.merchant_fee_sats, 300); assert.equal(bumped.charged_sats, 10_000);
  }));
});
test("G6: first attempt, bump and conflict-dependent rebuild reserve one historical maximum", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f), bumped = yield* store.bumpRefund(one.group.id, 6000);
    conflict(f, bumped.attempts.map(a => a.txid!));
    const rebuilt = yield* store.rebuildRefund(one.group.id, 2000, 9000);
    assert.equal(rebuilt.attempts.length, 3); assert.equal(rebuilt.charged_sats, 10_000);
    assert.equal((yield* store.order(one.token)).reserved_refund_sats, 10_000);
  }));
});
test("G7: the settled replacement closes the group at that member's actual charge", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); conflict(f, [one.group.txid!]);
    const rebuilt = yield* store.rebuildRefund(one.group.id, 2000, 9000); mine(f, rebuilt.txid!);
    const view = yield* store.order(one.token); assert.equal(view.refunded_sats, 9000); assert.equal(view.reserved_refund_sats, 0); assert.equal(view.refundable_sats, 1000);
  }));
});
test("G8: a replacement losing settlement restores the original maximum and exposure", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); conflict(f, [one.group.txid!]);
    const rebuilt = yield* store.rebuildRefund(one.group.id, 2000, 9000); mine(f, rebuilt.txid!); yield* store.order(one.token);
    mine(f, rebuilt.txid!, 5); f.node.outputs[0]!.confirmations = 5;
    const view = yield* store.order(one.token); assert.equal(view.refunded_sats, 0); assert.equal(view.reserved_refund_sats, 10_000); assert(view.reconciling.includes("refunds"));
  }));
});
test("G9: multiple attempts and their maxima survive a real SQLite and journal restart", async (t) => {
  const f = familyFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () { const one = yield* first(store, f); token = one.token; yield* store.bumpRefund(one.group.id, 6000); }));
  await use(f, store => Effect.gen(function* () {
    const view = yield* store.order(token); assert.equal(view.reserved_refund_sats, 10_000); assert.equal(view.refund_groups[0]!.attempts.length, 2);
  }));
});
test("G10: excess and cancellation refund groups add their maxima rather than all attempts", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); yield* store.bumpRefund(one.group.id, 6000); yield* store.cancel(one.token);
    f.control.failBuild = true; yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "cancellation", "buyer")), /signer interrupted/));
    assert.equal((yield* store.order(one.token)).reserved_refund_sats, 13_000);
  }));
});
test("G11: a lower replacement charge frees nothing before settlement", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); const smaller = yield* store.bumpRefund(one.group.id, 6000, 9000);
    assert.equal(smaller.charged_sats, 10_000); assert.equal(smaller.attempts[1]!.charged_sats, 9000);
  }));
});
test("R5: either a prior or bumped member can settle but the group is charged only once", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); yield* store.broadcastRefund(one.group.id);
    const bumped = yield* store.bumpRefund(one.group.id, 6000); yield* store.broadcastRefund(one.group.id);
    assert.equal(f.sent.length, 2); assert.notEqual(f.sent[0]!.txid, f.sent[1]!.txid);
    for (const tx of [one.group.txid!, bumped.txid!]) { mine(f, tx); const view = yield* store.order(one.token); assert.equal(view.refunded_sats, 10_000); assert.equal(view.reserved_refund_sats, 0); }
  }));
});
test("R12: no exclusive funding durably pauses the obligation and never creates an independent payment", async (t) => {
  const f = familyFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); token = one.token; conflict(f, [one.group.txid!]); f.control.failFunding = true;
    for (let i = 0; i < 2; i++) yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.rebuildRefund(one.group.id, 2000)), /exclusively funded/));
    const g = (yield* store.order(token)).refund_groups[0]!;
    assert.equal(g.rebuild_paused, true); assert.equal(g.operator_notices.length, 1); assert.equal(g.attempts.length, 1); assert.equal(f.sent.length, 0);
  }));
  await use(f, store => Effect.gen(function* () { assert.equal((yield* store.order(token)).refund_groups[0]!.rebuild_paused, true); }));
});
test("R7: a settled external input spend keeps the maximum and marks the obligation for rebuild", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); conflict(f, [one.group.txid!]);
    const view = yield* store.order(one.token); assert.equal(view.refund_groups[0]!.status, "needs_rebuild"); assert.equal(view.reserved_refund_sats, 10_000);
  }));
});
test("R8: an unbuilt replacement cannot proceed after its conflict loses settled depth", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); conflict(f, [one.group.txid!]); f.control.failBuild = true;
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.rebuildRefund(one.group.id, 2000, 9000)), /signer interrupted/));
    const pending = (yield* store.order(one.token)).refund_groups[0]!.pending_attempt!;
    f.observations.get(one.group.txid!)!.conflicts[0]!.confirmations = 5; f.control.failBuild = false;
    const before = f.senderState.builds;
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.buildRefundAttempt(pending)), /no longer settled/));
    assert.equal(f.senderState.builds, before); assert.equal((yield* store.order(one.token)).reserved_refund_sats, 10_000);
  }));
});
test("R9: a surviving old input anchors a fresh family against every earlier member", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); const bumped = yield* store.bumpRefund(one.group.id, 6000);
    conflict(f, bumped.attempts.map(a => a.txid!));
    const oldInput = f.control.requests[1]!.replacement!.members[0]!.inputs[0]!;
    f.control.rebuild = { requiredInputs: [oldInput], proofs: bumped.attempts.map(a => ({ earlier: a.txid!, input: oldInput.outpoint, via: null })) };
    const rebuilt = yield* store.rebuildRefund(one.group.id, 2000, 9000);
    const last = f.control.requests.at(-1)!; assert(last.replacement!.proofs.every(p => p.via === null));
    assert.equal(rebuilt.attempts.length, 3); assert.equal(rebuilt.charged_sats, 10_000);
  }));
});
test("R13: an ancestor-dependent replacement stays reserved when that ancestor disappears", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); conflict(f, [one.group.txid!]);
    const rebuilt = yield* store.rebuildRefund(one.group.id, 2000, 9000); yield* store.broadcastRefund(one.group.id);
    f.observations.clear(); f.observations.set(rebuilt.txid!, { txid: rebuilt.txid!, seen: "absent", confirmations: 0, blockHash: null,
      inputsAvailable: false, chainInputsAvailable: false, conflicts: [] });
    assert.equal((yield* store.order(one.token)).reserved_refund_sats, 10_000);
    assert.deepEqual(yield* store.reconcileRefunds(), []);
  }));
});
test("R14: the older refund can settle after ancestor loss without charging the group twice", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); conflict(f, [one.group.txid!]); const rebuilt = yield* store.rebuildRefund(one.group.id, 2000, 9000);
    mine(f, rebuilt.txid!); assert.equal((yield* store.order(one.token)).refunded_sats, 9000);
    mine(f, one.group.txid!); const view = yield* store.order(one.token);
    assert.equal(view.refunded_sats, 10_000); assert.equal(view.reserved_refund_sats, 0); assert.equal(view.refund_groups[0]!.settled_txid, one.group.txid);
    const before = f.sent.length; yield* store.broadcastRefund(one.group.id, rebuilt.txid!); assert.equal(f.sent.length, before);
  }));
});
test("Z36: a child of a prior refund is refused as an exclusivity proof", () => {
  const m = new RefundFamilies(); m.transaction("old", ["payment:0"]); m.transaction("child", ["old:0"]); assert.equal(m.exclusive("old", "child"), false);
  const txid = "a".repeat(64), old = { txid, raw: "aa", vbytes: 100, fee: 200, buyerFee: 200, merchantFee: 0, toBuyer: 9800,
    inputs: [{ outpoint: paymentId, script: "0014" + "1".repeat(40), sats: 10_000, owner: "order" as const }],
    outputs: [{ address: "buyer", script: "0014" + "f".repeat(40), sats: 9800, role: "buyer" as const }] };
  assert.throws(() => replacement({ requiredInputs: [{ outpoint: txid + ":0", script: old.outputs[0]!.script, sats: 9800, owner: "order" }],
    members: [old], proofs: [{ earlier: txid, input: txid + ":0", via: { txid, raw: "aa", inputs: [paymentId] } }], minimumFee: 0 }), /ancestor/);
});
test("Z37: an unacknowledged fee-bump reservation can be resumed or discarded without releasing older attempts", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f); f.journal.down = true;
    const pending = yield* store.bumpRefund(one.group.id, 6000); assert(pending.pending_attempt); assert.equal(f.senderState.builds, 1);
    f.journal.down = false; const built = yield* store.buildRefundAttempt(pending.pending_attempt); assert.equal(built.attempts.length, 2);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.discardUnbuiltAttempt(pending.pending_attempt!)), /only an unbuilt/));
    f.journal.down = true; const other = yield* store.bumpRefund(one.group.id, 8000); assert(other.pending_attempt);
    yield* store.discardUnbuiltAttempt(other.pending_attempt); f.journal.down = false;
    assert.equal((yield* store.order(one.token)).reserved_refund_sats, 10_000);
  }));
});
test("Z38: impossible simultaneous confirmations cannot overwrite the last coherent family observations", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* first(store, f), bumped = yield* store.bumpRefund(one.group.id, 6000); yield* store.observe();
    const db = new DatabaseSync(f.config.database, { readOnly: true }), before = db.prepare("select * from records order by kind,key").all(); db.close();
    mine(f, one.group.txid!); const second = { ...f.observations.get(one.group.txid!)!, txid: bumped.txid! }; f.observations.set(bumped.txid!, second);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.observe()), /multiple members/));
    const after = new DatabaseSync(f.config.database, { readOnly: true }); assert.deepEqual(after.prepare("select * from records order by kind,key").all(), before); after.close();
  }));
});
