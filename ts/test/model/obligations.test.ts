import { test } from "node:test";
import assert from "node:assert/strict";
import { Deficits, Obligations } from "../../model/obligations.ts";

test("Z42: cancellation debt starts only when eligible and keeps its first deadline", () => {
  const m = new Obligations();
  m.evaluate(1, false, 1000, [], []); assert.deepEqual(m.debts, []);
  m.evaluate(2, true, 0, [], []); assert.deepEqual(m.debts, []);
  m.evaluate(20, true, 1000, [], []);
  m.evaluate(40, false, 0, [], []); m.evaluate(50, true, 1000, [], []);
  assert.deepEqual(m.debts, [{ amount: 1000, left: 1000, start: 20, sent: null, incident: false }]);
});
test("Z43: later money has a separate deadline and a family broadcast counts only once", () => {
  const m = new Obligations(), group = { group: "g1", maximum: 1000 };
  m.evaluate(0, true, 1000, [], []);
  m.evaluate(10, true, 500, [group], []);
  m.evaluate(20, true, 500, [group], [{ group: "g1", amount: 1000 }]);
  m.evaluate(30, true, 500, [group], [{ group: "g1", amount: 1000 }]);
  assert.deepEqual(m.debts.map(d => [d.amount, d.left, d.start, d.sent]), [[1000, 0, 0, 20], [500, 500, 10, null]]);
  // A lower actual winner releases credit that was never broadcast. Old deadline survives.
  const lower = new Obligations(); lower.evaluate(0, true, 1000, [], []);
  lower.evaluate(30, true, 200, [], [{ group: "g1", amount: 800 }]);
  assert.equal(lower.debts[0]!.left, 200); assert.equal(lower.debts[0]!.start, 0);
  // Earlier surplus is consumed, not banked against a future cancellation/top-up.
  const historic = new Obligations(); historic.evaluate(0, false, 0, [], [{ group: "old", amount: 500 }]);
  historic.evaluate(100, true, 1000, [], [{ group: "old", amount: 500 }]);
  assert.equal(historic.debts[0]!.left, 1000);
});
test("Z44: exactly twenty-four hours meets the target and a late broadcast leaves an incident", () => {
  for (const lag of [86400, 86401]) {
    const m = new Obligations(); m.evaluate(20, true, 1000, [], []);
    m.evaluate(20 + lag, true, 0, [{ group: "g", maximum: 1000 }], [{ group: "g", amount: 1000 }]);
    m.evaluate(90000, true, 0, [], [{ group: "g", amount: 1000 }]);
    assert.equal(m.debts[0]!.incident, lag > 86400); assert.equal(m.debts[0]!.left, 0);
  }
});
test("Z47: recorded losses suppress the covered deficit but preserve a larger difference", () => {
  const m = new Deficits();
  m.evaluate(new Map([["refunds", 1000]])); m.loss("refunds", 1000);
  m.evaluate(new Map([["refunds", 1000]])); m.evaluate(new Map([["refunds", 0]]));
  m.evaluate(new Map([["refunds", 3000]])); m.evaluate(new Map([["refunds", 3000]]));
  assert.equal(m.losses.get("refunds"), 1000);
  assert.deepEqual(m.alerts, [{ reason: "refunds", amount: 1000 }, { reason: "refunds", amount: 2000 }]);
});
