import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { preparationHistory } from "../../src/controller/preparation-history.ts";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { ControllerError } from "../../src/controller/errors.ts";
import { withPreparation } from "./controller-preparation-fixture.ts";
import { using } from "./controller-port-fixture.ts";
import { batches } from "./controller-rebuild-fixture.ts";
import { readNative } from "./controller-preparation-native.ts";

async function command(root: string, operator: string, native: string, operation: string, mode: string, python: boolean) {
  const result = await promisify(execFile)(python ? "python3" : process.execPath,
    ["test/production/controller-preparation-" + (python ? "client.py" : "process.ts"), root, operator, native, operation, mode, "b1"], { timeout: 30_000 });
  return JSON.parse(result.stdout) as { error: string | null; batches: { state: string }[] };
}
const exited = (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === 9;

test("completed preparation ownership can abort after payment loses depth without another native mutation", async t => {
  await withPreparation(t, async (k, f, _native, store) => {
    const registry = k.ports.preparation.registry;
    const subject = { ...k, ports: { ...k.ports, preparation: { ...k.ports.preparation, registry: {
      ...registry, converted: () => registry.converted(), inspect: (id: string) => registry.inspect(id), batchable: (id: string) => registry.batchable(id),
      pending: (ids: readonly string[]) => registry.pending(ids).pipe(Effect.tap(() => Effect.gen(function* () {
        if (ids.length) { f.node.outputs[1]!.confirmations = 2; yield* store.observe().pipe(Effect.mapError(() => new ControllerError({ code: "unavailable", message: "recording observation failed" }))); }
      }))),
    } } } };
    await using(subject, c => c.freeze("@space"));
    await assert.rejects(using(subject, c => c.stage("b1")), /batchable/);
    assert.equal(preparationHistory(k.journal.entries()).unresolved, null);
    assert.equal((await using(subject, c => c.abortPreparation("b1"))).state, "rebuilt");
    const state = readNative(f.root); assert.equal(state.syncs + state.parks + state.commits, 0);
    assert.equal(preparationHistory(k.journal.entries()).owner, null);
    assert.equal(batches(k.database).length, 1);
    await using(subject, c => c.abortPreparation("b1"));
    assert.equal((await Effect.runPromise(registry.inspect("o1"))).status, "converted");
  });
});

test("Python and TypeScript abort exits survive process death and older databases without repeating pending clear", async t => {
  for (const python of [false, true]) for (const mode of ["after-abort", "after-pending_clear-confirmed", "after-clear-owner", "after-abort-retired"])
    await withPreparation(t, async (k, f, native, _store, operator) => {
      await command(f.root, operator, native.url, "freeze", "continue", python);
      await assert.rejects(command(f.root, operator, native.url, "stage", "after-pending_set-confirmed", python), exited);
      const old = join(f.root, "before-abort.db"); copyFileSync(k.database, old);
      await assert.rejects(command(f.root, operator, native.url, "abort", mode, python), exited);
      copyFileSync(old, k.database);
      const denied = await command(f.root, operator, native.url, "stage", "continue", python);
      assert.match(denied.error!, /aborted|reconciliation/);
      const result = await command(f.root, operator, native.url, "abort", "continue", python);
      assert.equal(result.error, null, mode); assert.equal(result.batches[0]!.state, "rebuilt");
      const journal = new FileControllerJournal(k.directory), state = preparationHistory(journal.entries());
      assert.equal(state.owner, null); assert.equal(state.aborted.size, 1);
      assert.equal(journal.entries().filter(e => e.kind === "preparation_effect" && e.operation === "pending_clear" && e.phase === "intent").length, 1);
      assert.equal(readNative(f.root).commits + readNative(f.root).syncs + readNative(f.root).parks, 0);
    });
});

test("an unknown staging request refuses abort even with plausible empty native readback", async t => {
  await withPreparation(t, async (k, _f, native) => {
    await using(k, c => c.freeze("@space")); native.control.loseBefore = "/registry/sync";
    await assert.rejects(using(k, c => c.stage("b1")), /unavailable/);
    await assert.rejects(using(k, c => c.abortPreparation("b1")), /completed ownership/);
    assert.equal(preparationHistory(k.journal.entries()).unresolved?.operation, "sync");
  });
});
