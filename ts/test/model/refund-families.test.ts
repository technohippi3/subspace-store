import { test } from "node:test";
import assert from "node:assert/strict";
import { RefundFamilies } from "../../model/refund-families.ts";

function fixture(credit = 10_000) {
  const m = new RefundFamilies(); m.receipts.set("order", credit);
  m.transaction("payment", []); m.transaction("first", ["payment:0"]); m.open("group", "order", "first", 10_000);
  m.transaction("bump", ["payment:0"]); m.transaction("conflict", ["payment:0"]); m.transaction("rebuilt", ["conflict:0"]);
  return m;
}
test("G1: independent families model replaces equal charges with no new capacity", () => {
  const m = fixture(); m.add("group", "bump", 10_000); assert.equal(m.balances("order").reserved, 10_000);
});
test("G2: independent families model refuses an increase larger than available credit", () => {
  const m = fixture(10_300); assert.throws(() => m.add("group", "bump", 10_500), /credit/);
});
test("G3: independent families model reserves only the increase", () => {
  const m = fixture(10_600); m.add("group", "bump", 10_500); assert.deepEqual(m.balances("order"), { reserved: 10_500, refunded: 0, available: 100 });
});
test("G6: independent families model counts a bump and conflict-dependent family once", () => {
  const m = fixture(); m.add("group", "bump", 10_000); m.add("group", "rebuilt", 10_000);
  assert.equal(m.balances("order").reserved, 10_000);
  m.transaction("unrelated", ["elsewhere:0"]); assert.throws(() => m.add("group", "unrelated", 10_000), /exclusive/);
});
test("G7: independent families model closes with the settled member's charge", () => {
  const m = fixture(); m.add("group", "rebuilt", 9000); m.observe("rebuilt", 6);
  assert.deepEqual(m.balances("order"), { reserved: 0, refunded: 9000, available: 1000 });
});
test("G8: independent families model restores the historical maximum after a reorg", () => {
  const m = fixture(); m.add("group", "rebuilt", 9000); m.observe("rebuilt", 6); m.observe("rebuilt", 5);
  assert.deepEqual(m.balances("order"), { reserved: 10_000, refunded: 0, available: 0 });
});
test("G10: independent families model adds distinct obligation maxima", () => {
  const m = fixture(20_000); m.transaction("other", ["elsewhere:0"]); m.open("other", "order", "other", 10_000);
  assert.equal(m.balances("order").reserved, 20_000);
});
test("G11: independent families model retains a larger historical charge", () => {
  const m = fixture(); m.add("group", "bump", 9000); assert.equal(m.balances("order").reserved, 10_000);
  m.transaction("child", ["first:0"]); assert.equal(m.exclusive("first", "child"), false);
});
test("seeded family histories preserve maximum reservations through settlement and replay", () => {
  const m = fixture(20_000); m.prices.set("order", 5000); let seed = 29, maximum = 10_000;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let step = 0; step < 300; step++) {
    const id = `attempt${step}`, charged = 8000 + random() % 5001;
    m.transaction(id, [step < 150 ? "payment:0" : "conflict:0"]); m.add("group", id, charged); maximum = Math.max(maximum, charged);
    assert.equal(m.balances("order").reserved, maximum);
    m.observe(id, 6); assert.equal(m.balances("order").refunded, charged);
    m.observe(id, 5); assert.equal(m.balances("order").reserved, maximum); m.observe(id, 0);
    const restored = new RefundFamilies();
    for (const [key, tx] of JSON.parse(JSON.stringify([...m.transactions])) as [string, { id: string; inputs: string[] }][]) restored.transactions.set(key, tx);
    for (const [key, group] of structuredClone(m.groups)) restored.groups.set(key, group);
    for (const [key, value] of m.confirmations) restored.confirmations.set(key, value);
    restored.receipts.set("order", 20_000); restored.prices.set("order", 5000);
    assert.deepEqual(restored.balances("order"), m.balances("order"));
  }
});
