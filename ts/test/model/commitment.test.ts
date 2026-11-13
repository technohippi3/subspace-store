import { test } from "node:test";
import assert from "node:assert/strict";
import { CommitmentModel } from "../../model/commitment.ts";

test("O29: commitment finality and anchor coverage have separate exact boundaries and can be lost", () => {
  const m = new CommitmentModel(); m.observe(0, 200, 51, 51, 200); assert.equal(m.phase(), "mined");
  m.observe(1, 200, 50, 50, 193); assert.equal(m.phase(), "final"); assert.equal(m.covered(), false);
  m.observe(2, 200, 50, 50, 194); assert.equal(m.covered(), true);
  m.observe(3, 200, 50, null, 200); assert.equal(m.phase(), "mined"); assert.equal(m.covered(), false);
  m.observe(4, 200, null, null, 200); assert.equal(m.phase(), "broadcast");
});
test("O30: restoring a newer reorg report cannot admit an older final report", () => {
  const m = new CommitmentModel(); m.observe(0, 200, 50, 50, 200); m.observe(0, 200, 50, 50, 200);
  assert.equal(m.revision, 1); m.observe(1, 200, null, null, 200);
  const r = CommitmentModel.restore(m.snapshot()); assert.equal(r.revision, 2);
  assert.throws(() => r.observe(0, 200, 50, 50, 200), /stale/); assert.equal(r.phase(), "broadcast");
});
