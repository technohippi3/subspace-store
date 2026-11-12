import assert from "node:assert/strict";
import { Effect } from "effect";
import type { SalesStore } from "../src/application/store.ts";

const old = { entry: "b".repeat(32), root: "c".repeat(64), oids: ["o1", "o5"] };
const next = { entry: "e".repeat(32), root: "f".repeat(64), oids: old.oids };
const armed = { ...next, delegate: "d".repeat(64) + ":0" };

/** Real paid orders and durable store; roots/delegate are public mocks.
 * This exercises permission records, not a Spaces commitment or proof. */
export function entryLifecycle(store: SalesStore) {
  return Effect.gen(function* () {
    const closed = yield* store.registry.entries.close(old);
    assert.equal(closed.phase, "closed"); assert.equal(closed.acknowledged, true);
    for (const oid of old.oids) assert.equal((yield* store.inspectionOrder(oid)).status, "converted");
    assert.equal((yield* store.registry.entries.enter(old)).phase, "closed");
    assert.equal((yield* store.registry.entries.enter(next)).phase, "open");
    const permission = yield* store.registry.entries.arm(armed);
    assert.equal(permission.granted, true); assert.equal(permission.acknowledged, true);
    assert.equal((yield* store.registry.entries.arm(armed)).granted, false);
    const failedClose = yield* Effect.result(store.registry.entries.close(next));
    assert.equal(failedClose._tag, "Failure");
    // A retry for the retired entry cannot unlock the new armed binding.
    yield* store.registry.entries.close(old);
    for (const oid of old.oids) assert.equal((yield* store.inspectionOrder(oid)).status, "issuing");
  });
}
export function entryLifecycleRestart(store: SalesStore) {
  return Effect.gen(function* () {
    const closed = yield* store.registry.entries.find(old), permission = yield* store.registry.entries.arm(armed);
    assert(closed.found); assert.equal(closed.phase, "closed"); assert.equal(closed.acknowledged, true);
    assert.equal(permission.phase, "armed"); assert.equal(permission.granted, false);
    assert.equal(permission.acknowledged, true);
  });
}
