import { test } from "node:test";
import assert from "node:assert/strict";
import { SupersessionModel } from "../../model/supersession.ts";

test("O67: safe supersession needs an owner decision, settled conflict and root exclusion", () => {
  for (const facts of [[false, 200, true, true], [true, 5, true, true], [true, 6, false, true], [true, 6, true, false]] as const)
    assert.throws(() => new SupersessionModel().acknowledge(facts[0], facts[1], facts[2], facts[3]));
  const model = new SupersessionModel(); model.acknowledge(true, 6, true, true);
  assert.equal(model.orders[0]!.status, "converted"); assert.equal(model.priceReserve, 1000);
});
test("O68: proof reversal relocks paid members but never undoes cancellation or delivery", () => {
  for (const mode of ["paid", "cancelled", "elsewhere", "fulfilled"]) {
    const model = new SupersessionModel(mode === "fulfilled"); model.acknowledge(true, 6, true, true);
    if (mode === "cancelled") model.cancel(); if (mode === "elsewhere") model.rebatch();
    const restored = SupersessionModel.restore(model.snapshot()); restored.loseCheckpoint();
    assert.equal(restored.proof, "revoked"); assert.equal(restored.orders[0]!.status,
      mode === "cancelled" ? "cancelled" : mode === "fulfilled" ? "fulfilled" : "issuing");
    assert.equal(restored.orders[0]!.incident, mode !== "paid");
    assert.throws(() => restored.acknowledge(true, 100, true, true));
  }
});
test("O75: fresh owner acknowledgment can reaffirm safety after reversal for unambiguous original members", () => {
  const model = new SupersessionModel(); model.acknowledge(true,6,true,true); model.loseCheckpoint();
  assert.throws(() => model.acknowledge(true,6,true,true));
  model.acknowledge(true,6,true,true,true); assert.equal(model.orders[0]!.status, "converted");
  model.cancel(); model.loseCheckpoint(); assert.throws(() => model.acknowledge(true,6,true,true,true));
});
test("O77: proof reversal blocks the same handle even when a later checkout has another order ID", () => {
  for (const armed of [false,true]) {
    const model = new SupersessionModel(); model.acknowledge(true,6,true,true); model.cancel(); model.newCheckout();
    if (armed) model.issueReplacement();
    model.loseCheckpoint(); assert.equal(model.orders[0]!.status,"cancelled"); assert.equal(model.replacementBlocked,true);
    assert.throws(() => model.issueReplacement());
  }
});
