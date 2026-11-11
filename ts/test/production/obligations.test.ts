import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { SalesStore } from "../../src/application/store.ts";
import type { OrderMonitor } from "../../src/application/monitor.ts";
import { DurableStore } from "../../src/storage/store.ts";
import type { Json } from "../../src/storage/codec.ts";
import { Obligations } from "../../model/obligations.ts";
import { invoice, payment, setup, use } from "./application-fixture.ts";
import { sendingFixture, settledRefund } from "./refund-sending-fixture.ts";
import { familyFixture, mine } from "./refund-families-fixture.ts";

test("Z42: cancellation clocks require eligibility, six confirmations and a destination, not a group", async (t) => {
  const f = sendingFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); token = one.token;
    f.node.outputs = [payment(1, 10_000, 5)];
    assert.deepEqual((yield* store.cancel(token)).refund_deadlines, []);
    f.node.now = 10; f.node.outputs[0]!.confirmations = 6;
    assert.deepEqual((yield* store.order(token)).refund_deadlines, []);
    f.node.now = 20; const started = yield* store.setRefundDestination(token, "buyer-refund");
    assert.equal(started.refund_deadlines[0]!.started_at, 20); assert.deepEqual(started.refund_groups, []);
    f.node.now = 30; f.node.outputs[0]!.confirmations = 5;
    assert.equal((yield* store.order(token)).refund_deadlines[0]!.started_at, 20);
    f.node.now = 40; f.node.outputs[0]!.confirmations = 6;
    assert.equal((yield* store.order(token)).refund_deadlines[0]!.started_at, 20);
  }));
  await use(f, store => Effect.gen(function* () {
    const clocks = (yield* store.order(token)).refund_deadlines;
    assert.equal(clocks.length, 1); assert.equal(clocks[0]!.principal_sats, 10_000); assert.equal(clocks[0]!.started_at, 20);
  }));
});
test("Z42: tiny expired-invoice debt starts a deadline despite being too small to build", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store);
    f.node.now = 901; f.node.outputs = [payment(1, 1, 6)];
    const view = yield* store.setRefundDestination(one.token, "buyer-refund");
    assert.equal(view.status, "refund_due"); assert.equal(view.refund_deadlines[0]!.principal_sats, 1);
    f.node.now += 86401;
    assert.equal((yield* store.operatorStatus()).alerts.filter(a => a.kind === "refund_deadline").length, 1);
    assert.equal(f.senderState.builds, 0); assert.equal(f.sent.length, 0);
  }));
});
test("Z43: group credit, separate later payments and a smaller winner match the independent model", async (t) => {
  const f = familyFixture(t), model = new Obligations();
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f));
    model.evaluate(0, true, 10_000, [], []);
    f.node.now = 10; f.node.outputs.push({ ...payment(1, 600, 6), outpoint: "2".repeat(64) + ":0" });
    yield* store.order(one.token); model.evaluate(10, true, 600, [{ group: one.group.id, maximum: 10_000 }], []);
    f.node.now = 20; yield* store.broadcastRefund(one.group.id);
    model.evaluate(20, true, 600, [{ group: one.group.id, maximum: 10_000 }], [{ group: one.group.id, amount: 10_000 }]);
    const bump = yield* store.bumpRefund(one.group.id, 6000); yield* store.broadcastRefund(one.group.id);
    const equal = yield* store.order(one.token); assert.equal(equal.refund_deadlines[1]!.remaining_sats, 600);
    assert.notEqual(bump.txid, one.group.txid);
    f.node.now = 30; yield* store.bumpRefund(one.group.id, 9000, 10_600); yield* store.broadcastRefund(one.group.id);
    model.evaluate(30, true, 0, [{ group: one.group.id, maximum: 10_600 }], [{ group: one.group.id, amount: 10_600 }]);
    f.node.now = 40; mine(f, one.group.txid!); const lower = yield* store.order(one.token);
    model.evaluate(40, true, 600, [], [{ group: one.group.id, amount: 10_600 }]);
    assert.deepEqual(lower.refund_deadlines.map(d => [d.principal_sats, d.remaining_sats, d.started_at, d.broadcast_at]),
      model.debts.map(d => [d.amount, d.left, d.start, d.sent]));
    assert.equal(lower.refundable_sats, 600); assert.equal(lower.refund_deadlines[2]!.started_at, 40);
  }));
});
test("Z44: intent alone is insufficient and late accepted broadcast retains a permanent incident", async (t) => {
  for (const lag of [86400, 86401]) {
    const f = sendingFixture(t); let token = "";
    await use(f, store => Effect.gen(function* () {
      f.node.now = 20;
      const one = yield* Effect.promise(() => settledRefund(store, f)); token = one.token;
      f.senderState.failure = true; yield* store.broadcastRefund(one.group.id);
      assert.equal((yield* store.order(token)).refund_deadlines[0]!.remaining_sats, 10_000);
      f.node.now = 20 + lag; f.senderState.failure = false;
      yield* store.reconcileRefunds();
      const d = (yield* store.order(token)).refund_deadlines[0]!;
      assert.equal(d.remaining_sats, 0); assert.equal(d.broadcast_at, 20 + lag); assert.equal(d.incident, lag > 86400);
    }));
    f.node.now = 100000;
    await use(f, store => Effect.gen(function* () {
      const view = yield* store.order(token); assert.equal(view.refund_deadlines[0]!.incident, lag > 86400);
      const status = yield* store.operatorStatus();
      assert.equal(status.alerts.filter(a => a.kind === "refund_deadline").length, lag > 86400 ? 1 : 0);
    }));
  }
});
test("Z44: a lost reply completes only when the node actually observes the transaction", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f));
    f.senderState.loseReply = true; yield* store.broadcastRefund(one.group.id);
    assert.equal((yield* store.order(one.token)).refund_deadlines[0]!.remaining_sats, 0);
    assert.equal(f.sent.length, 1); assert.equal((yield* store.operatorStatus()).orders[0]!.serviced.length, 1);
  }));
});
test("Z44: accepted broadcast records the reply time rather than the earlier intent", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); f.node.now = 20;
    f.senderState.afterPermission = () => { f.node.now = 86401; };
    yield* store.broadcastRefund(one.group.id);
    const clock = (yield* store.order(one.token)).refund_deadlines[0]!;
    assert.equal(clock.broadcast_at, 86401); assert.equal(clock.incident, true);
  }));
});
test("Z43: a smaller replacement never known broadcast at the original amount keeps the original deadline", async (t) => {
  const f = familyFixture(t);
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f));
    const txid = "c".repeat(64), input = { outpoint: `${txid}:0`, script: "0014" + "b".repeat(40), sats: 9000, owner: "order" as const };
    f.observations.set(one.group.txid!, { txid: one.group.txid!, seen: "absent", confirmations: 0, blockHash: null,
      inputsAvailable: false, conflicts: [{ txid, confirmations: 6, mempool: false }] });
    f.control.failFunding = false;
    f.control.rebuild = { requiredInputs: [input], proofs: [{ earlier: one.group.txid!, input: input.outpoint,
      via: { txid, raw: "cc", inputs: [f.node.outputs[0]!.outpoint] } }] };
    const smaller = yield* store.rebuildRefund(one.group.id, 2000, 8000);
    f.node.now = 40; mine(f, smaller.txid!);
    const view = yield* store.order(one.token);
    assert.equal(view.refund_deadlines.length, 1); assert.equal(view.refund_deadlines[0]!.remaining_sats, 2000);
    assert.equal(view.refund_deadlines[0]!.started_at, 0); assert.equal(view.refundable_sats, 2000);
  }));
});
test("Z45: existing clocks tick through Core and journal outages, survive restart and alert once", async (t) => {
  const f = sendingFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); token = one.token;
    f.node.now = 86401; f.senderState.failRead = true; f.journal.down = true;
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.observe()), /refund lookup failed/));
    const status = yield* store.operatorStatus(); assert.equal(status.acknowledged, false);
    assert.equal(status.alerts.filter(a => a.kind === "refund_deadline").length, 1);
    assert.equal((yield* store.operatorStatus()).alerts.length, status.alerts.length);
    assert.equal(f.sent.length, 0); assert.equal(f.senderState.builds, 1);
  }));
  f.journal.down = false; f.senderState.failRead = false;
  await use(f, store => Effect.gen(function* () {
    const status = yield* store.operatorStatus(); assert.equal(status.acknowledged, true);
    assert.equal(status.alerts.filter(a => a.kind === "refund_deadline").length, 1);
    assert.equal((yield* store.order(token)).refund_deadlines[0]!.started_at, 0);
  }));
});
test("Z47: recording a refund-exposure loss clears reporting without authorizing another refund", async (t) => {
  const f = sendingFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    const one = yield* Effect.promise(() => settledRefund(store, f)); token = one.token;
    f.node.outputs = [];
    assert.deepEqual((yield* store.order(token)).reconciling, ["refunds"]);
    yield* store.recordMerchantLoss("o1", "refunds");
    const view = yield* store.order(token); assert.deepEqual(view.reconciling, []);
    assert.equal(view.refund_exposure_sats, 10_000); assert.equal(view.reserved_refund_sats, 10_000);
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.prepareRefund("o1", "cancellation", "buyer")), /no refundable credit/));
  }));
  await use(f, store => Effect.gen(function* () {
    assert.deepEqual((yield* store.order(token)).reconciling, []);
    assert.equal((yield* store.operatorStatus()).orders[0]!.losses.refunds, 10_000);
  }));
});
test("Z47: losses survive recovery and only a deficit above the recorded amount raises a new alert", async (t) => {
  const f = sendingFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); token = one.token;
    const first = payment(1, 500, 3), second = { ...payment(1, 500, 3), outpoint: "extra-payment" };
    f.node.outputs = [first, second]; yield* store.observe();
    f.node.outputs = [first];
    yield* store.order(token); yield* store.recordMerchantLoss("o1", "issuance");
    yield* Effect.promise(() => assert.rejects(Effect.runPromise(store.beginIssuance("o1")), /not batchable/));
    f.node.outputs = [first, second]; yield* store.order(token);
    f.node.outputs = [first]; yield* store.order(token);
    assert.equal((yield* store.operatorStatus()).alerts.length, 1);
    f.node.outputs = []; yield* store.order(token); yield* store.order(token);
    const status = yield* store.operatorStatus(); assert.equal(status.alerts.length, 2);
    assert.deepEqual(status.alerts.map(a => a.amount), [500, 500]);
    assert.equal(status.orders[0]!.losses.issuance, 500);
    // Recording one reason does not cover a different post-issuance risk.
    f.node.outputs = [first, second]; yield* store.beginIssuance("o1");
    f.node.outputs = []; const view = yield* store.order(token);
    assert.deepEqual(view.reconciling, ["post_issuance_deficit"]); assert.equal(view.status, "issuing");
    assert.equal((yield* store.operatorStatus()).alerts.length, 3);
  }));
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* store.order(token)).status, "issuing");
    assert.equal((yield* store.operatorStatus()).alerts.length, 3);
  }));
});
test("Z46: malformed monitoring keys and cross-record evidence refuse startup without rewriting", async (t) => {
  const f = sendingFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* Effect.promise(() => settledRefund(store, f)); f.node.now = 86401; yield* store.operatorStatus();
  }));
  const read = () => {
    const db = new DatabaseSync(f.config.database, { readOnly: true });
    try { return db.prepare("select * from records order by kind,key").all(); } finally { db.close(); }
  };
  const saved = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const storage = yield* DurableStore.open(f.config); return (yield* storage.records()).find(r => r.kind === "order_monitor")!;
  })));
  for (const corrupt of [
    (m: OrderMonitor) => { m.order = "o999"; },
    (m: OrderMonitor) => { m.deadlines[0]!.dueAt = 999999; },
    (m: OrderMonitor) => { m.deadlines[0]!.incident = false; },
    (m: OrderMonitor) => { m.serviced = [{ group: "unknown", charged: 10000 }]; },
  ]) {
    const value = structuredClone(saved.value) as unknown as OrderMonitor; corrupt(value);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const storage = yield* DurableStore.open(f.config);
      yield* storage.commit([{ ...saved, value: value as unknown as Json }]);
    })));
    const before = read();
    await assert.rejects(Effect.runPromise(Effect.scoped(SalesStore.open(f.config, f.adapters))));
    assert.deepEqual(read(), before);
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const storage = yield* DurableStore.open(f.config); yield* storage.commit([saved]);
    })));
  }
});
