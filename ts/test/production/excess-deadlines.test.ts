import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { DatabaseSync } from "node:sqlite";
import { Obligations } from "../../model/obligations.ts";
import { ApplicationError } from "../../src/application/records.ts";
import { assessment } from "../../src/application/assessments.ts";
import { SalesStore } from "../../src/application/store.ts";
import { DurableStore } from "../../src/storage/store.ts";
import type { Json } from "../../src/storage/codec.ts";
import { invoice, payment, setup, use } from "./application-fixture.ts";
import { sendingFixture, tipHash } from "./refund-sending-fixture.ts";

function feeFixture(t: TestContext) {
  const f = sendingFixture(t), control = { rate: 2000 as number | null, vbytes: 150, fail: false, mismatch: false, calls: 0,
    after: null as (() => void) | null };
  f.adapters.refunds = { ...f.adapters.refunds!, estimateRate: () => Effect.succeed(control.rate),
    assessExcess: r => Effect.gen(function* () {
      control.calls++;
      assert(r.inputs.every(c => f.node.outputs.some(p => p.outpoint === c.outpoint && p.script === c.script)));
      if (control.fail) return yield* Effect.fail(new ApplicationError({ code: "unavailable", message: "fee assessment failed" }));
      control.after?.();
      return { vbytes: control.vbytes, fee: Math.ceil(control.vbytes * r.rate / 1000), tip: f.node.tip, tipHash: control.mismatch ? "e".repeat(64) : tipHash };
    }) };
  return { ...f, control };
}
test("Z51: excess clocks wait for eligibility, six confirmations and destination, including the exact minimum", async (t) => {
  const f = feeFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store);
    f.node.outputs = [payment(1, 1845, 5)];
    assert.deepEqual((yield* store.setRefundDestination(one.token, "buyer")).refund_deadlines, []);
    f.node.now = 10; f.node.outputs[0]!.confirmations = 6;
    const small = yield* store.order(one.token);
    assert.equal(small.excess_assessment?.status, "below_minimum"); assert.deepEqual(small.refund_deadlines, []);
    f.node.now = 20; f.node.outputs.push({ ...payment(1, 1, 6), outpoint: "top-up" });
    const due = yield* store.order(one.token); assert.equal(due.excess_assessment?.minimum_sats, 846);
    assert.equal(due.excess_assessment?.status, "eligible"); assert.equal(due.refund_deadlines[0]!.started_at, 20);
    assert.equal(due.refund_deadlines[0]!.principal_sats, 846); assert.equal(f.senderState.builds, 0); assert.equal(f.sent.length, 0);
    f.node.now = 30; f.node.outputs.push({ ...payment(1, 100, 6), outpoint: "later-top-up" });
    const later = yield* store.order(one.token); assert.equal(later.refund_deadlines.length, 2);
    assert.equal(later.refund_deadlines[1]!.principal_sats, 100); assert.equal(later.refund_deadlines[1]!.started_at, 30);
  }));
});
test("Z52: rising fees, unknown estimates and a journal outage preserve clocks and alert once across restart", async (t) => {
  const f = feeFixture(t); let token = "";
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); token = one.token;
    f.node.outputs = [payment(1, 2000, 6)]; yield* store.setRefundDestination(token, "buyer");
    f.node.now = 10; f.control.rate = 10000;
    assert.equal((yield* store.order(token)).excess_assessment?.status, "below_minimum");
    f.node.now = 20; f.control.fail = true; f.journal.down = true;
    const unknown = yield* store.order(token); assert.equal(unknown.excess_assessment?.status, "unknown");
    assert.equal(unknown.refund_deadlines[0]!.started_at, 0);
    assert.equal((yield* store.operatorStatus()).acknowledged, false);
    yield* store.order(token);
    assert.equal((yield* store.operatorStatus()).alerts.filter(a => a.kind === "refund_assessment").length, 1);
  }));
  f.journal.down = false; f.node.now = 86401;
  await use(f, store => Effect.gen(function* () {
    const view = yield* store.order(token); assert.equal(view.refund_deadlines[0]!.incident, true);
    assert.equal(view.refund_deadlines[0]!.started_at, 0);
    const status = yield* store.operatorStatus(); assert.equal(status.acknowledged, true);
    assert.equal(status.alerts.filter(a => a.kind === "refund_assessment").length, 1);
    assert.equal(status.alerts.filter(a => a.kind === "refund_deadline").length, 1);
  }));
});
test("Z52: missing/fallback/excessive rates and mismatched assessment tips never become a false small excess", async (t) => {
  const f = feeFixture(t); f.config.refundPolicy = { ...f.config.refundPolicy, fallbackRate: null };
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); f.node.outputs = [payment(1, 2000, 6)];
    f.control.rate = null; assert.equal((yield* store.setRefundDestination(one.token, "buyer")).excess_assessment?.status, "unknown");
    f.control.rate = 100001; assert.equal((yield* store.order(one.token)).excess_assessment?.status, "unknown");
    f.control.rate = 2000; f.control.mismatch = true;
    assert.equal((yield* store.order(one.token)).excess_assessment?.status, "unknown");
    f.control.mismatch = false; f.node.now = 20;
    assert.equal((yield* store.order(one.token)).refund_deadlines[0]!.started_at, 20);
  }));
  const fallback = feeFixture(t); fallback.control.rate = null;
  await use(fallback, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); fallback.node.outputs = [payment(1, 2000, 6)];
    assert.equal((yield* store.setRefundDestination(one.token, "buyer")).excess_assessment?.estimated_fee_sats, 300);
  }));
});
test("Z53: excess broadcasts and a later cancellation service separate amounts against the independent model", async (t) => {
  const f = feeFixture(t), model = new Obligations();
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); f.node.outputs = [{ ...payment(1, 2000, 6), outpoint: "1".repeat(64) + ":0" }];
    yield* store.setRefundDestination(one.token, "buyer"); model.evaluate(0, true, 1000, [], [], 300);
    const group = yield* store.prepareRefund("o1", "excess", "buyer");
    f.node.now = 10; yield* store.broadcastRefund(group.id);
    model.evaluate(10, true, 0, [{ group: group.id, maximum: 1000 }], [{ group: group.id, amount: 1000 }], 300);
    f.node.now = 20; const cancelled = yield* store.cancel(one.token);
    model.evaluate(20, true, 1000, [{ group: group.id, maximum: 1000 }], [{ group: group.id, amount: 1000 }]);
    assert.deepEqual(cancelled.refund_deadlines.map(d => [d.principal_sats, d.remaining_sats, d.started_at, d.broadcast_at]),
      model.debts.map(d => [d.amount, d.left, d.start, d.sent]));
  }));
});
test("Z54: malformed or contradictory persisted assessment values refuse validation", () => {
  const valid = { order: "o1", principal: 846, at: 20, tip: 10, tipHash, status: "eligible", rate: 2000, vbytes: 150, fee: 300 };
  assessment(valid);
  for (const change of [{ principal: 845 }, { fee: 299 }, { rate: null }, { status: "unknown" }, { tipHash: null }, { vbytes: 100001 }])
    assert.throws(() => assessment({ ...valid, ...change }));
});
test("Z54: an invalid acknowledged assessment refuses startup without rewriting the ledger", async (t) => {
  const f = feeFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const one = yield* invoice(store); f.node.outputs = [payment(1, 2000, 6)];
    yield* store.setRefundDestination(one.token, "buyer");
  }));
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const storage = yield* DurableStore.open(f.config);
    const record = (yield* storage.records()).find(r => r.kind === "excess_assessment")!;
    yield* storage.commit([{ ...record, value: { ...(record.value as object), fee: 299 } as Json }]);
  })));
  const db = new DatabaseSync(f.config.database, { readOnly: true });
  try {
    const before = db.prepare("select * from records order by kind,key").all();
    await assert.rejects(Effect.runPromise(Effect.scoped(SalesStore.open(f.config, f.adapters))));
    assert.deepEqual(db.prepare("select * from records order by kind,key").all(), before);
  } finally { db.close(); }
});
test("Z55: unrelated slow fee RPCs neither postpone refund-due admission nor make observed broadcasts late", async (t) => {
  const f = feeFixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store);
    f.node.outputs = [{ ...payment(1, 1000, 6), outpoint: "1".repeat(64) + ":0" }];
    yield* store.cancel(first.token); yield* store.setRefundDestination(first.token, "buyer");
    const group = yield* store.prepareRefund("o1", "cancellation", "buyer");
    const second = yield* invoice(store, 1);
    f.node.outputs.push({ ...payment(2, 2000, 6), outpoint: "2".repeat(64) + ":0" });
    yield* store.setRefundDestination(second.token, "buyer");
    const third = yield* store.request({ handle: "n2@space", script_pubkey: "5120" + "4".padStart(64, "0") });
    yield* store.quote(third.token); yield* store.setRefundDestination(third.token, "buyer");
    f.node.outputs.push({ ...payment(3, 1, 6), outpoint: "3".repeat(64) + ":0" });
    f.observations.set(group.txid!, { txid: group.txid!, seen: "mempool", confirmations: 0, blockHash: null, inputsAvailable: false, conflicts: [] });
    f.node.now = 86400; f.control.after = () => { f.node.now = 86401; };
    const onTime = (yield* store.order(first.token)).refund_deadlines[0]!;
    assert.equal(onTime.broadcast_at, 86400); assert.equal(onTime.incident, false);
    const status = yield* store.operatorStatus();
    assert.equal(status.orders.find(o => o.order === "o3")!.deadlines[0]!.dueAt, 86400);
    assert.equal(status.alerts.filter(a => a.order === "o1" && a.kind === "refund_deadline").length, 0);
  }));
});
