import { test } from "node:test";
import assert from "node:assert/strict";
import { Obligations } from "../../model/obligations.ts";

test("Z51: aggregate excess reaches its fee-plus-546 minimum without requiring a prepared group", () => {
  const m = new Obligations(); m.evaluate(0, true, 845, [], [], 300); assert.equal(m.debts.length, 0);
  m.evaluate(20, true, 846, [], [], 300); assert.equal(m.debts[0]!.start, 20);
  m.evaluate(30, true, 946, [], [], 300); assert.equal(m.debts[1]!.amount, 100);
});
test("Z52: higher or unavailable fees and lost prerequisites never postpone an admitted excess clock", () => {
  const m = new Obligations(); m.evaluate(0, true, 1000, [], [], 300);
  m.evaluate(10, true, 1000, [], [], 1500); m.evaluate(20, true, 1000, [], [], null);
  m.evaluate(86401, false, 0, [], [], null);
  assert.equal(m.debts.length, 1); assert.equal(m.debts[0]!.start, 0); assert.equal(m.debts[0]!.incident, true);
});
test("Z55: completion uses first-known broadcast time even when other work advances the clock", () => {
  const m = new Obligations(); m.evaluate(0, true, 1000, [], []);
  m.evaluate(86401, true, 0, [{ group: "g", maximum: 1000 }], [{ group: "g", amount: 1000, at: 86400 }]);
  assert.equal(m.debts[0]!.sent, 86400); assert.equal(m.debts[0]!.incident, false);
});
