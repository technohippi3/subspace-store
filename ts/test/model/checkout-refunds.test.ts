import { test } from "node:test";
import assert from "node:assert/strict";
import { Pilot } from "../../model/pilot.ts";

test("K21: a partial refund closes its checkout and later money can buy only through a new order", () => {
  const model = new Pilot(100000); model.price("one@space", 1000); const old = model.quote("one@space");
  const payments = [{ id: "partial", order: old.id, sats: 900, confirmations: 6 }]; model.observe(0, 10, payments);
  assert.throws(() => model.recordRefund(old.id, 900), /cancel/);
  model.cancel(old.id); model.recordRefund(old.id, 900);
  const restored = Pilot.restore(model.snapshot()); restored.pause(false); const fresh = restored.quote("one@space");
  payments.push({ id: "late-old", order: old.id, sats: 1000, confirmations: 6 });
  restored.observe(0, 10, payments); assert.equal(restored.order(old.id).state, "cancelled"); assert.equal(restored.order(fresh.id).state, "quoted");
  payments.push({ id: "new", order: fresh.id, sats: 1000, confirmations: 3 }); restored.observe(0, 10, payments);
  assert.equal(restored.order(fresh.id).state, "converted"); assert.equal(restored.order(old.id).state, "cancelled");
});
