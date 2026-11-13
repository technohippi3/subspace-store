import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { FileControllerJournal } from "../../src/controller/journal.ts";
import { preparationHistory } from "../../src/controller/preparation-history.ts";
import { withPreparation } from "./controller-preparation-fixture.ts";
import { readNative, saveNative, stagedHandle } from "./controller-preparation-native.ts";
import { batches, scripts } from "./controller-rebuild-fixture.ts";
import { using } from "./controller-port-fixture.ts";

async function command(root: string, operator: string, native: string, operation: string, mode = "continue", python = false) {
  const args = [root, operator, native, operation, mode, "b1"];
  const result = await promisify(execFile)(python ? "python3" : process.execPath,
    ["test/production/controller-preparation-" + (python ? "client.py" : "process.ts"), ...args], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  return JSON.parse(result.stdout) as { error: string | null; result?: Record<string, string>; batches: { state: string; root: string | null }[] };
}
const exited = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === 9;

test("TypeScript preparation process exits distinguish completed stages from unanswered effect intents", async (t) => {
  for (const mode of ["after-owner", "after-pending_set-intent", "after-pending_set-confirmed", "after-sync-intent", "after-sync-confirmed",
    "after-park-intent", "after-park-confirmed", "after-unpark-intent", "after-unpark-confirmed", "after-pending_clear-intent",
    "after-pending_clear-confirmed", "after-clear-owner", "after-staged"]) await withPreparation(t, async (k, f, native, _store, operator) => {
    await using(k, c => c.freeze("@space"));
    if (mode.includes("park")) {
      const value = readNative(f.root), keys = scripts(3); value.spaces["@space"]!.handles = [stagedHandle("n0", keys[0]!, true), stagedHandle("n1", keys[1]!), stagedHandle("stray", keys[2]!)]; saveNative(f.root, value);
    }
    await assert.rejects(command(f.root, operator, native.url, "stage", mode), exited);
    const result = await command(f.root, operator, native.url, "stage");
    if (mode.endsWith("-intent")) {
      assert.match(result.error!, /reconciliation/); assert.equal(preparationHistory(k.journal.entries()).owner?.bid, "b1");
      assert.equal(batches(k.database)[0]!.state, "frozen");
    } else { assert.equal(result.error, null, mode); assert.equal(result.batches[0]!.state, "staged"); }
    assert.equal(readNative(f.root).commits, 0); assert.equal(k.calls.broadcasts, 0);
  });
});

test("TypeScript local commit intent and response crashes never create a second native commitment", async (t) => {
  for (const mode of ["after-commit-intent", "after-commit-response", "before-committed-ack", "after-committed"]) await withPreparation(t, async (k, f, native, _store, operator) => {
    await using(k, c => c.freeze("@space")); await using(k, c => c.stage("b1"));
    await assert.rejects(command(f.root, operator, native.url, "commit", mode), exited);
    const result = await command(f.root, operator, native.url, "commit");
    if (mode === "after-committed") assert.equal(result.error, null); else assert.match(result.error!, /reconciliation|binding differs|ambiguous/);
    assert.equal(readNative(f.root).commits, mode === "after-commit-intent" ? 0 : 1); assert.equal(k.calls.broadcasts, 0);
  });
});

test("TypeScript lost local commit replies and restored preintent copies require reconciliation without rollback or another call", async (t) => {
  for (const loss of ["before", "after"] as const) await withPreparation(t, async (k, f, native) => {
    await using(k, c => c.freeze("@space")); await using(k, c => c.stage("b1"));
    const oldDb = join(f.root, "before-local-commit.db"), oldJournal = join(f.root, "before-local-commit.jsonl"); copyFileSync(k.database, oldDb); copyFileSync(k.journal.path, oldJournal);
    native.control[loss === "before" ? "loseBefore" : "loseAfter"] = "/spaces/@space/commit";
    await assert.rejects(using(k, c => c.commitLocal("b1")), /response unavailable/);
    await assert.rejects(using(k, c => c.commitLocal("b1")), /already requested|ambiguous/);
    await assert.rejects(using(k, c => c.stage("b1")), /already requested|ambiguous/);
    if (loss === "after") {
      copyFileSync(oldDb, k.database); copyFileSync(oldJournal, k.journal.path);
      const subject = { ...k, config: { database: k.database, makeJournal: () => new FileControllerJournal(k.directory) } };
      await assert.rejects(using(subject, c => c.commitLocal("b1")), /ahead|ambiguous/);
      await assert.rejects(using(subject, c => c.stage("b1")), /ahead|ambiguous/);
      await assert.rejects(using(subject, c => c.releaseUnsent("b1", ["o2"])), /ahead|ambiguous/);
      assert.equal(batches(k.database)[0]!.state, "staged"); assert.equal(batches(k.database).length, 1);
    }
    assert.equal(readNative(f.root).commits, loss === "before" ? 0 : 1); assert.equal(readNative(f.root).parks, 0);
  });
});

test("Python preparation shares exact HTTP receipts, one-commit intent and global unanswered-operation fences", async (t) => {
  await withPreparation(t, async (_k, f, native, _store, operator) => {
    assert.equal((await command(f.root, operator, native.url, "freeze", "continue", true)).error, null);
    assert.equal((await command(f.root, operator, native.url, "stage", "continue", true)).error, null);
    assert.equal((await command(f.root, operator, native.url, "commit", "continue", true)).error, null);
    assert.equal((await command(f.root, operator, native.url, "commit", "continue", true)).error, null); assert.equal(readNative(f.root).commits, 1);
  });
  for (const mode of ["after-pending_set-intent", "after-sync-intent", "after-pending_clear-intent"]) await withPreparation(t, async (_k, f, native, _store, operator) => {
    await command(f.root, operator, native.url, "freeze", "continue", true);
    await assert.rejects(command(f.root, operator, native.url, "stage", mode, true), exited);
    const result = await command(f.root, operator, native.url, "barriers", "continue", true); assert.equal(result.error, null);
    for (const [name, error] of Object.entries(result.result!)) assert.match(error, /preparation|reconciliation/, name);
    assert.equal(readNative(f.root).commits, 0);
  });
  await withPreparation(t, async (_k, f, native, _store, operator) => {
    await command(f.root, operator, native.url, "freeze", "continue", true); await command(f.root, operator, native.url, "stage", "continue", true);
    await assert.rejects(command(f.root, operator, native.url, "commit", "after-commit-response", true), exited);
    assert.match((await command(f.root, operator, native.url, "commit", "continue", true)).error!, /already requested|ambiguous/); assert.equal(readNative(f.root).commits, 1);
  });
});
