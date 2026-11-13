import { test } from "node:test";
import assert from "node:assert/strict";
import { Effect } from "effect";
import { preparationHistory } from "../../src/controller/preparation-history.ts";
import { using } from "./controller-port-fixture.ts";
import { batches, scripts } from "./controller-rebuild-fixture.ts";
import { withPreparation as preparedFixture } from "./controller-preparation-fixture.ts";
import { readNative, saveNative, stagedHandle } from "./controller-preparation-native.ts";

test("TypeScript preparation freezes, stages and verifies one exact local commitment without proving or issuing", async (t) => {
  await preparedFixture(t, async (k, f) => {
    const result = await using(k, c => Effect.gen(function* () {
      const frozen = yield* c.freeze("@space"); assert.deepEqual(frozen.members, ["o1", "o2"]); assert.match(frozen.digest, /^[0-9a-f]{64}$/);
      assert.equal((yield* c.stage(frozen.bid)).state, "staged");
      const committed = yield* c.commitLocal(frozen.bid); assert.equal(committed.state, "committed_local"); assert(committed.root);
      assert.equal((yield* c.commitLocal(frozen.bid)).root, committed.root);
      yield* Effect.promise(() => assert.rejects(Effect.runPromise(c.stage(frozen.bid)), /not frozen|not.*staged/));
      yield* Effect.promise(() => assert.rejects(Effect.runPromise(c.issue(frozen.bid)), /checkpoint/));
      return committed;
    }));
    assert.equal(readNative(f.root).commits, 1); assert.equal(readNative(f.root).syncs, 1); assert.equal(k.calls.broadcasts, 0);
    assert.equal(preparationHistory(k.journal.entries()).owner, null); assert.equal(preparationHistory(k.journal.entries()).unresolved, null);
    assert.equal(readNative(f.root).spaces["@space"]!.handles.filter(h => h.commitment_root === result.root).length, 2);
  });
});

test("B6: TypeScript freeze admits one open batch and preserves explicit exact eligible selection", async (t) => {
  await preparedFixture(t, async (k, f) => {
    for (const members of [["o1", "o1"], ["o1", "o999"], []]) await assert.rejects(using(k, c => c.freeze("@space", members)), /invalid|unavailable/);
    assert.equal(batches(k.database).length, 0);
    f.node.outputs[1]!.confirmations = 2;
    await assert.rejects(using(k, c => c.freeze("@space", ["o1", "o2"])), /unavailable/); assert.equal(batches(k.database).length, 0);
    const frozen = await using(k, c => c.freeze("@space", ["o1"])); assert.deepEqual(frozen.members, ["o1"]);
    f.node.outputs[1]!.confirmations = 3;
    await assert.rejects(using(k, c => c.freeze("@space", ["o2"])), /another batch/);
    assert.equal(readNative(f.root).syncs, 0); assert.equal(readNative(f.root).commits, 0);
  });
});

test("TypeScript stage safely reuses preexisting staged rows, parks strays and unparks only frozen members", async (t) => {
  await preparedFixture(t, async (k, f) => {
    await using(k, c => c.freeze("@space")); const native = readNative(f.root), keys = scripts(3);
    native.spaces["@space"]!.handles = [stagedHandle("n0", keys[0]!, true), stagedHandle("n1", keys[1]!), stagedHandle("stray", keys[2]!)]; saveNative(f.root, native);
    assert.equal((await using(k, c => c.stage("b1"))).state, "staged");
    const result = readNative(f.root); assert.equal(result.syncs, 0); assert.equal(result.parks, 2);
    assert.deepEqual(result.spaces["@space"]!.handles.filter(h => !h.parked).map(h => h.name), ["n0", "n1"]);
    assert.equal(preparationHistory(k.journal.entries()).owner, null);
  });
});

test("TypeScript preparation rejects malformed native pages, scripts, names and pipeline absence before mutations", async (t) => {
  for (const fault of ["duplicate", "wrong-script", "numeric-name", "missing-root", "wrong-prior"] as const) {
    await preparedFixture(t, async (k, f, server) => {
      await using(k, c => c.freeze("@space")); const state = readNative(f.root), keys = scripts(2);
      state.spaces["@space"]!.handles = [stagedHandle("n0", keys[0]!), stagedHandle("n1", keys[1]!)];
      if (fault === "wrong-script") state.spaces["@space"]!.handles[0]!.script_pubkey = keys[1]!;
      if (fault === "wrong-prior") state.spaces["@space"]!.chain = "b".repeat(64);
      saveNative(f.root, state);
      server.control.transform = (path, value) => {
        if (fault === "missing-root" && path.endsWith("/pipeline")) { const row = { ...value as object } as Record<string, unknown>; delete row.root; return row; }
        if (path.includes("/handles?") && fault === "duplicate") { const row = value as { handles: unknown[] }; row.handles[1] = row.handles[0]; }
        if (path.includes("/handles/") && fault === "numeric-name") (value as { name: unknown }).name = 123;
        return value;
      };
      await assert.rejects(using(k, c => c.stage("b1")), /invalid|differs|duplicate|prior root/);
      assert.equal(readNative(f.root).syncs, 0); assert.equal(readNative(f.root).parks, 0); assert.equal(readNative(f.root).commits, 0);
      assert.equal(preparationHistory(k.journal.entries()).owner, null);
    });
  }
});

test("TypeScript delayed sync or unpark retains the global fence even after its native effect arrives", async (t) => {
  for (const delayed of ["sync", "unpark"] as const) await preparedFixture(t, async (k, f, server) => {
    await using(k, c => c.freeze("@space"));
    if (delayed === "unpark") {
      const value = readNative(f.root), keys = scripts(2); value.spaces["@space"]!.handles = [stagedHandle("n0", keys[0]!, true), stagedHandle("n1", keys[1]!)]; saveNative(f.root, value);
    }
    server.control.delayed = delayed === "sync" ? "/registry/sync" : "/spaces/@space/park";
    await assert.rejects(using(k, c => c.stage("b1")), /native response unavailable/);
    const held = preparationHistory(k.journal.entries()); assert.equal(held.owner?.bid, "b1"); assert.equal(held.unresolved?.operation, delayed);
    for (const action of ["stage", "commit", "release", "issue", "send"] as const) await assert.rejects(using(k, c =>
      action === "stage" ? c.stage("b1").pipe(Effect.asVoid) : action === "commit" ? c.commitLocal("b1").pipe(Effect.asVoid) :
      action === "release" ? c.releaseUnsent("b1", ["o2"]).pipe(Effect.asVoid) : action === "issue" ? c.issue("b1").pipe(Effect.asVoid) : c.send("b1").pipe(Effect.asVoid)), /preparation|reconciliation/);
    await server.applyQueued();
    await assert.rejects(using(k, c => c.stage("b1")), /preparation|reconciliation/);
    assert.equal(batches(k.database).length, 1); assert.equal(readNative(f.root).commits, 0); assert.equal(k.calls.broadcasts, 0);
  });
});
