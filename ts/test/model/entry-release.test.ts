import { test } from "node:test";
import assert from "node:assert/strict";
import { EntryModel } from "../../model/entry.ts";

test("O20: closed entries release their own locks once and cannot undo a later cancellation", () => {
  const m = new EntryModel(); m.add("one"); m.add("two"); m.enter("old", "root", ["one", "two"]);
  m.close("old", "root", ["two", "one"]); m.cancel("one");
  const restored = EntryModel.restore(m.snapshot()); restored.enter("old", "root", ["one", "two"]);
  restored.close("old", "root", ["one", "two"]); assert.equal(restored.state("one"), "cancelled");
  restored.enter("new", "next-root", ["two"]); restored.close("old", "root", ["one", "two"]);
  assert.equal(restored.state("two"), "issuing");
});
test("O21: closing an absent entry blocks late creation without releasing foreign locks", () => {
  const m = new EntryModel(); m.add("one"); m.enter("active", "root", ["one"]);
  m.close("absent", "other", ["one"]); m.enter("absent", "other", ["one"]);
  assert.equal(m.state("one"), "issuing");
  assert.throws(() => m.enter("absent", "wrong", ["one"]), /identity/);
});
test("O22: closure and one-use broadcast permission are mutually exclusive across restore", () => {
  for (const closeFirst of [true, false]) {
    const m = new EntryModel(); m.add("one"); m.enter("entry", "root", ["one"]);
    if (closeFirst) { m.close("entry", "root", ["one"]); assert.throws(() => m.arm("entry"), /closed/); }
    else { assert.equal(m.arm("entry"), true); assert.equal(m.arm("entry"), false); assert.throws(() => m.close("entry", "root", ["one"]), /armed/); }
    const r = EntryModel.restore(m.snapshot());
    if (closeFirst) assert.throws(() => r.arm("entry"), /closed/);
    else { assert.equal(r.arm("entry"), false); assert.throws(() => r.close("entry", "root", ["one"]), /armed/); }
  }
});
