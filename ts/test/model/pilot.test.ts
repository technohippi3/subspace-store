import { test } from "node:test";
import assert from "node:assert/strict";
import { Pilot, type Payment } from "../../model/pilot.ts";
import { excessRefundable, fundRefund, refundClock, refundPlan } from "../../model/refunds.ts";

function shop(limit = 1_000_000): Pilot {
  const store = new Pilot(limit);
  for (let i = 0; i < 30; i++) store.price(`n${i}@space`, 1_000);
  return store;
}
function payment(order: number, sats = 1_000, confirmations = 3): Payment {
  return { id: `output-${order}`, order, sats, confirmations };
}
function refuses(action: () => unknown, message: string): void {
  let caught = false;
  try { action(); } catch (error) {
    caught = true;
    assert(error instanceof Error && error.message.includes(message));
  }
  assert(caught, `expected refusal: ${message}`);
}
function fullHolds(store: Pilot): void {
  for (let i = 0; i < 10; i++) store.quote(`n${i}@space`);
}
const fees = { minimumRate: 1_000, maximumRate: 10_000, fallbackRate: null, buyerFeeCeiling: 200 };

test("K1: rolling ration of two holds, with exact expiry boundaries", () => {
  const store = shop();
  assert.equal(store.quote("n0@space").payFirst, false);
  store.observe(899, 0, []);
  refuses(() => store.quote("n0@space"), "name taken");
  store.observe(900, 0, []);
  assert.equal(store.quote("n0@space").payFirst, false);
  store.observe(1800, 0, []);
  assert.equal(store.quote("n0@space").payFirst, true);
  store.observe(86400, 0, []);
  assert.equal(store.quote("n0@space").payFirst, false);
});

test("K2: mempool extends a hold but does not exempt its ration", () => {
  const store = shop(); const first = store.quote("n0@space");
  store.observe(100, 0, [payment(first.id, 1, 0)]);
  store.observe(1800, 6, [payment(first.id, 1, 0)]);
  refuses(() => store.quote("n0@space"), "name taken");
  store.observe(1801, 7, []); store.quote("n0@space");
  store.observe(2701, 7, []);
  assert.equal(store.quote("n0@space").payFirst, true);
});

test("K3: the eleventh simultaneous hold is a pay-first invoice", () => {
  const store = shop(); fullHolds(store);
  assert.equal(store.quote("n10@space").payFirst, true);
  assert.equal(store.exposure(), 10_000);
  assert.equal(store.quote("n10@space").payFirst, true);
});

test("K4: payment block, quote time and sequence settle pay-first races", () => {
  for (const newerWins of [false, true]) {
    const store = shop(); fullHolds(store);
    const first = store.quote("n10@space"); store.observe(1, 0, []);
    const second = store.quote("n10@space");
    store.observe(2, 10, [payment(second.id, 1_000, newerWins ? 4 : 3), payment(first.id)]);
    assert.equal(store.order(newerWins ? second.id : first.id).state, "converted");
    assert.equal(store.order(newerWins ? first.id : second.id).state, "refund_due");
  }
  const tied = shop(); fullHolds(tied);
  const a = tied.quote("n10@space"), b = tied.quote("n10@space");
  tied.observe(1, 10, [payment(b.id), payment(a.id)]);
  assert.equal(tied.order(a.id).state, "converted");
  assert.equal(tied.order(b.id).state, "refund_due");
  const reordered = shop(); fullHolds(reordered);
  const newer = reordered.quote("n10@space", 12), older = reordered.quote("n10@space", 11);
  reordered.observe(1, 10, [payment(newer.id), payment(older.id)]);
  assert.equal(reordered.order(older.id).state, "converted");
  assert.equal(reordered.order(newer.id).state, "refund_due");
});

test("K5: pending money never closes admission, confirmed money can", () => {
  const store = shop(1_000); const held = store.quote("n0@space");
  assert.equal(store.quote("n1@space").payFirst, true);
  store.observe(1, 0, [{ ...payment(held.id, 500_000, 0), id: "replaced-mempool-output" }]);
  assert.equal(store.quote("n2@space").payFirst, true);
  store.observe(2, 1, [payment(held.id, 1_000, 1)]);
  refuses(() => store.quote("n3@space"), "exposure limit");
  store.observe(3, 6, [payment(held.id, 1_000, 6)]);
  store.cancel(held.id); store.recordRefund(held.id, 1_000);
  assert.equal(store.quote("n3@space").payFirst, false);
});

test("K6: a partial late payment never reacquires an ordinary hold", () => {
  const store = shop(); const order = store.quote("n0@space");
  store.observe(901, 10, [payment(order.id, 1, 1)]);
  assert.equal(store.order(order.id).state, "refund_due");
  assert.equal(store.quote("n0@space").payFirst, false);
});

test("K7: late payment uses the lower price and refuses a price rise", () => {
  for (const price of [500, 2_000]) {
    const store = shop(); const order = store.quote("n0@space"); store.price(order.handle, price);
    store.observe(901, 10, [payment(order.id, 2_000, 3)]);
    assert.equal(store.order(order.id).state, price === 500 ? "converted" : "refund_due");
    if (price === 500) assert.equal(store.order(order.id).price, 500);
  }
  const store = shop(); fullHolds(store);
  const order = store.quote("n10@space"); store.price(order.handle, 2_000);
  store.observe(901, 10, [payment(order.id, 1_000, 1)]);
  assert.equal(store.order(order.id).state, "refund_due");
});

test("K8: ten conversions pause once, existing invoices and recovery retain the count", () => {
  const store = shop(); fullHolds(store); const extra = store.quote("n10@space");
  const paid = Array.from({ length: 10 }, (_, i) => payment(i + 1));
  store.observe(1, 10, paid); assert.equal(store.convertedCount(), 10);
  refuses(() => store.quote("n11@space"), "sales paused");
  store.observe(2, 10, [...paid, payment(extra.id)]); assert.equal(store.convertedCount(), 11);
  store.cancel(1); store.observe(3, 9, []); assert.equal(store.convertedCount(), 11);
  const restored = Pilot.restore(store.snapshot());
  refuses(() => restored.quote("n11@space"), "sales paused");
  restored.pause(false); const afterReview = restored.quote("n11@space");
  restored.observe(4, 10, [payment(afterReview.id)]);
  assert.equal(restored.convertedCount(), 12); restored.quote("n12@space");
});

test("K9: converted holds are exempt and unpaid ration survives restore", () => {
  const store = shop(); const converted = store.quote("n0@space");
  store.observe(1, 10, [payment(converted.id)]); store.cancel(converted.id);
  store.quote("n0@space"); store.observe(901, 10, []);
  assert.equal(store.quote("n0@space").payFirst, false);
  store.observe(1801, 10, []);
  const restored = Pilot.restore(store.snapshot()); restored.pause(false);
  assert.equal(restored.quote("n0@space").payFirst, true);
});

test("K10: cancellation and issuance allow exactly one winner", () => {
  const store = shop(); const order = store.quote("n0@space");
  store.observe(1, 10, [payment(order.id)]);
  const cancelled = Pilot.restore(store.snapshot()); cancelled.cancel(order.id);
  refuses(() => cancelled.beginIssuance(order.id), "not batchable");
  store.beginIssuance(order.id); refuses(() => store.cancel(order.id), "already issuing");
});

test("K11: refund deadline requires settled funds, eligibility and destination", () => {
  const empty = { dueAt: null, broadcastAt: null, incident: false };
  for (const ready of [[false, true, true], [true, false, true], [true, true, false]])
    assert.equal(refundClock(empty, 10, ready[0]!, ready[1]!, ready[2]!).dueAt, null);
  const due = refundClock(empty, 20, true, true, true);
  assert.equal(due.dueAt, 20);
  assert.equal(refundClock(due, 30, false, false, false).dueAt, 20);
  refuses(() => refundClock(due, 30, true, false, true, true), "not currently eligible");
});

test("K12: a missed 24-hour broadcast target remains an incident", () => {
  const due = refundClock({ dueAt: null, broadcastAt: null, incident: false }, 20, true, true, true);
  assert.equal(refundClock(due, 86420, true, true, true, true).incident, false);
  const late = refundClock(due, 86421, true, true, true, true);
  assert.equal(late.incident, true);
  assert.equal(refundClock(late, 86422, true, true, true).incident, true);
});

test("K13: estimated fee charges the buyer only up to the disclosed ceiling", () => {
  assert.deepEqual(refundPlan(10_000, 140, 2_000, false, fees), {
    fee: 280, buyerFee: 200, merchantFee: 80, toBuyer: 9_800, chargedToOrder: 10_000,
  });
});

test("K14: merchant-caused refund preserves principal and requires fee funding", () => {
  const plan = refundPlan(10_000, 140, 2_000, true, fees);
  assert.equal(plan.toBuyer, 10_000); assert.equal(plan.buyerFee, 0); assert.equal(plan.merchantFee, 280);
  refuses(() => fundRefund("order", 10_000, 279, plan, []), "merchant fee budget");
});

test("K15: missing and excessive fee estimates need explicit operator policy", () => {
  refuses(() => refundPlan(10_000, 140, null, false, fees), "no fee estimate");
  refuses(() => refundPlan(10_000, 140, 10_001, false, fees), "operator limit");
  assert.equal(refundPlan(10_000, 141, null, false, { ...fees, fallbackRate: 1_001 }).fee, 142);
});

test("K16: excess minimum includes exactly 546 sats above the fee", () => {
  assert.equal(excessRefundable(845, 300), false); assert.equal(excessRefundable(846, 300), true);
});

test("K17: later refund spends available change rather than other orders' coins", () => {
  const plan = refundPlan(1_000, 140, 1_000, false, { ...fees, buyerFeeCeiling: 300 });
  const coins = [
    { id: "original", sats: 10_000, owner: "order", spent: true },
    { id: "another", sats: 10_000, owner: "other-order", spent: false },
    { id: "change", sats: 1_000, owner: "order", spent: false },
  ];
  assert.deepEqual(fundRefund("order", 1_000, 0, plan, coins), ["change"]);
  refuses(() => fundRefund("order", 1_000, 0, plan, coins.slice(0, 2)), "unspent funding");
  refuses(() => fundRefund("order", 999, 0, plan, coins), "order credit");
});


test("K18: pay-first partial money waits without a hold until the full price confirms", () => {
  const store = shop(); fullHolds(store);
  const order = store.quote("n10@space");
  store.observe(901, 10, [payment(order.id, 1, 1)]);
  assert.equal(store.order(order.id).state, "quoted");
  assert.equal(store.exposure(), 1);
  const topup = { ...payment(order.id, 999, 1), id: "topup-output" };
  store.observe(902, 11, [payment(order.id, 1, 2), topup]);
  refuses(() => store.quote("n10@space"), "name taken");
  store.observe(903, 13, [payment(order.id, 1, 4), { ...topup, confirmations: 3 }]);
  assert.equal(store.order(order.id).state, "converted");
});

test("K19: a released hold cannot revive ahead of a newer owner after a reorg", () => {
  const store = shop(); const old = store.quote("n0@space");
  store.observe(1, 1, [payment(old.id, 1_000, 1)]);
  store.observe(900, 8, []);
  const current = store.quote("n0@space");
  store.observe(901, 9, [payment(old.id)]);
  assert.equal(store.order(old.id).state, "refund_due");
  assert.equal(store.order(current.id).state, "quoted");
  refuses(() => store.quote("n0@space"), "name taken");
});

test("K20: late conversion exempts only the hold that actually converted", () => {
  const store = shop(); const first = store.quote("n0@space");
  store.observe(901, 10, [payment(first.id)]);
  store.cancel(first.id);
  const second = store.quote("n0@space");
  assert.equal(second.payFirst, false);
  store.cancel(second.id);
  assert.equal(store.quote("n0@space").payFirst, true);
  const restored = Pilot.restore(store.snapshot()); restored.pause(false);
  assert.equal(restored.quote("n0@space").payFirst, true);
});

test("generated pilot traces retain unique issuance and monotonic conversion history", () => {
  let seed = 41;
  const random = (bound: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % bound;
  };
  let store = shop(), time = 0, previous = 0;
  for (let step = 0; step < 2000; step++) {
    const state = store.snapshot();
    const selected = state.orders[random(state.orders.length)];
    try {
      switch (random(5)) {
        case 0: store.quote(`n${random(30)}@space`); break;
        case 1: if (selected) store.cancel(selected.id); break;
        case 2: if (selected) store.beginIssuance(selected.id); break;
        case 3: store.pause(false); break;
        case 4:
          time += random(1000);
          store.observe(time, step, state.orders.filter(() => random(3) > 0)
            .map(o => payment(o.id, o.id % 4 ? 1_000 : 1, Math.min(step + 1, random(7)))));
          break;
      }
    } catch (error) {
      assert(error instanceof Error && /taken|paused|limit|issuing|batchable/.test(error.message));
    }
    const snapshot = store.snapshot();
    assert(snapshot.conversions.length >= previous); previous = snapshot.conversions.length;
    assert.equal(new Set(snapshot.conversions).size, snapshot.conversions.length);
    assert.equal(new Set(snapshot.orders.map(o => o.id)).size, snapshot.orders.length);
    const issued = snapshot.orders.filter(o => o.state === "converted" || o.state === "issuing");
    assert.equal(new Set(issued.map(o => o.handle)).size, issued.length);
    const restored = Pilot.restore(snapshot); restored.pause(snapshot.paused);
    assert.deepEqual(restored.snapshot(), snapshot);
    store = restored;
  }
});
