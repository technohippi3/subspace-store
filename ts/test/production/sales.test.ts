import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { fixture, fullHolds, invoice, payment, script, setup, use } from "./application-fixture.ts";

function refuses<A, E>(effect: Effect.Effect<A, E>, reason: RegExp) {
  return Effect.promise(() => assert.rejects(Effect.runPromise(effect), reason));
}
test("K1: persisted hold ration uses full handles and exact rolling boundaries", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store);
    assert.equal((yield* invoice(store)).quote.pay_first, false);
    f.node.now = 899; yield* refuses(invoice(store), /taken for now/);
    f.node.now = 900; assert.equal((yield* invoice(store)).quote.pay_first, false);
    f.node.now = 1800; assert.equal((yield* invoice(store)).quote.pay_first, true);
    f.node.now = 86400; assert.equal((yield* invoice(store)).quote.pay_first, false);
  }));
});
test("K2: mempool extension ends after six blocks and consumes the ration", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* invoice(store);
    f.node.now = 100; f.node.outputs = [payment(1, 1, 0)]; yield* store.observe();
    f.node.now = 1800; f.node.tip = 16; yield* refuses(invoice(store), /taken for now/);
    f.node.now = 1801; f.node.tip = 17; f.node.outputs = []; yield* invoice(store);
    f.node.now = 2701; assert.equal((yield* invoice(store)).quote.pay_first, true);
  }));
});
test("K3: ten active holds leave further invoices pay-first without reservations", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* fullHolds(store);
    const first = yield* invoice(store, 10), second = yield* invoice(store, 10);
    assert.equal(first.quote.pay_first, true); assert.equal(second.quote.pay_first, true);
    assert.equal(first.quote.hold_expires_at, null); assert.equal(second.quote.hold_expires_at, null);
    assert.notEqual(first.quote.address, second.quote.address);
  }));
});
test("K4: qualifying block wins pay-first races, then quote time and sequence", async (t) => {
  for (const mode of ["earlier-block", "earlier-quote", "sequence", "creation-before-quote"]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* setup(store); yield* fullHolds(store);
      if (mode === "creation-before-quote") {
        const older = yield* store.request({ handle: "n10@space", script_pubkey: script });
        const newer = yield* store.request({ handle: "n10@space", script_pubkey: script });
        yield* store.quote(newer.token); yield* store.quote(older.token);
        f.node.outputs = [payment(11), payment(12)]; yield* store.observe();
        assert.equal((yield* store.order(older.token)).status, "converted");
        assert.equal((yield* store.order(newer.token)).status, "refund_due");
        return;
      }
      const first = yield* invoice(store, 10);
      if (mode !== "sequence") f.node.now = 1;
      const second = yield* invoice(store, 10);
      f.node.now = 2;
      f.node.outputs = [payment(12, 1_000, mode === "earlier-block" ? 4 : 3), payment(11)];
      yield* store.observe();
      assert.equal((yield* store.order(first.token)).status, mode === "earlier-block" ? "refund_due" : "converted");
      assert.equal((yield* store.order(second.token)).status, mode === "earlier-block" ? "converted" : "refund_due");
    }));
  }
});
test("pending money does not close admission; confirmed funds can", async (t) => {
  const f = fixture(t, 1_000);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store);
    assert.equal((yield* invoice(store, 1)).quote.pay_first, true);
    f.node.outputs = [{ ...payment(1, 500_000, 0), outpoint: "mock-replaced-output" }];
    assert.equal((yield* invoice(store, 2)).quote.pay_first, true);
    f.node.outputs = [payment(1, 1_000, 1)];
    yield* refuses(invoice(store, 3), /exposure limit/);
    assert.equal((yield* store.order(first.token)).confirmed_sats, 1_000);
  }));
});
test("K6: partial late money becomes refund due without reacquiring a hold", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store);
    f.node.now = 901; f.node.outputs = [payment(1, 1, 1)]; yield* store.observe();
    assert.equal((yield* store.order(first.token)).status, "refund_due");
    assert.equal((yield* invoice(store)).quote.pay_first, false);
  }));
});
test("K7: late full payments use a lower price and refund a price rise", async (t) => {
  for (const price of [500, 2_000]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* setup(store); const first = yield* invoice(store);
      yield* store.listName("n0@space", price);
      f.node.now = 901; f.node.outputs = [payment(1)]; yield* store.observe();
      const value = yield* store.order(first.token);
      assert.equal(value.status, price === 500 ? "converted" : "refund_due");
      if (price === 500) assert.equal(value.price_sats, 500);
    }));
  }
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* fullHolds(store); const late = yield* invoice(store, 10);
    yield* store.listName("n10@space", 2_000);
    f.node.now = 901; f.node.outputs = [payment(11, 1_000, 1)]; yield* store.observe();
    assert.equal((yield* store.order(late.token)).status, "refund_due");
  }));
});
test("K10: the application queue gives cancellation and issuance exactly one winner", async (t) => {
  for (const issuingFirst of [true, false]) {
    const f = fixture(t);
    await use(f, store => Effect.gen(function* () {
      yield* setup(store); const first = yield* invoice(store);
      f.node.outputs = [payment(1)]; yield* store.observe();
      const operations = [store.beginIssuance("o1"), store.cancel(first.token)];
      if (!issuingFirst) operations.reverse();
      const results = yield* Effect.promise(() => Promise.allSettled(operations.map(operation => Effect.runPromise(operation))));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(results.filter(r => r.status === "rejected").length, 1);
      assert.equal((yield* store.order(first.token)).status, issuingFirst ? "issuing" : "cancelled");
    }));
  }
});
test("K18: pay-first partial funds wait for the full price and then batchable depth", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); yield* fullHolds(store); const first = yield* invoice(store, 10);
    f.node.now = 901; f.node.outputs = [payment(11, 1, 1)]; yield* store.observe();
    assert.equal((yield* store.order(first.token)).status, "quoted");
    assert.equal((yield* store.order(first.token)).hold_expires_at, null);
    const topup = { ...payment(11, 999, 1), outpoint: "mock-topup" };
    f.node.now = 902; f.node.tip = 11; f.node.outputs = [payment(11, 1, 2), topup]; yield* store.observe();
    yield* refuses(invoice(store, 10), /taken for now/);
    f.node.now = 903; f.node.tip = 13;
    f.node.outputs = [payment(11, 1, 4), { ...topup, confirmations: 3 }]; yield* store.observe();
    assert.equal((yield* store.order(first.token)).status, "converted");
  }));
});
test("K19: reorg recovery cannot revive a released hold over its newer owner", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store);
    f.node.now = 1; f.node.outputs = [payment(1, 1_000, 1)]; yield* store.observe();
    f.node.now = 900; f.node.tip = 17; f.node.outputs = [];
    const second = yield* invoice(store);
    f.node.now = 901; f.node.tip = 18; f.node.outputs = [payment(1)]; yield* store.observe();
    assert.equal((yield* store.order(first.token)).status, "refund_due");
    assert.equal((yield* store.order(second.token)).status, "quoted");
    yield* refuses(invoice(store), /taken for now/);
  }));
});
test("a late conversion exempts its own grant, while earlier expired grants survive restart", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store);
    f.node.now = 901; f.node.outputs = [payment(1)]; yield* store.observe(); yield* store.cancel(first.token);
    const second = yield* invoice(store); assert.equal(second.quote.pay_first, false);
    yield* store.cancel(second.token);
    assert.equal((yield* invoice(store)).quote.pay_first, true);
  }));
  await use(f, store => Effect.gen(function* () {
    assert.equal((yield* invoice(store)).quote.pay_first, true);
  }));
});
test("invalid chain observations fail atomically and never double count an outpoint", async (t) => {
  const f = fixture(t);
  await use(f, store => Effect.gen(function* () {
    yield* setup(store); const first = yield* invoice(store);
    f.node.outputs = [payment(1)]; yield* store.observe();
    f.node.outputs = [payment(1), payment(1)]; yield* refuses(store.observe(), /duplicate outpoint/);
    f.node.outputs = [payment(1, 2_000)]; yield* refuses(store.observe(), /outpoint contents changed/);
    f.node.outputs = [payment(1)];
    assert.equal((yield* store.order(first.token)).confirmed_sats, 1_000);
    f.node.outputs = [];
    yield* store.request({ handle: "n1@space", script_pubkey: "5120" + "2".padStart(64, "0") });
    f.node.now = -1; yield* refuses(store.observe(), /invalid integer/);
  }));
});
