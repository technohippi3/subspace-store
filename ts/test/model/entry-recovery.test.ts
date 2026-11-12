import { test } from "node:test";
import assert from "node:assert/strict";
import { EntryModel } from "../../model/entry.ts";

test("O12: retrying an exact entry after restart preserves one atomic member binding", () => {
  const model = new EntryModel(); model.add("one"); model.add("two");
  model.enter("entry", "root", ["two", "one"]); const saved = model.snapshot();
  const restored = EntryModel.restore(saved); restored.enter("entry", "root", ["one", "two"]);
  assert.equal(restored.snapshot(), saved); assert.equal(restored.state("one"), "issuing");
  assert.throws(() => restored.cancel("one"), /locked/);
});
test("O13: identity reuse, overlapping entries and invalid membership never change another binding", () => {
  const model = new EntryModel(); model.add("one"); model.add("two"); model.add("three");
  model.enter("entry", "root", ["one", "two"]); const saved = model.snapshot();
  for (const [key, root, ids] of [["entry", "other", ["one", "two"]], ["entry", "root", ["one"]],
    ["other", "root", ["one", "three"]], ["new", "root", ["three", "unknown"]]] as const)
    assert.throws(() => model.enter(key, root, [...ids]));
  assert.equal(model.snapshot(), saved); assert.equal(model.state("three"), "converted");
});
